/**
 * WebSocket handler for `/ws/chat/:projectId`, the single big piece of
 * Quillra's runtime behaviour. Every chat message the user sends lands
 * here and triggers:
 *
 *   1. auth check (team / Better Auth / client session)
 *   2. project access check via projectMembers
 *   3. repo clone + npm install (non-fatal; errors become prompt context)
 *   4. spend cap pre-check (blocks the run if the user is over cap)
 *   5. attachment handling (decides real-asset vs reference-only)
 *   6. agent run via runProjectAgent + auto-nudge retry on truncation
 *   7. <ask> stream filter for multiple-choice questions
 *   8. post-run: persist assistant text, run threshold notifier,
 *      clear migration flag on clean migration exits
 *   9. emits one aggregated `done` event with total cost + duration
 *
 * Lives in its own module because inlining this into index.ts made
 * the app entrypoint 1200 lines of mostly-unrelated concerns and made
 * every new chat feature a diff on top of the WS handler. Extracting
 * here lets the entrypoint be an entrypoint and keeps this, the real
 * product surface, reviewable on its own.
 *
 * Helpers that are ONLY used by the chat turn (the threshold-crossing
 * notifier) live in this file too, rather than being re-exported from
 * a third place.
 */

import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { nanoid } from "nanoid";
import type { ProjectRole } from "../db/app-schema.js";
import { user } from "../db/auth-schema.js";
import { db } from "../db/index.js";
import { agentRuns, conversations, messages, projectMembers, projects } from "../db/schema.js";
import type { SessionUser } from "../lib/auth.js";
import { runProjectAgent } from "../services/agent.js";
import {
  monthLabelFromYmd,
  sendHardCapAlert,
  sendWarnAlert,
} from "../services/usage-alert-emails.js";
import {
  currentMonthYmd,
  getAlertRecipientEmail,
  getEffectiveLimits,
  getMonthToDateSpend,
  getOwnerEmail,
  markAlertSent,
  shouldBlockRun,
} from "../services/usage-limits.js";
import { ensureRepoCloned } from "../services/workspace.js";

type ChatVariables = {
  user: SessionUser | null;
  clientSession: { projectId: string } | null;
};

/**
 * After a run's usage row is persisted, check whether the user's
 * month-to-date spend has crossed either the warn or the hard threshold
 * for the first time this month. On a fresh crossing, record a dedupe
 * row and email the configured alert recipient (or the org owner).
 *
 * `preRunSpend` is the spend at the start of the current turn, so a
 * threshold counts as "crossed by this turn" when preRunSpend is below
 * it and current spend is at-or-above it. markAlertSent is the backstop
 * for any race with a parallel run.
 */
async function maybeNotifyThresholdCrossing(ctx: {
  userId: string;
  userEmail: string;
  userName: string;
  role: ProjectRole;
  preRunSpend: number;
}): Promise<void> {
  const limits = getEffectiveLimits(ctx.userId, ctx.role);
  const spend = getMonthToDateSpend(ctx.userId);
  const month = currentMonthYmd();
  const monthLabel = monthLabelFromYmd(month);
  const ownerEmail = await getOwnerEmail();
  const to = getAlertRecipientEmail(ownerEmail);
  if (!to) return;

  const scopeDescription = (source: typeof limits.warnSource): string => {
    if (source === "user") return "a per-user override";
    if (source === "role") return `the "${ctx.role}" role default`;
    if (source === "global") return "the organization-wide default";
    return "the built-in default";
  };

  // Warn
  if (limits.warnUsd != null && ctx.preRunSpend < limits.warnUsd && spend >= limits.warnUsd) {
    const target =
      limits.warnSource === "user" ? ctx.userId : limits.warnSource === "role" ? ctx.role : "";
    const fresh = await markAlertSent(limits.warnSource, target, month, "warn");
    if (fresh) {
      await sendWarnAlert({
        to,
        who: {
          email: ctx.userEmail,
          name: ctx.userName,
          scopeDescription: scopeDescription(limits.warnSource),
        },
        spendUsd: spend,
        warnUsd: limits.warnUsd,
        hardUsd: limits.hardUsd,
        monthLabel,
      });
    }
  }
  // Hard
  if (limits.hardUsd != null && ctx.preRunSpend < limits.hardUsd && spend >= limits.hardUsd) {
    const target =
      limits.hardSource === "user" ? ctx.userId : limits.hardSource === "role" ? ctx.role : "";
    const fresh = await markAlertSent(limits.hardSource, target, month, "hard");
    if (fresh) {
      await sendHardCapAlert({
        to,
        who: {
          email: ctx.userEmail,
          name: ctx.userName,
          scopeDescription: scopeDescription(limits.hardSource),
        },
        spendUsd: spend,
        hardUsd: limits.hardUsd,
        monthLabel,
      });
    }
  }
}

