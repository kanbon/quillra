/**
 * Module-level chat store — survives React component unmount/remount.
 * Keeps WebSocket connections and chat lines per project so navigating
 * away and back preserves the full conversation including in-progress streams.
 *
 * Every mutation creates a NEW snapshot object so useSyncExternalStore
 * detects changes via Object.is reference comparison.
 */

import { apiJson } from "@/lib/api";

export type ChatLine =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; streaming?: boolean }
  | { id: string; kind: "tool"; detail: string }
  | { id: string; kind: "thinking"; text: string; durationMs?: number; streaming?: boolean }
  | { id: string; kind: "tool_active"; toolName: string; elapsed: number };

type Listener = () => void;

export type ChatSnapshot = {
  lines: ChatLine[];
  busy: boolean;
  error: string | null;
};

type Internal = {
  ws: WebSocket | null;
  thinkingStart: number;
  historyLoaded: boolean;
};

const snapshots = new Map<string, ChatSnapshot>();
const internals = new Map<string, Internal>();
const listeners = new Map<string, Set<Listener>>();

const EMPTY: ChatSnapshot = { lines: [], busy: false, error: null };

function getSnap(id: string): ChatSnapshot {
  return snapshots.get(id) ?? EMPTY;
}

function getInternal(id: string): Internal {
  let i = internals.get(id);
  if (!i) {
    i = { ws: null, thinkingStart: 0, historyLoaded: false };
    internals.set(id, i);
  }
  return i;
}

/** Replace snapshot with a new object and notify listeners */
function update(id: string, patch: Partial<ChatSnapshot>) {
  const prev = getSnap(id);
  const next = { ...prev, ...patch };
  snapshots.set(id, next);
  const subs = listeners.get(id);
  if (subs) for (const fn of subs) fn();
}

function wsBaseUrl() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}

export function subscribe(projectId: string, listener: Listener): () => void {
  let subs = listeners.get(projectId);
  if (!subs) {
    subs = new Set();
    listeners.set(projectId, subs);
  }
  subs.add(listener);
  return () => subs!.delete(listener);
}

export function getSnapshot(projectId: string): ChatSnapshot {
  return getSnap(projectId);
}

export async function loadHistory(projectId: string) {
  const internal = getInternal(projectId);
  if (internal.historyLoaded) return;
  internal.historyLoaded = true;
  try {
    const res = await apiJson<{
      messages: { id: number; role: string; content: string; createdAt: number }[];
    }>(`/api/projects/${projectId}/messages`);
    const mapped: ChatLine[] = [];
    for (const m of res.messages) {
      if (m.role === "user") {
        mapped.push({ id: `h-${m.id}`, kind: "user", text: m.content });
      } else if (m.role === "assistant") {
        mapped.push({ id: `h-${m.id}`, kind: "assistant", text: m.content, streaming: false });
      }
    }
    update(projectId, { lines: mapped });
  } catch {
    update(projectId, { error: "Could not load history" });
  }
}

function finalizeThinking(lines: ChatLine[], internal: Internal): ChatLine[] {
  const updated = [...lines];
  const last = updated[updated.length - 1];
  if (last?.kind === "thinking" && last.streaming) {
    const duration = internal.thinkingStart ? Date.now() - internal.thinkingStart : 0;
    updated[updated.length - 1] = { ...last, streaming: false, durationMs: duration };
    internal.thinkingStart = 0;
  }
  return updated;
}

function finalizeStreaming(lines: ChatLine[]): ChatLine[] {
  const updated = [...lines];
  const last = updated[updated.length - 1];
  if (last?.kind === "assistant" && last.streaming) {
    updated[updated.length - 1] = { ...last, streaming: false };
  }
  return updated;
}

