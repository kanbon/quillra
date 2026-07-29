/**
 * WebSocket handler for `/ws/chat/:projectId`, the single big piece of
 * Quillra's runtime behaviour. Every chat message the user sends lands
 * here and triggers:
 *
 *   1. auth check (team / Better Auth / client session)
 *   2. project access check via projectMembers
 *   3. credential-free repo clone + E2B dependency install
 *      (non-fatal; errors become prompt context)
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

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import type { ProjectRole } from "../db/app-schema.js";
import { user } from "../db/auth-schema.js";
import { db } from "../db/index.js";
import {
  agentRuns,
  chatEvents,
  conversations,
  messages,
  projectMembers,
  projects,
} from "../db/schema.js";
import { type Session, type SessionUser, auth } from "../lib/auth.js";
import { CLIENT_SESSION_COOKIE, TEAM_SESSION_COOKIE } from "../lib/session-cookies.js";
import { getClientSessionFromCookie } from "../routes/clients.js";
import { clientSessionCanAccessProject } from "../routes/projects/shared.js";
import { getTeamSessionFromCookie } from "../routes/team-login.js";
import { runProjectAgent } from "../services/agent.js";
import { claimMigrationRun } from "../services/migration-run-lock.js";
import { projectWriterAuthorizationEpoch } from "../services/project-workspace-lifecycle.js";
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
import { ensureRepoCloned, projectRepoPath, runInProjectLock } from "../services/workspace.js";

type ChatVariables = {
  user: SessionUser | null;
  session: Session | null;
  clientSession: { projectId: string } | null;
};

type DurableChatEventKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool"
  | "ask"
  | "continue_prompt"
  | "checkpoint"
  | "done"
  | "error";

/**
 * Hono's WebSocket adapter can invoke async message handlers concurrently.
 * Serialise the complete turn for one conversation so a second send cannot
 * persist ahead of the first assistant response or resume a stale agent
 * session. Different conversations remain independent.
 */
const conversationTurnQueues = new Map<string, Promise<void>>();
const usageAdmissionQueues = new Map<string, Promise<void>>();

async function acquireSerialQueue(
  queue: Map<string, Promise<void>>,
  key: string,
): Promise<() => void> {
  const previous = queue.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  queue.set(key, tail);
  await previous.catch(() => {});

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    void tail.finally(() => {
      if (queue.get(key) === tail) queue.delete(key);
    });
  };
}

function acquireConversationTurn(key: string): Promise<() => void> {
  return acquireSerialQueue(conversationTurnQueues, key);
}

function acquireUsageAdmission(userId: string): Promise<() => void> {
  return acquireSerialQueue(usageAdmissionQueues, userId);
}

/**
 * Fingerprint only publishable worktree state. Git's ignored files (including
 * `.quillra-temp` attachments and dependency directories) stay out, while the
 * tracked diff plus untracked file metadata catches actual site changes.
 */
