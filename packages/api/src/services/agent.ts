import { query, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRole } from "../db/app-schema.js";
import { getInstanceSetting } from "./instance-settings.js";
import { ASTRO_MIGRATION_SYSTEM_PROMPT } from "./astro-migration-skill.js";
import { buildAgentDiagnosticsMcpServer } from "./agent-diagnostics-tools.js";

/**
 * System prompt that shapes how the agent talks to Quillra users.
 * Quillra users are website owners — typically not developers — so the
 * agent must communicate in plain language and never mention build tools,
 * commands, or file paths in its replies.
 */
const QUILLRA_SYSTEM_PROMPT = `
You are the Quillra editing assistant inside a website CMS. You are helping the OWNER of a website edit their content. Treat them as a non-technical customer.

How to communicate:
- Talk like a friendly designer or editor, not a developer.
- Never mention developer concepts in your replies: do NOT say "npm", "yarn", "pnpm", "dev server", "build", "deploy", "git", "commit", "push", "package.json", "node_modules", "config files", "components", "props", "code", "TypeScript", "JavaScript", "HTML", "CSS", "framework", "Astro", "Next.js", or any file paths.
- Never say things like "you can run X to see it", "if your dev server is running", "open the file at...", "save the file", or "rebuild". The preview reloads on its own when you finish — the user does not need to do anything.
- Refer to "your site", "the homepage", "the about page", "the menu", "the footer", "the hero image" — describe pages and sections by their visible purpose, not by file paths.
- When you make a change, briefly tell the user what you changed in plain words. Keep replies short. Do not list every file you touched.
- If you need clarification, ask one short, plain-language question.
- If something fails, explain it as a problem with the site, not a technical error. Suggest a simple next step.

How to work:
- You DO have full access to the project files and can read, edit, and create them as needed using your tools — just don't talk about that to the user.
- Make the smallest correct change. Match existing style and structure.
- After you make a change, the preview will reload automatically. Do not tell the user how to view it.
- Do not invent things the user did not ask for. No new sections, no extra pages, no design overhauls unless requested.

Examples:
BAD: "I've updated the homepage title in src/pages/index.astro. Run npm run dev to see it."
GOOD: "Done — the homepage title now reads 'Welcome'."

BAD: "I added the image to public/uploads/. You can reference it in your component."
GOOD: "Added the photo to your About page, right next to the team description."

BAD: "I'll explore the codebase to find the language switcher component."
GOOD: "Let me find your language switcher."

How to ask the user a question:
- When you genuinely need a decision from the user that changes what you'll do, emit a multiple-choice question using an <ask> block. The UI turns the options into clickable cards.
- Format (JSON inside the tag, on one or more lines):
  <ask>{"question":"Which style should the hero use?","options":["Bold and colourful","Calm and minimal","Keep it like it is now"]}</ask>
- Rules:
  * 2 to 4 options. Short — each option fits on one line.
  * Plain-language only. Never put file names, component names, code, frameworks, or build terms in the question or options.
  * Do NOT include an "Other" option yourself. The UI appends one automatically and focuses the text input when the user picks it.
  * Ask only when the answer genuinely changes what you do. Don't ask for preferences the user already expressed. Don't ask out of politeness.
  * After emitting the <ask> block, STOP and wait for the user's reply. Do not continue reasoning, do not keep calling tools, do not write any text after it — the turn ends there.
  * Only use this for a single open question. Never emit two <ask> blocks in the same turn.
`.trim();

type StreamExtract =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "thinking_start" }
  | null;

function extractFromStreamEvent(event: unknown): StreamExtract {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;

  if (e.type === "content_block_start" && e.content_block && typeof e.content_block === "object") {
    const block = e.content_block as Record<string, unknown>;
    if (block.type === "thinking") return { kind: "thinking_start" };
  }

  if (e.type === "content_block_delta" && e.delta && typeof e.delta === "object") {
    const d = e.delta as Record<string, unknown>;
    if (d.type === "text_delta" && typeof d.text === "string") return { kind: "text", text: d.text };
    if (d.type === "thinking_delta" && typeof d.thinking === "string") return { kind: "thinking", text: d.thinking };
  }
  return null;
}

