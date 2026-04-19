/**
 * Translates Claude Agent SDK messages into the WebSocket event shape
 * the Quillra frontend expects. Isolated here because the mapping is
 * pure — no I/O, no state — which makes it easy to test and easy for
 * contributors to grok without reading the orchestration code.
 *
 * Emitted event types (see chat-store.ts for the full shape):
 *  - { type: "stream", text }         live assistant text delta
 *  - { type: "thinking", text }       live extended-thinking delta
 *  - { type: "thinking_start" }       start of a thinking block
 *  - { type: "tool", detail }         human summary of a completed tool run
 *  - { type: "tool_progress", … }     live "tool X has been running Ns"
 *  - { type: "tool_call", … }         humanized per-tool line for the transcript
 *  - { type: "done", costUsd, … }     terminal success envelope
 *  - { type: "error", message, … }    terminal failure envelope
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { humanizeToolCall } from "./agent-humanizer.js";

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
    if (d.type === "text_delta" && typeof d.text === "string")
      return { kind: "text", text: d.text };
    if (d.type === "thinking_delta" && typeof d.thinking === "string")
      return { kind: "thinking", text: d.thinking };
  }
  return null;
}

/** Extract any tool_use content blocks from an assistant message and
 *  emit a humanized tool_call event per block. Never leaks tool
 *  names, file paths, or commands — the humanizer is the chokepoint.
 */
function tooCallEventsFromAssistantMessage(
  msg: Extract<SDKMessage, { type: "assistant" }>,
): Array<Record<string, unknown>> {
  const content = (msg.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const events: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "tool_use") {
      const name =
        typeof (block as { name?: unknown }).name === "string"
          ? (block as { name: string }).name
          : "";
      const rawInput = (block as { input?: unknown }).input;
      const input =
        rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
      const id =
        typeof (block as { id?: unknown }).id === "string"
          ? (block as { id: string }).id
          : undefined;
      events.push({
        type: "tool_call",
        toolUseId: id,
        label: humanizeToolCall(name, input),
      });
    }
  }
  return events;
}

export function mapSdkMessageToClient(
  msg: SDKMessage,
): Record<string, unknown> | Array<Record<string, unknown>> | null {
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
      const events = tooCallEventsFromAssistantMessage(msg);
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
