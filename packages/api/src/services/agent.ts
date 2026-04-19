/**
 * Claude Agent SDK orchestrator. Thin coordinator that:
 *   1. builds the system prompt (base + language + migration skill +
 *      diagnostics hint, in that order — see agent-prompts.ts),
 *   2. picks the model by mode (Sonnet day-to-day, Opus for migrations),
 *   3. wires a fresh diagnostics MCP server and the role-based canUseTool
 *      gate per query() call,
 *   4. yields WS-ready events via agent-stream-mapper.ts,
 *   5. recovers from a lost resume-session by retrying without resume.
 *
 * Every piece that isn't orchestration lives in a sibling file:
 *   - agent-prompts.ts           — text constants
 *   - agent-permissions.ts       — role-based canUseTool
 *   - agent-humanizer.ts         — plain-language tool labels
 *   - agent-stream-mapper.ts     — SDK message → WS event
 *   - agent-diagnostics-tools.ts — in-process MCP server
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRole } from "../db/app-schema.js";
import { buildAgentDiagnosticsMcpServer } from "./agent-diagnostics-tools.js";
import { buildCanUseTool } from "./agent-permissions.js";
import { DIAGNOSTICS_TOOL_HINT, LANGUAGE_NAMES, QUILLRA_SYSTEM_PROMPT } from "./agent-prompts.js";
import { mapSdkMessageToClient } from "./agent-stream-mapper.js";
import { ASTRO_MIGRATION_SYSTEM_PROMPT } from "./astro-migration-skill.js";
import { getInstanceSetting } from "./instance-settings.js";

export { mapSdkMessageToClient } from "./agent-stream-mapper.js";

/** Raw usage summary yielded once per successful run. The numbers come
 *  straight from the SDK's result envelope so the caller persists what
 *  Anthropic actually billed, not our own approximation. */
export type AgentRunUsage = {
  totalCostUsd: number;
  numTurns: number;
  /** Summed across every model used in this run. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** The per-model breakdown the SDK reported, keyed by model name. */
  modelUsage: Record<string, unknown>;
};