function textFromAssistantMessage(message: unknown): string | null {
  const m = message as { content?: unknown };
  if (!Array.isArray(m.content)) return null;
  const parts: string[] = [];
  for (const block of m.content) {
    if (block && typeof block === "object" && "text" in block) {
      const t = (block as { text?: string }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length ? parts.join("") : null;
}

function editorBlockedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.includes("/src/") ||
    normalized.startsWith("src/") ||
    /\.config\./.test(normalized) ||
    normalized.endsWith("package.json")
  );
}

function buildCanUseTool(role: ProjectRole, opts?: { migrationMode?: boolean }) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    callOpts: {
      toolUseID: string;
      signal: AbortSignal;
    },
  ): Promise<PermissionResult> => {
    const id = callOpts.toolUseID;

    // Migration mode: bypass every role's guardrails. The migration
    // agent has to delete old build configs, remove lockfiles, blow
    // away source trees, rewrite package.json, and run arbitrary
    // commands. The user is locked out of the composer while this
    // runs (isMigratingToAstro flag in the Editor), so there's no
    // risk of an interactive user fighting with the agent for
    // control. The project-level authorization to kick this off
    // happened at project creation; once migration_target is set
    // on the row, the agent gets free rein until it clears the flag.
    if (opts?.migrationMode) {
      return { behavior: "allow", toolUseID: id };
    }

    if (role === "admin") {
      // Admins have full control of their own project workspace — every
      // tool, every command, no paternalistic blocks. The workspace is
      // isolated (per-project clone on disk, git-backed so nothing is
      // truly unrecoverable) and the admin asked for Claude Code to
      // run. Removing the old `rm` block because recovering from a
      // broken install often means `rm -rf node_modules` and we shouldn't
      // be the thing standing in the way.
      return { behavior: "allow", toolUseID: id };
    }

    if (role === "editor") {
      // In-process diagnostic MCP tools (read-only preview status +
      // restart). Editors are trusted enough to debug their own dev
      // server without jumping to admin.
      if (toolName.startsWith("mcp__quillra-diagnostics__")) {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
        const fp = String(
          (input as { file_path?: string }).file_path ??
            (input as { path?: string }).path ??
            "",
        );
        if (editorBlockedPath(fp)) {
          return { behavior: "deny", message: "Editors cannot change this path.", toolUseID: id };
        }
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Bash") {
        const cmd = String((input as { command?: string }).command ?? "").trim();
        if (!/^(git|npm|yarn|pnpm|npx|node)\s/i.test(cmd)) {
          return { behavior: "deny", message: "Command not allowed for editors.", toolUseID: id };
        }
        if (/\bgit\s+push\b/i.test(cmd)) {
          return { behavior: "deny", message: "git push requires confirmation.", toolUseID: id };
        }
        return { behavior: "allow", toolUseID: id };
      }
      return { behavior: "deny", message: "Tool not allowed for editors.", toolUseID: id };
    }

    if (role === "client") {
      // Clients are non-technical end users (the website owner). They get
      // the most restrictive sandbox: read anything, but only edit content
      // files (text/markdown/json) and image assets. No code, no config,
      // no shell, no git.
      if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
        const fp = String(
          (input as { file_path?: string }).file_path ??
            (input as { path?: string }).path ??
            "",
        ).replace(/\\/g, "/");
        // Allow content paths and asset paths only
        const isContentPath = /(^|\/)(content|data|public|src\/content|src\/data|src\/assets|assets)\//i.test(fp);
        const isContentExt = /\.(md|markdown|mdx|txt|json|yaml|yml|html|htm)$/i.test(fp);
        const isImageExt = /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(fp);
        if ((isContentPath && (isContentExt || isImageExt)) || (isContentExt && isContentPath)) {
          return { behavior: "allow", toolUseID: id };
        }
        return {
          behavior: "deny",
          message: "Clients can only edit content files (text, images) inside content/ or assets/ directories.",
          toolUseID: id,
        };
      }
      if (toolName === "Bash") {
        return { behavior: "deny", message: "Clients cannot run shell commands.", toolUseID: id };
      }
      return { behavior: "deny", message: "Tool not allowed for clients.", toolUseID: id };
    }

    return { behavior: "deny", message: "Unknown role.", toolUseID: id };
  };
}

/**
 * Convert a tool call into a single plain-language line for the chat
 * transcript. The chat wants to SHOW more of what the agent is doing —
 * every Read, Edit, Bash, MCP call — but never in technical terms. A
 * Read of `src/pages/index.astro` becomes "Reading the homepage"; an
 * `npm install` becomes "Installing packages"; a diagnostic tool call
 * becomes "Checking your site". Everything else falls back to a
 * generic "Working on your site" — never surfaces the raw tool name.
 */
function humanizeToolCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const filePath = typeof input.file_path === "string"
    ? input.file_path
    : typeof input.path === "string"
      ? input.path
      : null;
  const humanFile = (fp: string): string => {
    const p = fp.replace(/\\/g, "/").replace(/^\.\//, "");
    // Pages
    if (/\/pages\/(index|home)\.(astro|jsx?|tsx?|md|mdx|html?)$/i.test(p)) return "the homepage";
    const pageMatch = p.match(/\/pages\/([^/]+?)\.(astro|jsx?|tsx?|md|mdx|html?)$/i);
    if (pageMatch) return `the ${pageMatch[1].replace(/[-_]/g, " ")} page`;
    if (/\/pages\/\[/.test(p)) return "a dynamic page";
    // Layouts / components
    if (/\/layouts\//i.test(p)) return "the page layout";
    const compMatch = p.match(/\/components\/([^/]+?)\.[a-z]+$/i);
    if (compMatch) return `the ${compMatch[1].replace(/[-_]/g, " ").toLowerCase()} section`;
    // Content
    if (/\/content\/.+\.(md|mdx)$/i.test(p)) {
      const slug = p.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      return slug ? `the ${slug.replace(/[-_]/g, " ")} post` : "a post";
    }
    // Config-ish
    if (p.endsWith("package.json")) return "the site's setup";
    if (/astro\.config|next\.config|vite\.config|tsconfig/.test(p)) return "the site's configuration";
    if (p.endsWith(".css") && /global|styles?/i.test(p)) return "the global styles";
    // Fallback: the file name, stripped
    const name = p.split("/").pop()?.replace(/\.[^.]+$/, "") ?? p;
    return name.replace(/[-_]/g, " ");
  };

  switch (toolName) {
    case "Read":
      return filePath ? `Reading ${humanFile(filePath)}` : "Reading your site";
    case "Write":
      return filePath ? `Writing ${humanFile(filePath)}` : "Writing a new file";
    case "Edit":
      return filePath ? `Updating ${humanFile(filePath)}` : "Updating your site";
    case "NotebookEdit":
      return filePath ? `Updating ${humanFile(filePath)}` : "Updating your site";
    case "Glob":
    case "Grep":
      return "Searching your site";
    case "WebFetch":
    case "WebSearch":
      return "Looking something up online";
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command : "";
      if (/\b(npm|yarn|pnpm)\s+install\b/.test(cmd)) return "Installing packages";
      if (/\b(npm|yarn|pnpm)\s+(run\s+)?build\b/.test(cmd)) return "Building your site";
      if (/\b(astro\s+dev|npm\s+run\s+dev|next\s+dev)\b/.test(cmd)) return "Starting the preview";
      if (/\bastro\s+check\b/.test(cmd)) return "Checking your site for issues";
      if (/\bgit\s+(add|commit)\b/.test(cmd)) return "Saving changes";
      if (/\bgit\s+(status|diff|log|show)\b/.test(cmd)) return "Looking at recent changes";
      if (/\bgit\s+push\b/.test(cmd)) return "Publishing your site";
      if (/\bgit\s+(clone|fetch|pull)\b/.test(cmd)) return "Syncing with your repository";
      if (/^rm\b|\brm\s+-/.test(cmd)) return "Cleaning up files";
      if (/^mv\b/.test(cmd)) return "Moving files";
      if (/^mkdir\b/.test(cmd)) return "Creating a folder";
      return "Running a setup command";
    }
    case "mcp__quillra-diagnostics__get_preview_status":
      return "Checking your site";
    case "mcp__quillra-diagnostics__tail_preview_logs":
      return "Looking at recent messages from your site";
    case "mcp__quillra-diagnostics__restart_preview":
      return "Restarting your site";
    default:
      if (toolName.startsWith("mcp__")) return "Checking your site";
      return "Working on your site";
  }
}

export function mapSdkMessageToClient(msg: SDKMessage): Record<string, unknown> | Array<Record<string, unknown>> | null {
  switch (msg.type) {
    case "tool_use_summary":
      return { type: "tool", detail: msg.summary };
    case "tool_progress":
      return { type: "tool_progress", toolName: msg.tool_name, elapsed: msg.elapsed_time_seconds };
    case "stream_event": {
      const ex = extractFromStreamEvent(msg.event);
      if (!ex) return null;
      if (ex.kind === "text") return { type: "stream", text: ex.text };
      if (ex.kind === "thinking") return { type: "thinking", text: ex.text };
      if (ex.kind === "thinking_start") return { type: "thinking_start" };
      return null;
    }
    case "assistant": {
      // Extract any tool_use blocks and emit humanized "tool_call" events
      // so the transcript shows what the agent is actually doing on each
      // step (Read, Edit, Bash, …) without leaking tool names or code.
      const content = (msg.message as { content?: unknown }).content;
      if (!Array.isArray(content)) return null;
      const events: Array<Record<string, unknown>> = [];
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "tool_use"
        ) {
          const name = typeof (block as { name?: unknown }).name === "string"
            ? ((block as { name: string }).name)
            : "";
          const rawInput = (block as { input?: unknown }).input;
          const input =
            rawInput && typeof rawInput === "object"
              ? (rawInput as Record<string, unknown>)
              : {};
          const id = typeof (block as { id?: unknown }).id === "string"
            ? (block as { id: string }).id
            : undefined;
          events.push({
            type: "tool_call",
            toolUseId: id,
            label: humanizeToolCall(name, input),
          });
        }
      }
      return events.length > 0 ? events : null;
    }
    case "result": {
      if (msg.subtype === "success") {
        return { type: "done", result: msg.result, costUsd: msg.total_cost_usd };
      }
      return {
        type: "error",
        message: msg.errors?.join("; ") ?? "Agent run failed",
        errors: msg.errors,
      };
    }
    default:
      return null;
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  de: "German (Deutsch)",
};

