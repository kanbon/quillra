/**
 * Module-level chat store — survives React component unmount/remount.
 * Keyed by "projectId:conversationId" for multi-conversation support.
 */

import { apiJson } from "@/lib/api";

export type Attachment = { path: string; originalName: string; previewUrl?: string };

export type ChatLine =
  | { id: string; kind: "user"; text: string; attachments?: Attachment[] }
  | { id: string; kind: "assistant"; text: string; streaming?: boolean }
  | { id: string; kind: "tool"; detail: string }
  | { id: string; kind: "thinking"; text: string; durationMs?: number; streaming?: boolean }
  | { id: string; kind: "tool_active"; toolName: string; elapsed: number };

type Listener = () => void;

export type ChatSnapshot = {
  lines: ChatLine[];
  busy: boolean;
  error: string | null;
  conversationId: string | null;
};

type Internal = {
  ws: WebSocket | null;
  thinkingStart: number;
  historyLoaded: boolean;
};

const snapshots = new Map<string, ChatSnapshot>();
const internals = new Map<string, Internal>();
const listeners = new Map<string, Set<Listener>>();

const EMPTY: ChatSnapshot = { lines: [], busy: false, error: null, conversationId: null };

function key(projectId: string, conversationId?: string | null) {
  return conversationId ? `${projectId}:${conversationId}` : projectId;
}

function getSnap(k: string): ChatSnapshot {
  return snapshots.get(k) ?? EMPTY;
}

function getInternal(k: string): Internal {
  let i = internals.get(k);
  if (!i) {
    i = { ws: null, thinkingStart: 0, historyLoaded: false };
    internals.set(k, i);
  }
  return i;
}

function update(k: string, patch: Partial<ChatSnapshot>) {
  const prev = getSnap(k);
  const next = { ...prev, ...patch };
  snapshots.set(k, next);
  const subs = listeners.get(k);
  if (subs) for (const fn of subs) fn();
}

function wsBaseUrl() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}

export function subscribe(projectId: string, conversationId: string | null, listener: Listener): () => void {
  const k = key(projectId, conversationId);
  let subs = listeners.get(k);
  if (!subs) {
    subs = new Set();
    listeners.set(k, subs);
  }
  subs.add(listener);
  return () => subs!.delete(listener);
}

export function getSnapshot(projectId: string, conversationId: string | null): ChatSnapshot {
  return getSnap(key(projectId, conversationId));
}

/** Clear state for a "new chat" so the UI starts fresh */
export function clearNewChat(projectId: string) {
  const k = key(projectId, null);
  snapshots.delete(k);
  const i = internals.get(k);
  if (i?.ws) { i.ws.close(); }
  internals.delete(k);
  // Notify listeners so useSyncExternalStore picks up the empty state
  const subs = listeners.get(k);
  if (subs) for (const fn of subs) fn();
}

