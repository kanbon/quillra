import { query, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRole } from "../db/app-schema.js";

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

function buildCanUseTool(role: ProjectRole) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      toolUseID: string;
      signal: AbortSignal;
    },
  ): Promise<PermissionResult> => {
    const id = opts.toolUseID;

    if (role === "admin") {
      if (toolName === "Bash") {
        const cmd = String((input as { command?: string }).command ?? "");
        if (/(^|\s)rm\s+(-|\s)/.test(cmd)) {
          return {
            behavior: "deny",
            message: "Destructive rm is blocked. Remove files through the assistant with explicit paths or use the Publish button after commits.",
            toolUseID: id,
          };
        }
      }
      return { behavior: "allow", toolUseID: id };
    }

    if (role === "editor") {
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

    if (role === "translator") {
      if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Write" || toolName === "Edit") {
        const fp = String(
          (input as { file_path?: string }).file_path ??
            (input as { path?: string }).path ??
            "",
        ).replace(/\\/g, "/");
        if (/\/en(\/|$)/i.test(fp) || fp.includes("/content/en/")) {
          return { behavior: "deny", message: "Cannot edit source (en) locale.", toolUseID: id };
        }
        if (fp.includes("/content/") && /\/(de|fr|es)(\/|$)/i.test(fp)) {
          return { behavior: "allow", toolUseID: id };
        }
        return { behavior: "deny", message: "Translators may only edit locale content paths.", toolUseID: id };
      }
      if (toolName === "Bash") {
        const cmd = String((input as { command?: string }).command ?? "").trim();
        if (/^git\s+(add|commit|status|diff|log)\s/i.test(cmd)) {
          return { behavior: "allow", toolUseID: id };
        }
        if (/\bgit\s+push\b/i.test(cmd)) {
          return { behavior: "deny", message: "git push requires confirmation.", toolUseID: id };
        }
        return { behavior: "deny", message: "Command not allowed for translators.", toolUseID: id };
      }
      return { behavior: "deny", message: "Tool not allowed for translators.", toolUseID: id };
    }

    return { behavior: "deny", message: "Unknown role.", toolUseID: id };
  };
}

export function mapSdkMessageToClient(msg: SDKMessage): Record<string, unknown> | null {
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
    case "assistant":
      // Full message arrives after streaming — skip to avoid duplicate text.
      // The stream_event deltas already sent the text incrementally.
      return null;
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

export async function* runProjectAgent(params: {
  cwd: string;
  prompt: string;
  role: ProjectRole;
  projectId: string;
  language?: string | null;
  agentSessionId?: string | null;
  onSessionId?: (sessionId: string) => void;
  abortSignal?: AbortSignal;
}): AsyncGenerator<Record<string, unknown>> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    yield { type: "error", message: "ANTHROPIC_API_KEY is not set" };
    return;
  }

  const model = process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-4-20250514";
  const abortController = new AbortController();

  // Build the system prompt with an optional language directive appended
  const languageName = params.language ? LANGUAGE_NAMES[params.language] : null;
  const systemPromptText = languageName
    ? `${QUILLRA_SYSTEM_PROMPT}\n\nIMPORTANT: Always reply to the user in ${languageName}, regardless of the language the user writes in. Code, file names, and commit messages stay in their natural language; only your spoken/written replies must be in ${languageName}.`
    : QUILLRA_SYSTEM_PROMPT;
  params.abortSignal?.addEventListener("abort", () => abortController.abort(), { once: true });

  // Symbol thrown internally to trigger a retry without resume when the
  // SDK can't find the persisted session ID.
  const SESSION_LOST = Symbol("session_lost");

  async function* run(sessionId: string | null): AsyncGenerator<Record<string, unknown>> {
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
        includePartialMessages: true,
        persistSession: true,
        canUseTool: buildCanUseTool(params.role),
        permissionMode: "acceptEdits",
      },
    });
    let yieldedAny = false;
    for await (const msg of q) {
      if ("session_id" in msg && typeof msg.session_id === "string" && msg.session_id) {
        params.onSessionId?.(msg.session_id);
      }
      const out = mapSdkMessageToClient(msg);
      if (!out) continue;
      // Detect "session not found / no conversation" coming through as a result error.
      // If we have nothing else to show the user yet AND we were resuming a session,
      // treat it as a recoverable session-loss instead of streaming the raw error.
      if (
        out.type === "error" &&
        sessionId &&
        !yieldedAny &&
        typeof out.message === "string" &&
        /no conversation found|session id|session not found/i.test(out.message)
      ) {
        throw SESSION_LOST;
      }
      yieldedAny = true;
      yield out;
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