/**
 * Factory that the Hono route calls on each new WS connection. Pulls
 * auth off the context and returns the per-connection handlers.
 *
 * Typed loosely because the @hono/node-ws upgrade callback signature
 * is not easily shared across module boundaries without pulling in
 * its generics.
 */
export async function chatWsHandler(c: Context<{ Variables: ChatVariables }>) {
  const projectId = c.req.param("projectId");
  if (!projectId) {
    return {
      onOpen(_evt: unknown, ws: { close: (code: number, reason: string) => void }) {
        ws.close(4400, "Bad path");
      },
    };
  }
  // Use the user populated by the global middleware, this covers BOTH
  // Better Auth sessions (team members / owner) AND the custom client
  // session cookie. Clients are auth'd this way and failed to chat
  // because the old code only checked better-auth.
  const wsUser = c.get("user");
  const wsClientSession = c.get("clientSession");
  if (!wsUser) {
    return {
      onOpen(_evt: unknown, ws: { close: (code: number, reason: string) => void }) {
        ws.close(4401, "Unauthorized");
      },
    };
  }

  return {
    async onMessage(evt: { data: unknown }, ws: { send: (s: string) => void }) {
      try {
        const raw = typeof evt.data === "string" ? evt.data : "";
        const parsed = JSON.parse(raw) as {
          type?: string;
          content?: string;
          conversationId?: string;
          attachments?: { path: string; originalName: string; kind?: "image" | "content" }[];
        };
        if (
          parsed.type !== "message" ||
          typeof parsed.content !== "string" ||
          !parsed.content.trim()
        ) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid message payload" }));
          return;
        }
        const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];

        // Project access check: either (a) a projectMembers row (team
        // members) or (b) a client session pinned to this project.
        // Clients don't get a projectMembers row, their access is
        // represented by the session cookie alone.
        let m = await db
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, wsUser.id)))
          .limit(1)
          .then((rows) => rows[0]);
        if (!m && wsClientSession && wsClientSession.projectId === projectId) {
          // Synthesize a client "member" row so the rest of the handler
          // can run unchanged. Not persisted, just a local value.
          m = {
            id: `client-${wsUser.id}-${projectId}`,
            projectId,
            userId: wsUser.id,
            role: "client" as ProjectRole,
            invitedByUserId: null,
            createdAt: new Date(),
          };
        }
        if (!m) {
          ws.send(JSON.stringify({ type: "error", message: "Not a project member" }));
          return;
        }

        const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
        if (!p) {
          ws.send(JSON.stringify({ type: "error", message: "Project not found" }));
          return;
        }

        let repoPath: string;
        // Captured when `npm install` fails during ensureRepoCloned.
        // Rather than blocking the chat turn on a broken package.json
        // (the old behaviour, which surfaced raw npm ETARGET text as
        // if it were the assistant's reply) we let the agent see the
        // error as prompt context and fix it, file ops don't need
        // node_modules.
        let installFailureContext: string | null = null;
        try {
          // Skip the automatic dependency install when the project is
          // flagged for an Astro migration. The old framework's
          // package.json is about to be wholesale replaced by the
          // agent, so installing its (often ancient, often massive)
          // dep tree is wasted work, and historically has been
          // OOM-killing the container before the agent ever runs.
          // The agent will run `npm install` itself once it's
          // written the new Astro package.json.
          const isMigrating = p.migrationTarget === "astro";
          repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
            skipInstall: isMigrating,
            onInstallFailed: (err: string) => {
              installFailureContext = err;
            },
          });
        } catch (e) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                e instanceof Error
                  ? e.message
                  : "Clone failed, install the Quillra GitHub App on this repository.",
            }),
          );
          return;
        }

        // Get or create conversation
        let convId = parsed.conversationId;
        let agentSessionId: string | null = null;
        if (convId) {
          const [conv] = await db
            .select()
            .from(conversations)
            .where(eq(conversations.id, convId))
            .limit(1);
          agentSessionId = conv?.agentSessionId ?? null;
        } else {
          convId = nanoid();
          await db.insert(conversations).values({
            id: convId,
            projectId,
            createdByUserId: wsUser.id,
            title: parsed.content.slice(0, 100),
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          ws.send(JSON.stringify({ type: "conversation_created", conversationId: convId }));
        }

        await db.insert(messages).values({
          projectId,
          conversationId: convId,
          userId: wsUser.id,
          role: "user",
          content: parsed.content,
          attachments: attachments.length > 0 ? JSON.stringify(attachments) : null,
          createdAt: new Date(),
        });

        // Build the prompt, if attachments are present, prepend a clear
        // note for the agent. The key contract: every attachment lives
        // in `.quillra-temp/` which is locally gitignored. The agent
        // has to explicitly decide whether each file is a real asset
        // for the site (move it into public/, src/assets/, etc.) or
        // just reference material for the conversation (leave it in
        // place, it's invisible to git and won't be pushed).
        let promptText = parsed.content;
        if (attachments.length > 0) {
          const images = attachments.filter((a) => a.kind !== "content");
          const contents = attachments.filter((a) => a.kind === "content");
          const lines: string[] = [];
          lines.push(
            "The user attached files to this message. They are parked inside `.quillra-temp/` in the repo, which is locally gitignored, nothing in that folder is ever committed or pushed to GitHub.",
          );
          lines.push("");
          lines.push("You must decide, per file, which of these two paths to take:");
          lines.push("");
          lines.push(
            "  A) REAL ASSET, the file is supposed to end up on the live site (hero image, product photo, downloadable PDF, translated content, etc.). In that case you must MOVE it out of `.quillra-temp/` into the appropriate asset path for this framework (e.g. `public/`, `src/assets/`, `src/content/`, etc.) AND update the relevant source files to reference the new path. Use Bash `mv` or the Write/Read tools to move the file, then delete the original from `.quillra-temp/` so it's not duplicated.",
          );
          lines.push("");
          lines.push(
            "  B) REFERENCE-ONLY, the file is just context for the conversation (a screenshot of a design mockup, a reference site, a screenshot of the user's current page, a mood board). In that case LEAVE it in `.quillra-temp/` untouched. It stays on disk for the rest of this turn but is never committed. You should still look at it (you can see images directly, and read text files via Read) to understand what the user wants.",
          );
          lines.push("");
          lines.push(
            "When unsure, default to REFERENCE-ONLY, it's reversible, whereas accidentally committing a private screenshot to a public repo is not.",
          );
          lines.push("");
          if (images.length > 0) {
            lines.push(`Attached image${images.length > 1 ? "s" : ""}:`);
            for (const a of images) lines.push(`- ${a.path} (originally: ${a.originalName})`);
            lines.push("");
          }
          if (contents.length > 0) {
            lines.push(`Attached text/content file${contents.length > 1 ? "s" : ""}:`);
            for (const a of contents) lines.push(`- ${a.path} (originally: ${a.originalName})`);
            lines.push(
              "For content files you promote into the repo: do NOT inline their full text into any source file you edit. Keep the file as-is and reference it from code (framework import, fetch from /content/, static include, etc.) so the original stays the single source of truth.",
            );
            lines.push("");
          }
          promptText = `${lines.join("\n")}User message:\n${parsed.content}`;
        }

        // Install failed during repo prep (bad version in package.json,
        // peer-dep conflict, OOM on an oversized tree, etc). Prepend the
        // error as a quiet system note so the agent sees what broke
        // without blocking the turn, and instruct it to fix the cause
        // instead of surfacing the npm stack trace to the user.
        if (installFailureContext) {
          const tailExcerpt = String(installFailureContext).slice(-1200);
          const preface = [
            "SYSTEM NOTE (not visible to the user, do not quote npm / tooling names in your reply):",
            "The automatic `npm install` for this project failed before this turn started. The repo files are still readable and editable, fix the cause (usually a bad version in package.json, a missing dependency, or a deprecated package name) and then call `mcp__quillra-diagnostics__restart_preview` to retry. You have `mcp__quillra-diagnostics__get_preview_status` and `mcp__quillra-diagnostics__tail_preview_logs` for details.",
            "In your final reply, describe the fix in plain language (e.g. \"there was a small setup issue with your site's build config, I fixed it and it's running again\"). Never quote ETARGET, package names, file paths, or `npm` in the reply.",
            "",
            "Install error tail:",
            tailExcerpt,
            "",
            "---",
            "",
          ].join("\n");
          promptText = `${preface}${promptText}`;
        }

        // Look up the user's preferred language so the agent can reply in it
        const [userRow] = await db
          .select({ language: user.language })
          .from(user)
          .where(eq(user.id, wsUser.id))
          .limit(1);
        const userLanguage = userRow?.language ?? null;

        let assistantText = "";
        let agentErrored = false;
        let totalCostUsd = 0;
        const turnStartedAt = Date.now();
        const role = m.role as ProjectRole;

        // Pre-run spend cap check. If the user has already crossed their
        // effective hard cap this month, refuse the run with a friendly
        // message BEFORE the agent starts doing anything, no partial
        // work, no surprise charge, no race with the cap. Owner users
        // always bypass this (see shouldBlockRun).
        const block = await shouldBlockRun(wsUser.id, role);
        if (block.blocked) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "Your monthly usage limit has been reached. Please contact the site owner to continue.",
            }),
          );
          ws.send(
            JSON.stringify({
              type: "done",
              costUsd: 0,
              durationMs: Date.now() - turnStartedAt,
            }),
          );
          return;
        }
        const preRunSpend = block.spend;
        // Server-authoritative migration mode: if the project row has
        // migration_target set, this invocation runs unrestricted and
        // with the Astro skill injected into the system prompt.
        // Re-reading from the row (not the old cached value) means a
        // DELETE of the row or a manual SQL clear flips the next
        // message back to normal behaviour immediately.
        const migrationMode = p.migrationTarget === "astro";

        // Streaming filter for `<ask>` blocks. Agent responses that
        // contain a complete `<ask>{...}</ask>` block are rewritten on
        // the fly: the block is stripped from the user-visible text
        // stream and replaced with a structured `ask` WS event that
        // the frontend renders as a multiple-choice card. Partial
        // blocks are held back until the closing tag arrives (or the
        // run ends, in which case the text flushes as-is).
        const ASK_OPEN = "<ask>";
        const ASK_BLOCK_RE = /<ask>([\s\S]*?)<\/ask>/;
        let askPending = "";
        type AskFilterEvent =
          | { kind: "text"; text: string }
          | { kind: "ask"; question: string; options: string[] };
        const askFilter = (chunk: string): AskFilterEvent[] => {
          askPending += chunk;
          const out: AskFilterEvent[] = [];
          while (true) {
            const match = askPending.match(ASK_BLOCK_RE);
            if (!match || match.index === undefined) break;
            const before = askPending.slice(0, match.index);
            if (before) out.push({ kind: "text", text: before });
            const body = match[1].trim();
            try {
              const parsedBlock = JSON.parse(body) as {
                question?: unknown;
                options?: unknown;
              };
              if (typeof parsedBlock.question === "string" && Array.isArray(parsedBlock.options)) {
                out.push({
                  kind: "ask",
                  question: parsedBlock.question,
                  options: parsedBlock.options.filter(
                    (o: unknown): o is string => typeof o === "string",
                  ),
                });
              }
            } catch {
              /* malformed JSON, drop the block silently rather than
                 bleeding raw marker text into the chat */
            }
            askPending = askPending.slice(match.index + match[0].length);
          }
          let safeEnd = askPending.length;
          for (let i = askPending.length - 1; i >= 0; i--) {
            if (askPending[i] !== "<") continue;
            const tail = askPending.slice(i);
            if (ASK_OPEN.startsWith(tail) || tail.startsWith(ASK_OPEN)) {
              safeEnd = i;
              break;
            }
          }
          const flush = askPending.slice(0, safeEnd);
          askPending = askPending.slice(safeEnd);
          if (flush) out.push({ kind: "text", text: flush });
          return out;
        };
        const askFlushTail = () => {
          const tail = askPending;
          askPending = "";
          return tail;
        };

        // Run the agent once and forward events to the client. The SDK's
        // `done` event is SWALLOWED here so we can emit exactly one `done`
        // at the very end of this handler (after any auto-retry), carrying
        // aggregated cost + wall-clock duration for the cost checkpoint.
        const runAgentOnce = async (prompt: string) => {
          let runText = "";
          let runToolCount = 0;
          let runErrored = false;
          let runEmittedAsk = false;
          for await (const ev of runProjectAgent({
            cwd: repoPath,
            prompt,
            role,
            projectId,
            previewDevCommandOverride: p.previewDevCommand ?? null,
            language: userLanguage,
            agentSessionId,
            migrationMode,
            onSessionId: (sid) => {
              agentSessionId = sid;
              void db
                .update(conversations)
                .set({ agentSessionId: sid })
                .where(eq(conversations.id, convId!))
                .catch(() => {});
            },
            onResult: (usage) => {
              // Persist the usage row first, then, once it's in, run
              // the threshold-crossing check so it sees up-to-date MTD
              // spend. Both run as fire-and-forget from the agent's
              // perspective; the chat stream isn't blocked on email.
              void (async () => {
                try {
                  await db.insert(agentRuns).values({
                    id: nanoid(),
                    projectId,
                    conversationId: convId,
                    userId: wsUser.id,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheCreationTokens: usage.cacheCreationTokens,
                    // Drizzle's sqlite driver wants strings for
                    // REAL/TEXT, so we store cost as a text-encoded
                    // number; queries cast with CAST(cost_usd AS REAL)
                    // when aggregating.
                    costUsd: String(usage.totalCostUsd),
                    numTurns: usage.numTurns,
                    modelUsageJson: JSON.stringify(usage.modelUsage),
                    createdAt: new Date(),
                  });
                } catch (e) {
                  console.warn("[usage] failed to persist agent_runs row:", e);
                  return;
                }
                try {
                  await maybeNotifyThresholdCrossing({
                    userId: wsUser.id,
                    userEmail: wsUser.email,
                    userName: wsUser.name,
                    role,
                    preRunSpend,
                  });
                } catch (e) {
                  console.warn("[usage-alerts] notify check failed:", e);
                }
              })();
            },
          })) {
            // Swallow the mapper's `done`, we aggregate cost here and
            // emit our own done at the end with totals.
            if (ev.type === "done") {
              if (typeof ev.costUsd === "number") totalCostUsd += ev.costUsd;
              continue;
            }
            // Intercept stream text so we can strip `<ask>` blocks and
            // replace them with structured `ask` events. Other event
            // types pass through unchanged.
            if (ev.type === "stream" && typeof ev.text === "string") {
              for (const piece of askFilter(ev.text)) {
                if (piece.kind === "text") {
                  ws.send(JSON.stringify({ type: "stream", text: piece.text }));
                  runText += piece.text;
                } else {
                  ws.send(
                    JSON.stringify({
                      type: "ask",
                      id: nanoid(),
                      question: piece.question,
                      options: piece.options,
                    }),
                  );
                  runEmittedAsk = true;
                }
              }
              continue;
            }
            ws.send(JSON.stringify(ev));
            if (ev.type === "tool" || ev.type === "tool_progress") {
              runToolCount++;
            }
            if (ev.type === "error") {
              runErrored = true;
              agentErrored = true;
            }
          }
          // Flush any text the filter was holding back (e.g. an
          // unfinished `<asx` that never closed). Treat it as regular
          // stream text, better to show garbled text than to lose it.
          const tail = askFlushTail();
          if (tail) {
            ws.send(JSON.stringify({ type: "stream", text: tail }));
            runText += tail;
          }
          return { runText, runToolCount, runErrored, runEmittedAsk };
        };

        // A turn is "suspiciously short" when the agent used tools but
        // ended up producing almost no summary text, the classic
        // "tools ran, then Claude went quiet" failure mode that forced
        // the user to type "you finished?" to continue. Short text is
        // INTENTIONAL when the agent asked a question, so never retry
        // in that case.
        const suspicious = (r: {
          runText: string;
          runToolCount: number;
          runErrored: boolean;
          runEmittedAsk: boolean;
        }) =>
          !r.runErrored && !r.runEmittedAsk && r.runText.trim().length < 20 && r.runToolCount > 0;

        const first = await runAgentOnce(promptText);
        assistantText += first.runText;
        let pausedForQuestion = first.runEmittedAsk;

        // Skip the auto-nudge path during a migration run, migration
        // owns the whole conversation and must not get a surprise
        // "please continue" injected mid-flight.
        let continueSuggested = false;
        if (!migrationMode && suspicious(first)) {
          const second = await runAgentOnce("Please continue.");
          assistantText += second.runText;
          if (second.runEmittedAsk) pausedForQuestion = true;
          if (suspicious(second)) continueSuggested = true;
        }

        if (continueSuggested) {
          ws.send(JSON.stringify({ type: "continue_suggested" }));
        }

        // Single aggregated done event, carries cost for this whole
        // turn (including any auto-retry) plus wall-clock duration.
        // `pausedForQuestion` tells the client this turn ended on an
        // <ask> block: the frontend uses it to suppress the "Done"
        // checkpoint card, since the task isn't actually finished, the
        // agent is waiting for the user's answer.
        ws.send(
          JSON.stringify({
            type: "done",
            costUsd: totalCostUsd,
            durationMs: Date.now() - turnStartedAt,
            pausedForQuestion,
          }),
        );

        if (assistantText) {
          await db.insert(messages).values({
            projectId,
            conversationId: convId,
            userId: null,
            role: "assistant",
            content: assistantText,
            createdAt: new Date(),
          });
          // Update conversation title from first assistant response if it was auto-generated
          const [conv] = await db
            .select()
            .from(conversations)
            .where(eq(conversations.id, convId))
            .limit(1);
          if (conv && !conv.title?.includes(" ")) {
            await db
              .update(conversations)
              .set({ title: parsed.content.slice(0, 100), updatedAt: new Date() })
              .where(eq(conversations.id, convId));
          } else {
            await db
              .update(conversations)
              .set({ updatedAt: new Date() })
              .where(eq(conversations.id, convId));
          }
        }

        // If this was a migration run that finished cleanly, clear
        // the flag so the Editor unlocks (preview back, composer
        // enabled). On error we leave it set, the user reloads,
        // sees the "still migrating" state, and can manually clear
        // (future work) or retry.
        if (migrationMode && !agentErrored) {
          await db
            .update(projects)
            .set({ migrationTarget: null, updatedAt: new Date() })
            .where(eq(projects.id, projectId))
            .catch(() => {
              /* non-fatal */
            });
          ws.send(JSON.stringify({ type: "migration_complete" }));
        }

        ws.send(JSON.stringify({ type: "refresh_preview" }));
      } catch (e) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    },
  };
}