export async function loadHistory(projectId: string, conversationId: string | null) {
  const k = key(projectId, conversationId);
  const internal = getInternal(k);
  if (internal.historyLoaded) return;
  internal.historyLoaded = true;
  try {
    const query = conversationId ? `?conversationId=${conversationId}` : "";
    const res = await apiJson<{
      messages: { id: number; role: string; content: string; conversationId?: string; createdAt: number }[];
    }>(`/api/projects/${projectId}/messages${query}`);
    const mapped: ChatLine[] = [];
    for (const m of res.messages) {
      if (m.role === "user") {
        mapped.push({ id: `h-${m.id}`, kind: "user", text: m.content });
      } else if (m.role === "assistant") {
        mapped.push({ id: `h-${m.id}`, kind: "assistant", text: m.content, streaming: false });
      }
    }
    update(k, { lines: mapped, conversationId });
  } catch {
    update(k, { error: "Could not load history" });
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
  conversationId: string | null,
  text: string,
  onRefreshPreview?: () => void,
  onConversationCreated?: (id: string) => void,
  attachments?: Attachment[],
) {
  if (!text.trim() && (!attachments || attachments.length === 0)) return;
  const k = key(projectId, conversationId);
  const snap = getSnap(k);
  const internal = getInternal(k);
  if (snap.busy) return;

  const userLine: ChatLine = {
    id: crypto.randomUUID(),
    kind: "user",
    text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };

  update(k, {
    error: null,
    lines: [...snap.lines, userLine],
    busy: true,
    conversationId,
  });

  const ws = new WebSocket(`${wsBaseUrl()}/ws/chat/${projectId}`);
  internal.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "message",
      content: text,
      conversationId,
      attachments: attachments?.map((a) => ({ path: a.path, originalName: a.originalName })),
    }));
  };

  ws.onmessage = (evt) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(String(evt.data));
    } catch {
      return;
    }

    const type = data.type as string;

    // Handle new conversation creation
    if (type === "conversation_created" && data.conversationId) {
      const newConvId = data.conversationId as string;
      // Move state from the old key to the new conversation key
      const oldK = k;
      const newK = key(projectId, newConvId);
      const currentSnap = getSnap(oldK);
      snapshots.set(newK, { ...currentSnap, conversationId: newConvId });
      // Mark history as loaded so the useEffect-driven loadHistory call
      // (triggered by the conversationId change in the parent component)
      // doesn't overwrite the live in-memory state and wipe attachments.
      internal.historyLoaded = true;
      internals.set(newK, internal);
      // Copy listeners
      const oldSubs = listeners.get(oldK);
      if (oldSubs) {
        listeners.set(newK, oldSubs);
        listeners.delete(oldK);
      }
      snapshots.delete(oldK);
      internals.delete(oldK);
      onConversationCreated?.(newConvId);
      // Notify on new key
      const subs = listeners.get(newK);
      if (subs) for (const fn of subs) fn();
      return;
    }

    // Use the current snapshot key (may have been updated by conversation_created)
    const currentK = (() => {
      // Find which key this internal belongs to
      for (const [ik, iv] of internals) {
        if (iv === internal) return ik;
      }
      return k;
    })();
    const snap = getSnap(currentK);

    if (type === "thinking_start") {
      let updated = finalizeStreaming(snap.lines);
      updated = finalizeThinking(updated, internal);
      internal.thinkingStart = Date.now();
      updated.push({ id: crypto.randomUUID(), kind: "thinking", text: "", streaming: true });
      update(currentK, { lines: updated });
    }

    if (type === "thinking" && data.text) {
      const lines = [...snap.lines];
      const last = lines[lines.length - 1];
      if (last?.kind === "thinking" && last.streaming) {
        lines[lines.length - 1] = { ...last, text: last.text + (data.text as string) };
        update(currentK, { lines });
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
      update(currentK, { lines: updated });
    }

    if (type === "tool_progress") {
      const updated: ChatLine[] = snap.lines.filter((l) => l.kind !== "tool_active");
      updated.push({
        id: crypto.randomUUID(),
        kind: "tool_active",
        toolName: data.toolName as string,
        elapsed: data.elapsed as number,
      });
      update(currentK, { lines: updated });
    }

    if (type === "tool" && data.detail) {
      let updated: ChatLine[] = snap.lines.filter((l) => l.kind !== "tool_active");
      updated = finalizeStreaming(updated);
      updated = finalizeThinking(updated, internal);
      updated.push({ id: crypto.randomUUID(), kind: "tool", detail: data.detail as string });
      update(currentK, { lines: updated });
    }

    if (type === "done") {
      let updated = finalizeStreaming(snap.lines);
      updated = finalizeThinking(updated, internal);
      updated = updated.filter((l) => l.kind !== "tool_active");
      internal.ws = null;
      update(currentK, { lines: updated, busy: false });
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
      update(currentK, { lines, busy: false, error: errMsg });
      ws.close();
    }
  };

  ws.onerror = () => {
    const currentK = (() => {
      for (const [ik, iv] of internals) { if (iv === internal) return ik; }
      return k;
    })();
    internal.ws = null;
    update(currentK, { busy: false, error: "Connection error" });
    ws.close();
  };

  ws.onclose = () => {
    if (internal.ws === ws) {
      const currentK = (() => {
        for (const [ik, iv] of internals) { if (iv === internal) return ik; }
        return k;
      })();
      const snap = getSnap(currentK);
      let updated = finalizeStreaming(snap.lines);
      updated = finalizeThinking(updated, internal);
      updated = updated.filter((l) => l.kind !== "tool_active");
      internal.ws = null;
      update(currentK, { lines: updated, busy: false });
    }
  };
}