export async function* runProjectAgent(params: {
  cwd: string;
  prompt: string;
  role: ProjectRole;
  projectId: string;
  /** From projects.preview_dev_command — lets the diagnostics tools
   *  resolve the exact dev command the user configured. */
  previewDevCommandOverride?: string | null;
  language?: string | null;
  agentSessionId?: string | null;
  onSessionId?: (sessionId: string) => void;
  abortSignal?: AbortSignal;
  /** When true, the agent is in "rewrite to Astro" mode: unrestricted
   *  tool permissions and the Astro migration skill is appended to
   *  the system prompt. See services/astro-migration-skill.ts. */
  migrationMode?: boolean;
  /** Fired exactly once per successful run, right before the `done`
   *  message is yielded. The WS chat handler uses this to persist an
   *  agent_runs row for the Usage tab. On error/abort the callback
   *  does not fire. */
  onResult?: (usage: AgentRunUsage) => void;
}): AsyncGenerator<Record<string, unknown>> {
  const apiKey = getInstanceSetting("ANTHROPIC_API_KEY");
  if (!apiKey) {
    yield { type: "error", message: "Quillra is not configured yet — finish the setup wizard." };
    return;
  }

  // Migrations are the one workflow where picking the most capable
  // model pays for itself many times over: the agent has to rewrite
  // an entire codebase, pin correct versions, and hit pixel-parity on
  // design. Sonnet handles day-to-day edits just fine, so we route by
  // mode rather than paying Opus rates on every "change the headline"
  // turn.
  //
  // Default migration model is Opus 4.7 (requires claude-agent-sdk
  // 0.2.112+ — older bundles have a hard-coded adaptive-thinking
  // allowlist that whitelists only opus-4-6 / sonnet-4-6 and falls
  // back to the deprecated `thinking.type.enabled` payload, which
  // Opus 4.7 rejects with a 400). If you pin an older SDK, override
  // CLAUDE_MIGRATION_MODEL to claude-opus-4-6.
  const model = params.migrationMode
    ? process.env.CLAUDE_MIGRATION_MODEL?.trim() || "claude-opus-4-7"
    : process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-4-6";
  const abortController = new AbortController();

  // Build the system prompt with optional language + migration skill
  // appended. Migration mode deliberately keeps the base Quillra prompt
  // because the agent still needs to respect tool-call semantics; we
  // just add a massive "here's how Astro works and how to migrate"
  // block on top. The "don't say technical words" directive in the
  // base prompt becomes advisory during migration — the user is
  // locked out of the composer anyway, so chatter is harmless.
  const languageName = params.language ? LANGUAGE_NAMES[params.language] : null;
  let systemPromptText = languageName
    ? `${QUILLRA_SYSTEM_PROMPT}\n\nIMPORTANT: Always reply to the user in ${languageName}, regardless of the language the user writes in. Code, file names, and commit messages stay in their natural language; only your spoken/written replies must be in ${languageName}.`
    : QUILLRA_SYSTEM_PROMPT;
  if (params.migrationMode) {
    systemPromptText = `${systemPromptText}\n\n---\n\n${ASTRO_MIGRATION_SYSTEM_PROMPT}`;
  }

  // Technical roles (admin + editor) get in-process diagnostic tools
  // wired up as an MCP server. Gives the agent a way to see why the
  // live preview isn't working — previously it was blind to npm-install
  // OOMs, dev-server crash loops, and Astro config errors and would
  // either claim success or retry without understanding. Clients never
  // touch the preview, so they don't get these tools.
  //
  // The server INSTANCE has to be rebuilt per `query()` call — the SDK's
  // internal MCP client calls `.connect()` on the underlying Server,
  // and the Server only allows one transport at a time. Re-using the
  // same instance across the SESSION_LOST retry throws
  // "Already connected to a transport" and (because it lands in an
  // async-generator consumer) bubbles up as an unhandledRejection that
  // kills the whole Node process.
  const diagnosticsEligible = params.role === "admin" || params.role === "editor";
  if (diagnosticsEligible) {
    systemPromptText = `${systemPromptText}\n\n---\n\n${DIAGNOSTICS_TOOL_HINT}`;
  }
  const buildDiagnosticsForThisQuery = () =>
    diagnosticsEligible
      ? buildAgentDiagnosticsMcpServer({
          projectId: params.projectId,
          repoPath: params.cwd,
          previewDevCommandOverride: params.previewDevCommandOverride ?? null,
        })
      : null;

  params.abortSignal?.addEventListener("abort", () => abortController.abort(), { once: true });

  // Symbol thrown internally to trigger a retry without resume when the
  // SDK can't find the persisted session ID.
  const SESSION_LOST = Symbol("session_lost");

  async function* run(sessionId: string | null): AsyncGenerator<Record<string, unknown>> {
    const diagnosticsServer = buildDiagnosticsForThisQuery();
    const q = query({
      prompt: params.prompt,
      options: {
        cwd: params.cwd,
        model,
        abortController,
        ...(sessionId ? { resume: sessionId } : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptText },
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: apiKey,
          CLAUDE_AGENT_SDK_CLIENT_APP: "quillra/cms",
          // IS_SANDBOX=1 bypasses the CLI's refusal to run
          // --dangerously-skip-permissions as root. We legitimately
          // run as root inside a Docker container (which *is* a
          // sandbox) — setting this env tells the CLI so. Without it
          // the subprocess exits 1 on startup with "cannot be used
          // with root/sudo privileges for security reasons" and the
          // whole chat falls over.
          IS_SANDBOX: "1",
        },
        tools: { type: "preset", preset: "claude_code" },
        ...(diagnosticsServer ? { mcpServers: { "quillra-diagnostics": diagnosticsServer } } : {}),
        // Opus 4.7 (and the Claude 4.6+ line) requires BOTH adaptive
        // thinking AND an explicit effort level — setting one without
        // the other either triggers an API 400 (on Opus) or silently
        // degrades to non-thinking mode. Per the adaptive-thinking
        // docs, `effort: "high"` for migrations (Opus) and `medium`
        // for day-to-day (Sonnet) balances cost vs. quality. See
        // https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
        thinking: { type: "adaptive" },
        effort: params.migrationMode ? "high" : "medium",
        includePartialMessages: true,
        persistSession: true,
        // Role-based gating still happens through `canUseTool`, but the
        // SDK's own permission system (which prompts for approval on
        // anything that isn't a file edit) stays out of the way.
        // bypassPermissions requires allowDangerouslySkipPermissions
        // — without the pair, the CLI subprocess exits 1 on startup.
        canUseTool: buildCanUseTool(params.role, { migrationMode: params.migrationMode }),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Forward the CLI subprocess's stderr to our docker logs so
        // future startup crashes are diagnosable without another
        // SDK-type archaeology session.
        stderr: (line: string) => {
          console.error(`[claude-cli] ${line.replace(/\s+$/, "")}`);
        },
      },
    });
    let yieldedAny = false;
    for await (const msg of q) {
      if ("session_id" in msg && typeof msg.session_id === "string" && msg.session_id) {
        params.onSessionId?.(msg.session_id);
      }
      // Intercept the SDK's terminal `result` envelope to surface the
      // per-run usage/cost before handing it to the mapper. Only fire
      // onResult on success — the caller shouldn't bill the user for
      // a run that failed halfway.
      if (msg.type === "result" && msg.subtype === "success") {
        try {
          const modelUsage = (msg as { modelUsage?: Record<string, unknown> }).modelUsage ?? {};
          let inputTokens = 0;
          let outputTokens = 0;
          let cacheReadTokens = 0;
          let cacheCreationTokens = 0;
          for (const entry of Object.values(modelUsage)) {
            const mu = entry as {
              inputTokens?: number;
              outputTokens?: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
            };
            inputTokens += mu.inputTokens ?? 0;
            outputTokens += mu.outputTokens ?? 0;
            cacheReadTokens += mu.cacheReadInputTokens ?? 0;
            cacheCreationTokens += mu.cacheCreationInputTokens ?? 0;
          }
          params.onResult?.({
            totalCostUsd: (msg as { total_cost_usd?: number }).total_cost_usd ?? 0,
            numTurns: (msg as { num_turns?: number }).num_turns ?? 1,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            modelUsage,
          });
        } catch {
          /* usage accounting is best-effort, never break the chat stream over it */
        }
      }
      const out = mapSdkMessageToClient(msg);
      if (!out) continue;
      // The assistant case can emit multiple tool_call events in one
      // SDK message; normalise to an array so we yield each separately.
      const outs = Array.isArray(out) ? out : [out];
      for (const ev of outs) {
        // Detect "session not found / no conversation" coming through
        // as a result error. If we have nothing else to show the user
        // yet AND we were resuming a session, treat it as recoverable.
        if (
          ev.type === "error" &&
          sessionId &&
          !yieldedAny &&
          typeof ev.message === "string" &&
          /no conversation found|session id|session not found/i.test(ev.message)
        ) {
          throw SESSION_LOST;
        }
        yieldedAny = true;
        yield ev;
      }
    }
  }

  try {
    yield* run(params.agentSessionId ?? null);
  } catch (e) {
    if (e === SESSION_LOST) {
      // Session is gone — clear it on the server side so future runs
      // start fresh, then retry this run without `resume`.
      params.onSessionId?.("");
      try {
        yield* run(null);
        return;
      } catch (retryErr) {
        if (retryErr === SESSION_LOST) {
          yield { type: "error", message: "Could not start agent session" };
          return;
        }
        yield {
          type: "error",
          message: retryErr instanceof Error ? retryErr.message : String(retryErr),
        };
        return;
      }
    }
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") {
      yield { type: "error", message: "Aborted" };
      return;
    }
    // Fallback: legacy thrown-exception path. Some older SDK error
    // shapes throw instead of yielding a result/error envelope.
    const msg = e instanceof Error ? e.message : String(e);
    if (params.agentSessionId && /session|not found/i.test(msg)) {
      try {
        yield* run(null);
        return;
      } catch (retryErr) {
        yield {
          type: "error",
          message: retryErr instanceof Error ? retryErr.message : String(retryErr),
        };
        return;
      }
    }
    yield { type: "error", message: msg };
  }
}