async function projectWorktreeFingerprint(repoPath: string): Promise<string> {
  const { simpleGitForProject } = await import("../services/workspace.js");
  const git = simpleGitForProject(repoPath);
  const [headTree, trackedDiff, untrackedRaw] = await Promise.all([
    git.revparse(["HEAD^{tree}"]),
    git.diff(["HEAD", "--binary", "--no-ext-diff"]),
    git.raw(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const digest = createHash("sha256").update(headTree).update("\0").update(trackedDiff);
  const root = path.resolve(repoPath);
  const rootPrefix = `${root}${path.sep}`;
  const untrackedPaths = untrackedRaw.split("\0").filter(Boolean).sort();
  for (const relativePath of untrackedPaths) {
    const absolutePath = path.resolve(root, relativePath);
    if (!absolutePath.startsWith(rootPrefix)) continue;
    const stat = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    digest.update(
      `\0${relativePath}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0${stat.isSymbolicLink()}`,
    );
    if (stat.isSymbolicLink()) {
      digest.update("\0link\0").update(await readlink(absolutePath));
    } else if (stat.isFile()) {
      digest.update("\0file\0");
      for await (const chunk of createReadStream(absolutePath)) digest.update(chunk);
    }
  }
  return digest.digest("hex");
}

async function existingProjectWorktreeFingerprint(repoPath: string): Promise<string | null> {
  try {
    const gitDirectory = await lstat(path.join(repoPath, ".git"));
    if (!gitDirectory.isDirectory() && !gitDirectory.isFile()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return projectWorktreeFingerprint(repoPath);
}

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
  const wsBetterAuthSession = c.get("session");
  const wsClientSession = c.get("clientSession");
  if (!wsUser) {
    return {
      onOpen(_evt: unknown, ws: { close: (code: number, reason: string) => void }) {
        ws.close(4401, "Unauthorized");
      },
    };
  }
  if (!clientSessionCanAccessProject(wsClientSession, projectId)) {
    return {
      onOpen(_evt: unknown, ws: { close: (code: number, reason: string) => void }) {
        ws.close(4403, "Forbidden");
      },
    };
  }

  // Capture which credential authenticated this upgrade. Every message
  // resolves that credential again, so logout, expiry, or explicit session
  // deletion also revokes already-open sockets.
  const clientToken = getCookie(c, CLIENT_SESSION_COOKIE);
  const teamToken = getCookie(c, TEAM_SESSION_COOKIE);
  const sessionIsStillActive = async (): Promise<boolean> => {
    if (wsBetterAuthSession) {
      const current = await auth.api.getSession({ headers: c.req.raw.headers });
      return current?.user.id === wsUser.id && current.session.id === wsBetterAuthSession.id;
    }
    if (wsClientSession) {
      const current = await getClientSessionFromCookie(clientToken);
      return current?.user.id === wsUser.id && current.projectId === projectId;
    }
    const current = await getTeamSessionFromCookie(teamToken);
    return current?.user.id === wsUser.id;
  };

  return {
    async onMessage(
      evt: { data: unknown },
      ws: { send: (s: string) => void; close?: (code: number, reason: string) => void },
    ) {
      let releaseMigrationRun: (() => void) | null = null;
      let releaseConversationTurn: (() => void) | null = null;
      let releaseUsageAdmission: (() => void) | null = null;
      let deliveryAvailable = true;
      const sendFrame = (frame: Record<string, unknown>): boolean => {
        if (!deliveryAvailable) return false;
        try {
          ws.send(JSON.stringify(frame));
          return true;
        } catch {
          // The agent turn owns its durable result, not the initiating socket.
          // A tab close or network handoff must not stop repository work or
          // leave the transcript half-written.
          deliveryAvailable = false;
          return false;
        }
      };
      let flushPendingTranscript: (() => Promise<void>) | null = null;
      let awaitSessionPersistence: (() => Promise<void>) | null = null;
      let awaitUsagePersistence: (() => Promise<void>) | null = null;
      let durableTurnId: string | null = null;
      let persistUnexpectedError: ((message: string) => Promise<string | null>) | null = null;
      let persistTerminalFailure:
        | (() => Promise<{ eventId: string; durationMs: number; costUsd: number } | null>)
        | null = null;
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
          sendFrame({ type: "error", message: "Invalid message payload" });
          return;
        }
        const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];

        if (!(await sessionIsStillActive())) {
          sendFrame({ type: "error", message: "Session expired. Please sign in again." });
          ws.close?.(4401, "Session expired");
          return;
        }

        // Re-check the persisted membership for every message, not only when
        // the socket opens. Removing a member must revoke an already-open
        // WebSocket before it can start another agent run.
        // Capture before the membership read. A concurrent role change or
        // removal increments this epoch and makes later writer registration
        // fail even if this request still holds the stale row.
        let authorizationEpoch = projectWriterAuthorizationEpoch(projectId, wsUser.id);
        let m = await db
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, wsUser.id)))
          .limit(1)
          .then((rows) => rows[0]);
        if (!m) {
          sendFrame({ type: "error", message: "Not a project member" });
          return;
        }

        let p = await db
          .select()
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1)
          .then((rows) => rows[0]);
        if (!p) {
          sendFrame({ type: "error", message: "Project not found" });
          return;
        }

        if (p.migrationTarget === "astro") {
          if (m.role !== "admin") {
            sendFrame({
              type: "error",
              message: "A project admin must run the migration before editing can continue.",
            });
            return;
          }
          releaseMigrationRun = claimMigrationRun(projectId);
          if (!releaseMigrationRun) {
            sendFrame({ type: "error", message: "This migration is already running." });
            return;
          }
        }

        // Scope a supplied conversation to this project and, for clients, to
        // its creator. An opaque id from another project/client must never
        // resume that agent session or receive new messages.
        let convId = parsed.conversationId;
        let agentSessionId: string | null = null;
        if (convId) {
          releaseConversationTurn = await acquireConversationTurn(`${projectId}:${convId}`);
          const [conv] = await db
            .select()
            .from(conversations)
            .where(and(eq(conversations.id, convId), eq(conversations.projectId, projectId)))
            .limit(1);
          if (!conv || (m.role === "client" && conv.createdByUserId !== wsUser.id)) {
            sendFrame({ type: "error", message: "Conversation not found" });
            return;
          }
          agentSessionId = conv.agentSessionId ?? null;
        }

        let repoPath: string;
        const preparedBinding = {
          githubRepoFullName: p.githubRepoFullName,
          defaultBranch: p.defaultBranch,
          generation: p.githubBindingGeneration,
        };
        let repositorySyncChanged = false;
        let preSyncFingerprint: string | null = null;
        let syncFingerprintReliable = true;
        try {
          preSyncFingerprint = await existingProjectWorktreeFingerprint(projectRepoPath(p.id));
        } catch (error) {
          syncFingerprintReliable = false;
          console.warn("[chat] could not fingerprint worktree before repository sync:", error);
        }
        try {
          // Repository preparation is file-only. Installing on every chat
          // turn used to stop a healthy preview and repeat package work before
          // the agent had even decided whether a command was necessary.
          // Commands that need dependencies install them in the isolated E2B
          // workspace; the preview owns its separate dependency cache.
          repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
            expectedBindingGeneration: p.githubBindingGeneration,
          });
        } catch (e) {
          sendFrame({
            type: "error",
            message:
              e instanceof Error
                ? e.message
                : "Clone failed, install the Quillra GitHub App on this repository.",
          });
          return;
        }
        try {
          const postSyncFingerprint = await projectWorktreeFingerprint(repoPath);
          repositorySyncChanged =
            !syncFingerprintReliable || preSyncFingerprint !== postSyncFingerprint;
        } catch (error) {
          repositorySyncChanged = true;
          console.warn("[chat] could not fingerprint worktree after repository sync:", error);
        }

        // Create a conversation only after repository preparation succeeds.
        let conversationCreated = false;
        if (!convId) {
          convId = nanoid();
          releaseConversationTurn = await acquireConversationTurn(`${projectId}:${convId}`);
          conversationCreated = true;
        }
        releaseUsageAdmission = await acquireUsageAdmission(wsUser.id);

        // A queued turn may wait behind a long agent run or repository sync.
        // Revalidate the exact credential, membership, role, project binding,
        // migration state, and conversation ownership immediately before the
        // atomic acceptance boundary.
        if (!(await sessionIsStillActive())) {
          sendFrame({ type: "error", message: "Session expired. Please sign in again." });
          ws.close?.(4401, "Session expired");
          return;
        }
        authorizationEpoch = projectWriterAuthorizationEpoch(projectId, wsUser.id);
        const refreshedMember = await db
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, wsUser.id)))
          .limit(1)
          .then((rows) => rows[0]);
        if (!refreshedMember) {
          sendFrame({ type: "error", message: "Not a project member" });
          return;
        }
        const refreshedProject = await db
          .select()
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1)
          .then((rows) => rows[0]);
        if (!refreshedProject) {
          sendFrame({ type: "error", message: "Project not found" });
          return;
        }
        if (
          refreshedProject.githubRepoFullName !== preparedBinding.githubRepoFullName ||
          refreshedProject.defaultBranch !== preparedBinding.defaultBranch ||
          refreshedProject.githubBindingGeneration !== preparedBinding.generation
        ) {
          sendFrame({
            type: "error",
            message: "The project repository changed while this request was waiting. Please retry.",
          });
          return;
        }
        if (!conversationCreated) {
          const refreshedConversation = await db
            .select()
            .from(conversations)
            .where(and(eq(conversations.id, convId), eq(conversations.projectId, projectId)))
            .limit(1)
            .then((rows) => rows[0]);
          if (
            !refreshedConversation ||
            (refreshedMember.role === "client" &&
              refreshedConversation.createdByUserId !== wsUser.id)
          ) {
            sendFrame({ type: "error", message: "Conversation not found" });
            return;
          }
          agentSessionId = refreshedConversation.agentSessionId ?? null;
        }
        if (refreshedProject.migrationTarget === "astro") {
          if (refreshedMember.role !== "admin") {
            sendFrame({
              type: "error",
              message: "A project admin must run the migration before editing can continue.",
            });
            return;
          }
          if (!releaseMigrationRun) {
            releaseMigrationRun = claimMigrationRun(projectId);
            if (!releaseMigrationRun) {
              sendFrame({ type: "error", message: "This migration is already running." });
              return;
            }
          }
        } else if (releaseMigrationRun) {
          releaseMigrationRun();
          releaseMigrationRun = null;
        }
        m = refreshedMember;
        p = refreshedProject;

        const activeConversationId = convId;
        const turnId = nanoid();
        durableTurnId = turnId;
        const turnStartedAt = Date.now();
        let totalCostUsd = 0;
        let turnSequence = 0;
        let turnFinished = false;
        let unexpectedErrorEventId: string | null = null;
        const persistEvent = async (
          kind: DurableChatEventKind,
          options: {
            content?: string | null;
            payload?: Record<string, unknown> | null;
            eventId?: string;
          } = {},
        ): Promise<string> => {
          const eventId = options.eventId ?? nanoid();
          const sequence = turnSequence;
          await db.insert(chatEvents).values({
            eventId,
            projectId,
            conversationId: activeConversationId,
            turnId,
            turnSequence: sequence,
            kind,
            content: options.content ?? null,
            payload: options.payload ? JSON.stringify(options.payload) : null,
            createdAt: new Date(),
          });
          turnSequence = sequence + 1;
          return eventId;
        };

        const userEventId = nanoid();
        const acceptedAt = new Date();
        const acceptedContent = parsed.content;
        const serializedAttachments = attachments.length > 0 ? JSON.stringify(attachments) : null;
        // Accepting a turn is one atomic boundary: a crash cannot leave a
        // compatibility message without its durable event (or vice versa).
        db.transaction((transaction) => {
          if (conversationCreated) {
            transaction
              .insert(conversations)
              .values({
                id: activeConversationId,
                projectId,
                createdByUserId: wsUser.id,
                title: acceptedContent.slice(0, 100),
                createdAt: acceptedAt,
                updatedAt: acceptedAt,
              })
              .run();
          }
          transaction
            .insert(messages)
            .values({
              projectId,
              conversationId: activeConversationId,
              userId: wsUser.id,
              role: "user",
              content: acceptedContent,
              attachments: serializedAttachments,
              createdAt: acceptedAt,
            })
            .run();
          transaction
            .insert(chatEvents)
            .values({
              eventId: userEventId,
              projectId,
              conversationId: activeConversationId,
              turnId,
              turnSequence: 0,
              kind: "user",
              content: acceptedContent,
              payload: serializedAttachments ? JSON.stringify({ attachments }) : null,
              createdAt: acceptedAt,
            })
            .run();
          transaction
            .update(conversations)
            .set({ updatedAt: acceptedAt })
            .where(eq(conversations.id, activeConversationId))
            .run();
        });
        turnSequence = 1;
        if (conversationCreated) {
          sendFrame({
            type: "conversation_created",
            conversationId: activeConversationId,
            turnId,
            userEventId,
          });
        }
        sendFrame({
          type: "turn_accepted",
          conversationId: activeConversationId,
          turnId,
          userEventId,
        });

        persistUnexpectedError = async (message: string) => {
          if (turnFinished) return null;
          if (unexpectedErrorEventId) return unexpectedErrorEventId;
          unexpectedErrorEventId = await persistEvent("error", { content: message });
          await db
            .update(conversations)
            .set({ updatedAt: new Date() })
            .where(eq(conversations.id, activeConversationId));
          return unexpectedErrorEventId;
        };
        let terminalFailureEventId: string | null = null;
        persistTerminalFailure = async () => {
          if (turnFinished) return null;
          const durationMs = Date.now() - turnStartedAt;
          await db
            .update(conversations)
            .set({ updatedAt: new Date() })
            .where(eq(conversations.id, activeConversationId));
          if (!terminalFailureEventId) {
            terminalFailureEventId = await persistEvent("done", {
              payload: {
                costUsd: totalCostUsd,
                durationMs,
                pausedForQuestion: false,
                status: "error",
              },
            });
          }
          turnFinished = true;
          return { eventId: terminalFailureEventId, durationMs, costUsd: totalCostUsd };
        };

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
            "  A) REAL ASSET, the file is supposed to end up on the live site (hero image, product photo, downloadable PDF, translated content, etc.). In that case call `mcp__quillra-execution__promote_attachment` to move it out of `.quillra-temp/` into the appropriate asset path for this framework (e.g. `public/`, `src/assets/`, `src/content/`, etc.), then update the relevant source files to reference the new path. Do not use Bash for this.",
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

        // Look up the user's preferred language so the agent can reply in it
        const [userRow] = await db
          .select({ language: user.language })
          .from(user)
          .where(eq(user.id, wsUser.id))
          .limit(1);
        const userLanguage = userRow?.language ?? null;

        let assistantText = "";
        let agentErrored = false;
        const role = m.role as ProjectRole;

        // Pre-run spend cap check. If the user has already crossed their
        // effective hard cap this month, refuse the run with a friendly
        // message BEFORE the agent starts doing anything, no partial
        // work, no surprise charge, no race with the cap. A global owner
        // session bypasses the cap, but a project-scoped client cookie never
        // inherits that instance-wide privilege from the same user row.
        const block = await shouldBlockRun(wsUser.id, role, new Date(), {
          allowOwnerExemption: !wsClientSession,
        });
        if (block.blocked) {
          const message =
            "Your monthly usage limit has been reached. Please contact the site owner to continue.";
          const errorEventId = await persistEvent("error", { content: message });
          const durationMs = Date.now() - turnStartedAt;
          await db
            .update(conversations)
            .set({ updatedAt: new Date() })
            .where(eq(conversations.id, activeConversationId));
          const doneEventId = await persistEvent("done", {
            payload: { costUsd: 0, durationMs, pausedForQuestion: false, status: "blocked" },
          });
          turnFinished = true;
          sendFrame({ type: "error", eventId: errorEventId, turnId, message });
          if (repositorySyncChanged) sendFrame({ type: "refresh_preview", turnId });
          sendFrame({
            type: "done",
            eventId: doneEventId,
            turnId,
            costUsd: 0,
            durationMs,
            pausedForQuestion: false,
            status: "blocked",
          });
          return;
        }
        const preRunSpend = block.spend;
        // Server-authoritative migration mode: if the project row has
        // migration_target set, an admin invocation runs unrestricted inside
        // the project workspace and receives the Astro migration prompt.
        // Re-reading from the row (not the old cached value) means a
        // DELETE of the row or a manual SQL clear flips the next
        // message back to normal behaviour immediately.
        const migrationMode = p.migrationTarget === "astro" && role === "admin";

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

        type PendingTextEvent = {
          eventId: string;
          text: string;
          startedAt: number;
        };
        let pendingAssistant: PendingTextEvent | null = null;
        let pendingThinking: PendingTextEvent | null = null;
        let sessionPersistence = Promise.resolve();
        let usagePersistence = Promise.resolve();
        awaitSessionPersistence = () => sessionPersistence;
        awaitUsagePersistence = () => usagePersistence;

        const finalizeAssistant = async () => {
          const pending = pendingAssistant;
          if (!pending?.text) return;
          await persistEvent("assistant", {
            eventId: pending.eventId,
            content: pending.text,
          });
          if (pendingAssistant === pending) pendingAssistant = null;
        };
        const finalizeThinking = async () => {
          const pending = pendingThinking;
          if (!pending) return;
          await persistEvent("thinking", {
            eventId: pending.eventId,
            content: pending.text,
            payload: { durationMs: Math.max(0, Date.now() - pending.startedAt) },
          });
          if (pendingThinking === pending) pendingThinking = null;
        };
        const finalizeVisibleText = async () => {
          await finalizeAssistant();
          await finalizeThinking();
        };
        flushPendingTranscript = finalizeVisibleText;

        const emitAssistantText = async (text: string) => {
          await finalizeThinking();
          if (!pendingAssistant) {
            pendingAssistant = { eventId: nanoid(), text: "", startedAt: Date.now() };
          }
          pendingAssistant.text += text;
          sendFrame({
            type: "stream",
            eventId: pendingAssistant.eventId,
            turnId,
            text,
          });
        };
        const startThinking = async () => {
          await finalizeVisibleText();
          pendingThinking = { eventId: nanoid(), text: "", startedAt: Date.now() };
          sendFrame({
            type: "thinking_start",
            eventId: pendingThinking.eventId,
            turnId,
          });
        };
        const emitThinkingText = async (text: string) => {
          if (!pendingThinking) {
            pendingThinking = { eventId: nanoid(), text: "", startedAt: Date.now() };
            sendFrame({
              type: "thinking_start",
              eventId: pendingThinking.eventId,
              turnId,
            });
          }
          pendingThinking.text += text;
          sendFrame({
            type: "thinking",
            eventId: pendingThinking.eventId,
            turnId,
            text,
          });
        };

        // Run the agent once and forward events to the client. The SDK's
        // `done` event is SWALLOWED here so we can emit exactly one `done`
        // at the very end of this handler (after any auto-retry), carrying
        // aggregated cost + wall-clock duration for the cost checkpoint.
        const runAgentOnce = (prompt: string) =>
          runInProjectLock(
            projectId,
            async () => {
              let runText = "";
              let runToolCount = 0;
              let runErrored = false;
              let runEmittedAsk = false;
              // The complete agent lifetime holds the repository lock. Git
              // publish/sync/reset operations therefore cannot observe or
              // mutate a half-written working tree.
              for await (const ev of runProjectAgent({
                cwd: repoPath,
                prompt,
                role,
                projectId,
                githubBindingGeneration: p.githubBindingGeneration,
                userId: wsUser.id,
                authorizationEpoch,
                previewDevCommandOverride: p.previewDevCommand ?? null,
                language: userLanguage,
                agentSessionId,
                migrationMode,
                onSessionId: (sid) => {
                  if (sid === agentSessionId) return;
                  agentSessionId = sid;
                  sessionPersistence = sessionPersistence.then(async () => {
                    await db
                      .update(conversations)
                      .set({ agentSessionId: sid })
                      .where(eq(conversations.id, activeConversationId));
                  });
                },
                onResult: (usage) => {
                  // The SDK result envelope is authoritative for both success
                  // and failed runs. Mapped `done` events exist only on
                  // success, so counting those would lose failed-run cost.
                  totalCostUsd += usage.totalCostUsd;
                  // The billed usage row is part of the durable turn and must
                  // commit before `done`. Only the threshold email remains
                  // background work after that insert succeeds.
                  usagePersistence = usagePersistence.then(async () => {
                    try {
                      await db.insert(agentRuns).values({
                        id: nanoid(),
                        projectId,
                        conversationId: activeConversationId,
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
                      throw e;
                    }
                    void maybeNotifyThresholdCrossing({
                      userId: wsUser.id,
                      userEmail: wsUser.email,
                      userName: wsUser.name,
                      role,
                      preRunSpend,
                    }).catch((e) => {
                      console.warn("[usage-alerts] notify check failed:", e);
                    });
                  });
                },
              })) {
                // Swallow the mapper's `done`, we aggregate cost here and
                // emit our own done at the end with totals.
                if (ev.type === "done") {
                  continue;
                }
                // Intercept stream text so we can strip `<ask>` blocks and
                // replace them with structured `ask` events. Other event
                // types pass through unchanged.
                if (ev.type === "stream" && typeof ev.text === "string") {
                  for (const piece of askFilter(ev.text)) {
                    if (piece.kind === "text") {
                      await emitAssistantText(piece.text);
                      runText += piece.text;
                    } else {
                      await finalizeVisibleText();
                      const askEventId = await persistEvent("ask", {
                        content: piece.question,
                        payload: { options: piece.options },
                      });
                      sendFrame({
                        type: "ask",
                        id: askEventId,
                        eventId: askEventId,
                        turnId,
                        question: piece.question,
                        options: piece.options,
                      });
                      runEmittedAsk = true;
                    }
                  }
                  continue;
                }
                if (ev.type === "thinking_start") {
                  await startThinking();
                  continue;
                }
                if (ev.type === "thinking" && typeof ev.text === "string") {
                  await emitThinkingText(ev.text);
                  continue;
                }
                if (ev.type === "tool_call") {
                  await finalizeVisibleText();
                  const label = typeof ev.label === "string" ? ev.label : "";
                  const eventId = await persistEvent("tool_call", {
                    content: label,
                    payload:
                      typeof ev.toolUseId === "string" ? { toolUseId: ev.toolUseId } : undefined,
                  });
                  sendFrame({ ...ev, type: "tool_call", eventId, turnId });
                  runToolCount++;
                  continue;
                }
                if (ev.type === "tool") {
                  await finalizeVisibleText();
                  const detail = typeof ev.detail === "string" ? ev.detail : "";
                  const eventId = await persistEvent("tool", { content: detail });
                  sendFrame({ ...ev, type: "tool", eventId, turnId });
                  runToolCount++;
                  continue;
                }
                if (ev.type === "tool_progress") {
                  // Live progress is deliberately ephemeral. Rehydrating it
                  // after a reload would show a tool as permanently active.
                  sendFrame({ ...ev, type: "tool_progress", turnId });
                  runToolCount++;
                  continue;
                }
                if (ev.type === "error") {
                  await finalizeVisibleText();
                  const message = typeof ev.message === "string" ? ev.message : "Agent run failed";
                  const eventId = await persistEvent("error", {
                    content: message,
                  });
                  sendFrame({ ...ev, type: "error", message, eventId, turnId });
                  runErrored = true;
                  agentErrored = true;
                  continue;
                }
                sendFrame({ ...ev, turnId });
              }
              // Flush any text the filter was holding back (e.g. an
              // unfinished `<asx` that never closed). Treat it as regular
              // stream text, better to show garbled text than to lose it.
              const tail = askFlushTail();
              if (tail) {
                await emitAssistantText(tail);
                runText += tail;
              }
              return { runText, runToolCount, runErrored, runEmittedAsk };
            },
            p,
          );

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

        let pausedForQuestion = false;
        let continueSuggested = false;
        let workspaceChanged = repositorySyncChanged;
        await runInProjectLock(
          projectId,
          async () => {
            let beforeFingerprint: string | null = null;
            try {
              beforeFingerprint = await projectWorktreeFingerprint(repoPath);
            } catch (error) {
              console.warn("[chat] could not fingerprint worktree before agent run:", error);
            }

            const first = await runAgentOnce(promptText);
            assistantText += first.runText;
            pausedForQuestion = first.runEmittedAsk;

            // Skip the auto-nudge path during a migration run, migration
            // owns the whole conversation and must not get a surprise
            // "please continue" injected mid-flight.
            if (!migrationMode && suspicious(first)) {
              // The auto-nudge is a second billable SDK run. Commit the first
              // run's usage and recheck the hard cap while this user's usage
              // lease is still held before admitting that continuation.
              await usagePersistence;
              const continuationBlock = await shouldBlockRun(wsUser.id, role, new Date(), {
                allowOwnerExemption: !wsClientSession,
              });
              if (continuationBlock.blocked) {
                const message =
                  "Your monthly usage limit was reached before the assistant could continue.";
                await finalizeVisibleText();
                const eventId = await persistEvent("error", { content: message });
                sendFrame({ type: "error", eventId, turnId, message });
                agentErrored = true;
              } else {
                const second = await runAgentOnce("Please continue.");
                assistantText += second.runText;
                if (second.runEmittedAsk) pausedForQuestion = true;
                if (suspicious(second)) continueSuggested = true;
              }
            }

            try {
              const afterFingerprint = await projectWorktreeFingerprint(repoPath);
              workspaceChanged =
                repositorySyncChanged ||
                beforeFingerprint === null ||
                beforeFingerprint !== afterFingerprint;
            } catch (error) {
              // Conservatively refresh when Git status cannot be measured. A
              // missed refresh hides real edits; an extra refresh is harmless.
              workspaceChanged = true;
              console.warn("[chat] could not fingerprint worktree after agent run:", error);
            }
          },
          p,
        );

        if (continueSuggested) {
          await finalizeVisibleText();
          const eventId = await persistEvent("continue_prompt");
          sendFrame({ type: "continue_suggested", eventId, turnId });
        }

        await finalizeVisibleText();
        await Promise.all([sessionPersistence, usagePersistence]);

        if (assistantText) {
          await db.insert(messages).values({
            projectId,
            conversationId: activeConversationId,
            userId: null,
            role: "assistant",
            content: assistantText,
            createdAt: new Date(),
          });
        }

        // Update the conversation before `done` becomes observable. This
        // closes the reload race where the browser finished, reloaded, and
        // briefly saw the assistant answer disappear.
        const [completedConversation] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, activeConversationId))
          .limit(1);
        await db
          .update(conversations)
          .set({
            ...(completedConversation && !completedConversation.title?.includes(" ")
              ? { title: parsed.content.slice(0, 100) }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, activeConversationId));

        // If this was a migration run that finished cleanly, clear
        // the flag so the Editor unlocks (preview back, composer
        // enabled). On error we leave it set, the user reloads,
        // sees the "still migrating" state, and can manually clear
        // (future work) or retry.
        if (migrationMode && !agentErrored) {
          const migrationUpdate = await db
            .update(projects)
            .set({ migrationTarget: null, updatedAt: new Date() })
            .where(eq(projects.id, projectId));
          if (migrationUpdate.changes !== 1) {
            throw new Error("Migration completion could not be persisted.");
          }
        }

        // Persist the terminal transcript state before telling any browser the
        // turn is done. The event ledger is now the source for reload/replay;
        // legacy `messages` above remains for old clients.
        const durationMs = Date.now() - turnStartedAt;
        let checkpointEventId: string | null = null;
        if (!pausedForQuestion && !agentErrored) {
          checkpointEventId = await persistEvent("checkpoint", {
            payload: { costUsd: totalCostUsd, durationMs },
          });
        }
        const doneEventId = await persistEvent("done", {
          payload: {
            costUsd: totalCostUsd,
            durationMs,
            pausedForQuestion,
            status: agentErrored ? "error" : pausedForQuestion ? "paused" : "completed",
          },
        });
        turnFinished = true;

        // The browser closes the socket as soon as it receives `done`, so all
        // auxiliary completion frames must be queued first. `done` remains
        // literally last and is still emitted only after the complete durable
        // transcript and conversation state above have committed.
        if (migrationMode && !agentErrored) {
          sendFrame({ type: "migration_complete", turnId });
        }
        if (workspaceChanged) sendFrame({ type: "refresh_preview", turnId });
        sendFrame({
          type: "done",
          eventId: doneEventId,
          checkpointEventId,
          turnId,
          costUsd: totalCostUsd,
          durationMs,
          pausedForQuestion,
          status: agentErrored ? "error" : pausedForQuestion ? "paused" : "completed",
        });
      } catch (e) {
        console.error("[chat] WebSocket message failed:", e);
        await flushPendingTranscript?.().catch(() => {});
        await awaitSessionPersistence?.().catch(() => {});
        await awaitUsagePersistence?.().catch(() => {});
        const errorEventId = await persistUnexpectedError?.(
          "Chat request failed. Please try again.",
        ).catch(() => null);
        const terminal = await persistTerminalFailure?.().catch(() => null);
        sendFrame({
          type: "error",
          ...(errorEventId ? { eventId: errorEventId } : {}),
          ...(terminal && durableTurnId ? { turnId: durableTurnId } : {}),
          message: "Chat request failed. Please try again.",
        });
        if (terminal && durableTurnId) {
          sendFrame({ type: "refresh_preview", turnId: durableTurnId });
          sendFrame({
            type: "done",
            eventId: terminal.eventId,
            turnId: durableTurnId,
            checkpointEventId: null,
            costUsd: terminal.costUsd,
            durationMs: terminal.durationMs,
            pausedForQuestion: false,
            status: "error",
          });
        }
      } finally {
        releaseUsageAdmission?.();
        releaseConversationTurn?.();
        releaseMigrationRun?.();
      }
    },
  };
}