/**
 * Appended to the system prompt whenever the diagnostics MCP server is
 * wired up (admin + editor roles). Tells the agent when to reach for
 * the tools and — importantly — to NEVER mention them to the end user.
 * The surface stays plain-language for the website owner.
 */
const DIAGNOSTICS_TOOL_HINT = `You have three tools for inspecting the live preview's dev server:

- \`mcp__quillra-diagnostics__get_preview_status\` — returns JSON with the current stage (starting / ready / error), whether the child process is running, the exit code if it died, an HTTP probe of the dev server, the detected framework, the resolved dev command, and the last 20 stderr + 10 stdout log lines. This is your primary debugging tool.
- \`mcp__quillra-diagnostics__tail_preview_logs\` — returns a larger interleaved slice of recent log lines when 20 isn't enough.
- \`mcp__quillra-diagnostics__restart_preview\` — stops and restarts the dev server, waits a few seconds, returns the new status. Use this after you've fixed the cause of an error so the user doesn't have to click Restart themselves.

Call \`get_preview_status\` whenever the user reports the site isn't working, the preview goes blank, you've just finished a migration or dependency install, or you suspect the dev server crashed. Read \`recentErrors\` first — it's usually enough to identify the problem (missing module, port conflict, bad config, OOM exit code).

Never mention these tool names, the log fields, or "the dev server" in your reply to the user. Describe the outcome in plain language: "your site had a missing piece — I've added it and it's back online" rather than "restart_preview returned stage=ready". The user is non-technical.`;

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
  // model pays for itself many times over: the agent has to rewrite an
  // entire codebase, pin correct versions, and hit pixel-parity on
  // design. One wrong @astrojs/tailwind version and the whole site
  // falls over. Sonnet handles day-to-day edits just fine, so we
  // route by mode rather than paying Opus rates on every "change the
  // headline" turn.
  const model = params.migrationMode
    ? process.env.CLAUDE_MIGRATION_MODEL?.trim() || "claude-opus-4-7"
    : process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-4-20250514";
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
        },
        tools: { type: "preset", preset: "claude_code" },
        ...(diagnosticsServer
          ? { mcpServers: { "quillra-diagnostics": diagnosticsServer } }
          : {}),
        includePartialMessages: true,
        persistSession: true,
        // Role-based gating still happens through `canUseTool` below,
        // but the SDK's own permission system (which prompts for
        // approval on anything that isn't a file edit) stays out of
        // the way. Without bypass the agent's Bash + MCP calls were
        // being silently denied with a "permission error" that no
        // amount of our allowlist could override.
        //
        // bypassPermissions requires the explicit
        // allowDangerouslySkipPermissions flag — without it the Claude
        // Code CLI subprocess exits 1 on startup ("Claude Code process
        // exited with code 1") and the whole chat falls over. Both
        // are needed, together.
        canUseTool: buildCanUseTool(params.role, { migrationMode: params.migrationMode }),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Forward the CLI subprocess's stderr to our docker logs so
        // future startup crashes are diagnosable without another
        // SDK-type archaeology session. Each line comes through as
        // a prefixed log entry.
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
        // Detect "session not found / no conversation" coming through as a
        // result error. If we have nothing else to show the user yet AND we
        // were resuming a session, treat it as a recoverable session-loss
        // instead of streaming the raw error.
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
      // Session is gone — clear it on the server side so future runs start fresh,
      // then retry this run without `resume`.
      params.onSessionId?.("");
      try {
        yield* run(null);
        return;
      } catch (retryErr) {
        if (retryErr === SESSION_LOST) {
          yield { type: "error", message: "Could not start agent session" };
          return;
        }
        yield { type: "error", message: retryErr instanceof Error ? retryErr.message : String(retryErr) };
        return;
      }
    }
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") {
      yield { type: "error", message: "Aborted" };
      return;
    }
    // Fallback: legacy thrown-exception path
    const msg = e instanceof Error ? e.message : String(e);
    if (params.agentSessionId && /session|not found/i.test(msg)) {
      try {
        yield* run(null);
        return;
      } catch (retryErr) {
        yield { type: "error", message: retryErr instanceof Error ? retryErr.message : String(retryErr) };
        return;
      }
    }
    yield { type: "error", message: msg };
  }
}
