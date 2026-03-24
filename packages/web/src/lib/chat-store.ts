/**
 * Module-level chat store — survives React component unmount/remount.
 * Keeps WebSocket connections and chat lines per project so navigating
 * away and back preserves the full conversation including in-progress streams.
 */

import { apiJson } from "@/lib/api";

export type ChatLine =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; streaming?: boolean }
  | { id: string; kind: "tool"; detail: string }
  | { id: string; kind: "thinking"; text: string; durationMs?: number; streaming?: boolean };

type Listener = () => void;

type ProjectChat = {
  lines: ChatLine[];
  busy: boolean;
  error: string | null;
  ws: WebSocket | null;
  thinkingStart: number;
  historyLoaded: boolean;
};

const store = new Map<string, ProjectChat>();
const listeners = new Map<string, Set<Listener>>();

function getOrCreate(projectId: string): ProjectChat {
  let entry = store.get(projectId);
  if (!entry) {
    entry = { lines: [], busy: false, error: null, ws: null, thinkingStart: 0, historyLoaded: false };
    store.set(projectId, entry);
  }
  return entry;
}

function notify(projectId: string) {
  const subs = listeners.get(projectId);
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

export function getSnapshot(projectId: string): ProjectChat {
  return getOrCreate(projectId);
}

export async function loadHistory(projectId: string) {
  const chat = getOrCreate(projectId);
  if (chat.historyLoaded) return;
  chat.historyLoaded = true;
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
    chat.lines = mapped;
    notify(projectId);
  } catch {
    chat.error = "Could not load history";
    notify(projectId);
  }
}

export function sendMessage(
  projectId: string,
  text: string,
  onRefreshPreview?: () => void,
) {
  if (!text.trim()) return;
  const chat = getOrCreate(projectId);
  if (chat.busy) return;

  chat.error = null;
  chat.lines = [...chat.lines, { id: crypto.randomUUID(), kind: "user", text }];
  chat.busy = true;
  notify(projectId);

  const ws = new WebSocket(`${wsBaseUrl()}/ws/chat/${projectId}`);
  chat.ws = ws;

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

    if (type === "thinking_start") {
      chat.thinkingStart = Date.now();
      const last = chat.lines[chat.lines.length - 1];
      const updated = [...chat.lines];
      if (last?.kind === "assistant" && last.streaming) {
        updated[updated.length - 1] = { ...last, streaming: false };
      }
      updated.push({ id: crypto.randomUUID(), kind: "thinking", text: "", streaming: true });
      chat.lines = updated;
      notify(projectId);
    }

    if (type === "thinking" && data.text) {
      const last = chat.lines[chat.lines.length - 1];
      if (last?.kind === "thinking" && last.streaming) {
        chat.lines = [
          ...chat.lines.slice(0, -1),
          { ...last, text: last.text + (data.text as string) },
        ];
        notify(projectId);
      }
    }

    if (type === "stream" && data.text) {
      const updated = [...chat.lines];
      const last = updated[updated.length - 1];
      // Finalize thinking
      if (last?.kind === "thinking" && last.streaming) {
        const duration = chat.thinkingStart ? Date.now() - chat.thinkingStart : 0;
        updated[updated.length - 1] = { ...last, streaming: false, durationMs: duration };
        chat.thinkingStart = 0;
      }
      const current = updated[updated.length - 1];
      if (current?.kind === "assistant" && current.streaming) {
        updated[updated.length - 1] = { ...current, text: current.text + (data.text as string) };
      } else {
        updated.push({
          id: crypto.randomUUID(),
          kind: "assistant",
          text: data.text as string,
          streaming: true,
        });
      }
      chat.lines = updated;
      notify(projectId);
    }

    if (type === "tool" && data.detail) {
      const updated = [...chat.lines];
      const last = updated[updated.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        updated[updated.length - 1] = { ...last, streaming: false };
      }
      if (last?.kind === "thinking" && last.streaming) {
        const duration = chat.thinkingStart ? Date.now() - chat.thinkingStart : 0;
        updated[updated.length - 1] = { ...last, streaming: false, durationMs: duration };
        chat.thinkingStart = 0;
      }
      updated.push({ id: crypto.randomUUID(), kind: "tool", detail: data.detail as string });
      chat.lines = updated;
      notify(projectId);
    }

    if (type === "done") {
      const updated = [...chat.lines];
      const last = updated[updated.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        updated[updated.length - 1] = { ...last, streaming: false };
      }
      if (last?.kind === "thinking" && last.streaming) {
        const duration = chat.thinkingStart ? Date.now() - chat.thinkingStart : 0;
        updated[updated.length - 1] = { ...last, streaming: false, durationMs: duration };
      }
      chat.lines = updated;
      chat.busy = false;
      chat.ws = null;
      notify(projectId);
      ws.close();
    }

    if (type === "refresh_preview") {
      onRefreshPreview?.();
    }

    if (type === "error") {
      const errMsg = (data.message as string) ?? "Error";
      const last = chat.lines[chat.lines.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        chat.lines = [
          ...chat.lines.slice(0, -1),
          { ...last, streaming: false, text: `${last.text}\n\n_${errMsg}_` },
        ];
      } else {
        chat.lines = [
          ...chat.lines,
          { id: crypto.randomUUID(), kind: "assistant", text: `_${errMsg}_`, streaming: false },
        ];
      }
      chat.busy = false;
      chat.error = errMsg;
      chat.ws = null;
      notify(projectId);
      ws.close();
    }
  };

  ws.onerror = () => {
    chat.busy = false;
    chat.error = "Connection error";
    chat.ws = null;
    notify(projectId);
    ws.close();
  };

  ws.onclose = () => {
    if (chat.ws === ws) {
      chat.busy = false;
      const last = chat.lines[chat.lines.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        chat.lines = [...chat.lines.slice(0, -1), { ...last, streaming: false }];
      }
      if (last?.kind === "thinking" && last.streaming) {
        const duration = chat.thinkingStart ? Date.now() - chat.thinkingStart : 0;
        chat.lines = [...chat.lines.slice(0, -1), { ...last, streaming: false, durationMs: duration }];
      }
      chat.ws = null;
      notify(projectId);
    }
  };
}