export function sendMessage(
  projectId: string,
  text: string,
  onRefreshPreview?: () => void,
) {
  if (!text.trim()) return;
  const snap = getSnap(projectId);
  const internal = getInternal(projectId);
  if (snap.busy) return;

  update(projectId, {
    error: null,
    lines: [...snap.lines, { id: crypto.randomUUID(), kind: "user", text }],
    busy: true,
  });

  const ws = new WebSocket(`${wsBaseUrl()}/ws/chat/${projectId}`);
  internal.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "message", content: text }));
  };

  ws.onmessage = (evt) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(String(evt.data));
    } catch {
      return;
    }

    const type = data.type as string;
    const snap = getSnap(projectId);

    if (type === "thinking_start") {
      let updated = finalizeStreaming(snap.lines);
      updated = finalizeThinking(updated, internal);
      internal.thinkingStart = Date.now();
      updated.push({ id: crypto.randomUUID(), kind: "thinking", text: "", streaming: true });
      update(projectId, { lines: updated });
    }

    if (type === "thinking" && data.text) {
      const lines = [...snap.lines];
      const last = lines[lines.length - 1];
      if (last?.kind === "thinking" && last.streaming) {
        lines[lines.length - 1] = { ...last, text: last.text + (data.text as string) };
        update(projectId, { lines });
      }
    }

    if (type === "stream" && data.text) {
      let updated = finalizeThinking(snap.lines, internal);
      const current = updated[updated.length - 1];
      if (current?.kind === "assistant" && current.streaming) {
        updated = [...updated];
        updated[updated.length - 1] = { ...current, text: current.text + (data.text as string) };
      } else {
        updated = [...updated, {
          id: crypto.randomUUID(),
          kind: "assistant" as const,
          text: data.text as string,
          streaming: true,
        }];
      }
      update(projectId, { lines: updated });
    }

    if (type === "tool_progress") {
      const updated = snap.lines.filter((l) => l.kind !== "tool_active");
      updated.push({
        id: crypto.randomUUID(),
        kind: "tool_active",
        toolName: data.toolName as string,
        elapsed: data.elapsed as number,
      });
      update(projectId, { lines: updated });
    }

    if (type === "tool" && data.detail) {
      let updated = snap.lines.filter((l) => l.kind !== "tool_active");
      updated = finalizeStreaming(updated);
      updated = finalizeThinking(updated, internal);
      updated.push({ id: crypto.randomUUID(), kind: "tool", detail: data.detail as string });
      update(projectId, { lines: updated });
    }

    if (type === "done") {
      let updated = finalizeStreaming(snap.lines);
      updated = finalizeThinking(updated, internal);
      updated = updated.filter((l) => l.kind !== "tool_active");
      internal.ws = null;
      update(projectId, { lines: updated, busy: false });
      ws.close();
    }

    if (type === "refresh_preview") {
      onRefreshPreview?.();
    }

    if (type === "error") {
      const errMsg = (data.message as string) ?? "Error";
      const last = snap.lines[snap.lines.length - 1];
      let lines: ChatLine[];
      if (last?.kind === "assistant" && last.streaming) {
        lines = [
          ...snap.lines.slice(0, -1),
          { ...last, streaming: false, text: `${last.text}\n\n_${errMsg}_` },
        ];
      } else {
        lines = [
          ...snap.lines,
          { id: crypto.randomUUID(), kind: "assistant", text: `_${errMsg}_`, streaming: false },
        ];
      }
      internal.ws = null;
      update(projectId, { lines, busy: false, error: errMsg });
      ws.close();
    }
  };

  ws.onerror = () => {
    internal.ws = null;
    update(projectId, { busy: false, error: "Connection error" });
    ws.close();
  };

  ws.onclose = () => {
    if (internal.ws === ws) {
      const snap = getSnap(projectId);
      let updated = finalizeStreaming(snap.lines);
      updated = finalizeThinking(updated, internal);
      updated = updated.filter((l) => l.kind !== "tool_active");
      internal.ws = null;
      update(projectId, { lines: updated, busy: false });
    }
  };
}
