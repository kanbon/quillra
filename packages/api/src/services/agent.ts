import { query, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRole } from "../db/app-schema.js";

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

/** Track active session IDs per project for conversation continuity */
const projectSessions = new Map<string, string>();

export function getProjectSessionId(projectId: string): string | undefined {
  return projectSessions.get(projectId);
}

export function clearProjectSession(projectId: string): void {
  projectSessions.delete(projectId);
}

export async function* runProjectAgent(params: {
  cwd: string;
  prompt: string;
  role: ProjectRole;
  projectId: string;
  abortSignal?: AbortSignal;
}): AsyncGenerator<Record<string, unknown>> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    yield { type: "error", message: "ANTHROPIC_API_KEY is not set" };
    return;
  }

  const model = process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-4-20250514";
  const abortController = new AbortController();
  params.abortSignal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const existingSessionId = projectSessions.get(params.projectId);

  const q = query({
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      model,
      abortController,
      ...(existingSessionId ? { resume: existingSessionId } : {}),
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

  try {
    for await (const msg of q) {
      // Capture session ID from any message that has one
      if ("session_id" in msg && typeof msg.session_id === "string" && msg.session_id) {
        projectSessions.set(params.projectId, msg.session_id);
      }
      const out = mapSdkMessageToClient(msg);
      if (out) yield out;
    }
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") {
      yield { type: "error", message: "Aborted" };
      return;
    }
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
