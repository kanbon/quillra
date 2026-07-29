/**
 * Module-level chat store, survives React component unmount/remount.
 * Keyed by "projectId:conversationId" for multi-conversation support.
 */

import { apiJson } from "@/lib/api";

export type Attachment = {
  path: string;
  originalName: string;
  /** "image" or "content", content files (txt/md/html) render as a chip */
  kind?: "image" | "content";
  previewUrl?: string;
};

export type ChatLine =
  | { id: string; kind: "user"; text: string; attachments?: Attachment[] }
  | { id: string; kind: "assistant"; text: string; streaming?: boolean }
  | { id: string; kind: "tool"; detail: string }
  | { id: string; kind: "thinking"; text: string; durationMs?: number; streaming?: boolean }
  | { id: string; kind: "tool_active"; toolName: string; elapsed: number }
  // Subtle per-step line in the transcript, "Reading the homepage",
  // "Updating the Hero section", "Restarting your site", emitted by
  // the server's humanizer from each tool_use block. Gives visibility
  // into what the agent is actually doing without ever surfacing a
  // tool name or file path.
  | { id: string; kind: "tool_call"; label: string }
  // Shown once per completed turn, subtle full-width card with cost + wall-clock.
  | {
      id: string;
      kind: "checkpoint";
      costUsd: number;
      durationMs: number;
      cumulativeCostUsd: number;
    }
  // Rendered when the server auto-retried once and the turn *still* looks
  // truncated. Clicking the button sends "Please continue." as a normal
  // user message through the existing chat pipe.
  | { id: string; kind: "continue_prompt" }
  // A structured multiple-choice question from the agent. The frontend
  // always appends an "Other" option that bypasses the options and focuses
  // the composer input, never sent from the server.
  | { id: string; kind: "ask"; question: string; options: string[] }
  | { id: string; kind: "error"; message: string };

type Listener = () => void;
type FocusComposerListener = () => void;

export type ChatSnapshot = {
  lines: ChatLine[];
  busy: boolean;
  error: string | null;
  conversationId: string | null;
  /** Running sum of every `done` event's `costUsd` for this conversation.
   *  Seeded from the backend on `loadHistory` so the "this chat" total
   *  survives page reloads. Read by the checkpoint card. */
  cumulativeCostUsd: number;
};

type Internal = {
  ws: WebSocket | null;
  thinkingStart: number;
  historyLoaded: boolean;
  historyLoading: Promise<void> | null;
  historyGeneration: number;
  historyReloadRequested: boolean;
  /** Wall-clock start of the current turn. Set when `sendMessage` opens
   *  the WS so we can fall back to a locally-measured duration if the
   *  server's `done` payload is missing `durationMs`. */
  turnStartedAt: number;
};

const snapshots = new Map<string, ChatSnapshot>();
const internals = new Map<string, Internal>();
const listeners = new Map<string, Set<Listener>>();
// Keyed the same as snapshots. Fires when the agent asks a question and
// the user clicks "Other", composer subscribes and pulls focus.
const focusComposerListeners = new Map<string, Set<FocusComposerListener>>();

const EMPTY: ChatSnapshot = {
  lines: [],
  busy: false,
  error: null,
  conversationId: null,
  cumulativeCostUsd: 0,
};

function key(projectId: string, conversationId?: string | null) {
  return conversationId ? `${projectId}:${conversationId}` : projectId;
}

function getSnap(k: string): ChatSnapshot {
  return snapshots.get(k) ?? EMPTY;
}

function getInternal(k: string): Internal {
  let i = internals.get(k);
  if (!i) {
    i = {
      ws: null,
      thinkingStart: 0,
      historyLoaded: false,
      historyLoading: null,
      historyGeneration: 0,
      historyReloadRequested: false,
      turnStartedAt: 0,
    };
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

export function subscribe(
  projectId: string,
  conversationId: string | null,
  listener: Listener,
): () => void {
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

/** Composer component subscribes to this to pull focus when the user
 *  clicks "Other" on an agent question. Returns unsubscribe. */
export function subscribeFocusComposer(
  projectId: string,
  conversationId: string | null,
  listener: FocusComposerListener,
): () => void {
  const k = key(projectId, conversationId);
  let subs = focusComposerListeners.get(k);
  if (!subs) {
    subs = new Set();
    focusComposerListeners.set(k, subs);
  }
  subs.add(listener);
  return () => subs!.delete(listener);
}

function fireFocusComposer(k: string) {
  const subs = focusComposerListeners.get(k);
  if (subs) for (const fn of subs) fn();
}

/** Remove an `ask` card from the transcript. Called when the user picks
 *  "Other" (card dismissed, composer focused) or when the user sends a
 *  regular message while an ask is pending (question considered answered). */
export function dismissAsk(projectId: string, conversationId: string | null, askId: string) {
  const k = key(projectId, conversationId);
  const snap = getSnap(k);
  const lines = snap.lines.filter((l) => !(l.kind === "ask" && l.id === askId));
  if (lines.length !== snap.lines.length) update(k, { lines });
}

/** Called by AskCard when the user clicks "Other". Removes the card and
 *  pings the composer to pull focus. */
export function pickAskOther(projectId: string, conversationId: string | null, askId: string) {
  dismissAsk(projectId, conversationId, askId);
  fireFocusComposer(key(projectId, conversationId));
}

/** Clear state for a "new chat" so the UI starts fresh */
export function clearNewChat(projectId: string) {
  const k = key(projectId, null);
  snapshots.delete(k);
  const i = internals.get(k);
  if (i?.ws) {
    i.ws.close();
  }
  internals.delete(k);
  // Notify listeners so useSyncExternalStore picks up the empty state
  const subs = listeners.get(k);
  if (subs) for (const fn of subs) fn();
}

type StoredMessage = {
  id: number;
  role: string;
  content: string;
  conversationId?: string;
  createdAt: number;
  attachments?: { path: string; originalName: string; kind?: "image" | "content" }[];
};

type StoredEvent = {
  id: string;
  cursor: number;
  turnId: string;
  sequence: number;
  kind: string;
  content: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
};

type HistoryResponse = {
  messages: StoredMessage[];
  events: StoredEvent[];
  nextCursor: number;
  hasMore: boolean;
};

function mapAttachments(projectId: string, raw: unknown): Attachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const attachments: Attachment[] = [];
  for (const value of raw) {
    if (
      !value ||
      typeof value !== "object" ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      !("originalName" in value) ||
      typeof value.originalName !== "string"
    ) {
      continue;
    }
    const suppliedKind =
      "kind" in value && (value.kind === "image" || value.kind === "content")
        ? value.kind
        : undefined;
    const ext = value.path.split(".").pop()?.toLowerCase() ?? "";
    const kind =
      suppliedKind ??
      (["jpg", "jpeg", "png", "webp", "gif", "svg", "avif"].includes(ext) ? "image" : "content");
    attachments.push({
      path: value.path,
      originalName: value.originalName,
      kind,
      previewUrl:
        kind === "image"
          ? `/api/projects/${projectId}/file?path=${encodeURIComponent(value.path)}`
          : undefined,
    });
  }
  return attachments.length > 0 ? attachments : undefined;
}

function finitePayloadNumber(payload: Record<string, unknown> | null, keyName: string): number {
  const value = payload?.[keyName];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mapStoredHistory(
  projectId: string,
  messages: StoredMessage[],
  events: StoredEvent[],
): { lines: ChatLine[]; cumulativeCostUsd: number } {
  const lines: ChatLine[] = [];
  const firstEventAt = events[0]?.createdAt;
  const legacyCutoff = firstEventAt === undefined ? undefined : firstEventAt - 5_000;

  // Conversations created before the durable event ledger retain their plain
  // user/assistant history. Once rich events begin, they become authoritative
  // so compatibility message rows do not render a second copy.
  for (const message of messages) {
    if (legacyCutoff !== undefined && message.createdAt >= legacyCutoff) continue;
    if (message.role === "user") {
      const attachments = mapAttachments(projectId, message.attachments);
      lines.push({
        id: `legacy-${message.id}`,
        kind: "user",
        text: message.content,
        ...(attachments ? { attachments } : {}),
      });
    } else if (message.role === "assistant") {
      lines.push({
        id: `legacy-${message.id}`,
        kind: "assistant",
        text: message.content,
        streaming: false,
      });
    }
  }

  const turnsWithCheckpoint = new Set(
    events.filter((event) => event.kind === "checkpoint").map((event) => event.turnId),
  );
  let cumulativeCostUsd = 0;
  for (const event of events) {
    const content = event.content ?? "";
    if (event.kind === "user") {
      // A later user message answers/dismisses any previous inline question or
      // continue affordance. Keep the historical work, not stale buttons.
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index]?.kind === "ask" || lines[index]?.kind === "continue_prompt") {
          lines.splice(index, 1);
        }
      }
      const attachments = mapAttachments(projectId, event.payload?.attachments);
      lines.push({
        id: event.id,
        kind: "user",
        text: content,
        ...(attachments ? { attachments } : {}),
      });
    } else if (event.kind === "assistant") {
      lines.push({ id: event.id, kind: "assistant", text: content, streaming: false });
    } else if (event.kind === "thinking") {
      lines.push({
        id: event.id,
        kind: "thinking",
        text: content,
        durationMs: finitePayloadNumber(event.payload, "durationMs"),
        streaming: false,
      });
    } else if (event.kind === "tool_call") {
      if (content) lines.push({ id: event.id, kind: "tool_call", label: content });
    } else if (event.kind === "tool") {
      if (content) lines.push({ id: event.id, kind: "tool", detail: content });
    } else if (event.kind === "ask") {
      const options = Array.isArray(event.payload?.options)
        ? event.payload.options.filter((option): option is string => typeof option === "string")
        : [];
      lines.push({ id: event.id, kind: "ask", question: content, options });
    } else if (event.kind === "continue_prompt") {
      lines.push({ id: event.id, kind: "continue_prompt" });
    } else if (event.kind === "checkpoint") {
      const costUsd = finitePayloadNumber(event.payload, "costUsd");
      cumulativeCostUsd += costUsd;
      lines.push({
        id: event.id,
        kind: "checkpoint",
        costUsd,
        durationMs: finitePayloadNumber(event.payload, "durationMs"),
        cumulativeCostUsd,
      });
    } else if (event.kind === "done" && !turnsWithCheckpoint.has(event.turnId)) {
      // Paused/error turns consume tokens but intentionally have no visual
      // "Done" card. Carry their cost into the next visible cumulative total.
      cumulativeCostUsd += finitePayloadNumber(event.payload, "costUsd");
    } else if (event.kind === "error") {
      lines.push({
        id: event.id,
        kind: "error",
        message: content || "The assistant could not complete this turn.",
      });
    }
  }
  return { lines, cumulativeCostUsd };
}

export async function loadHistory(
  projectId: string,
  conversationId: string | null,
  options: { force?: boolean } = {},
) {
  if (!conversationId) return;
  const k = key(projectId, conversationId);
  const internal = getInternal(k);
  if (internal.historyLoading) {
    if (options.force) internal.historyReloadRequested = true;
    return internal.historyLoading;
  }
  if (internal.historyLoaded && !options.force) return;
  if (getSnap(k).busy && options.force) return;

  const historyGeneration = internal.historyGeneration;
  const request = (async () => {
    try {
      let after = 0;
      let messages: StoredMessage[] = [];
      const events: StoredEvent[] = [];
      let complete = false;
      for (let page = 0; page < 100; page += 1) {
        const query = new URLSearchParams({
          conversationId,
          after: String(after),
          limit: "500",
        });
        const response = await apiJson<HistoryResponse>(
          `/api/projects/${projectId}/messages?${query.toString()}`,
        );
        if (page === 0) messages = response.messages;
        events.push(...response.events);
        if (!response.hasMore) {
          complete = true;
          break;
        }
        if (!Number.isSafeInteger(response.nextCursor) || response.nextCursor <= after) {
          throw new Error("Chat history cursor did not advance.");
        }
        after = response.nextCursor;
      }
      if (!complete) throw new Error("Chat history exceeds the supported page limit.");
      if (historyGeneration !== internal.historyGeneration) return;

      const mapped = mapStoredHistory(projectId, messages, events);
      let cumulativeCostUsd = Math.max(mapped.cumulativeCostUsd, getSnap(k).cumulativeCostUsd);
      try {
        const totalRes = await apiJson<{ totalCostUsd: number }>(
          `/api/projects/${projectId}/conversations/${conversationId}/cost-total`,
        );
        if (typeof totalRes.totalCostUsd === "number" && Number.isFinite(totalRes.totalCostUsd)) {
          cumulativeCostUsd = Math.max(cumulativeCostUsd, totalRes.totalCostUsd);
        }
      } catch {
        /* rich done events remain a reliable display fallback */
      }
      if (historyGeneration !== internal.historyGeneration) return;
      internal.historyLoaded = true;
      update(k, {
        lines: mapped.lines,
        conversationId,
        cumulativeCostUsd,
        error: null,
      });
    } catch {
      if (historyGeneration === internal.historyGeneration) {
        update(k, { error: "Could not load history" });
      }
    }
  })();

  const completion: Promise<void> = request
    .finally(() => {
      if (internal.historyLoading === completion) internal.historyLoading = null;
    })
    .then(async () => {
      if (!internal.historyReloadRequested) return;
      internal.historyReloadRequested = false;
      await loadHistory(projectId, conversationId, { force: true });
    });
  internal.historyLoading = completion;
  return completion;
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
  /** Fires once the server reports that the migration-to-Astro agent
   *  finished cleanly and the project row has been un-flagged. Used
   *  by the Editor to refetch the project (which drops the lock on
   *  the preview + composer). */
  onMigrationComplete?: () => void,
) {
  if (!text.trim() && (!attachments || attachments.length === 0)) return;
  const k = key(projectId, conversationId);
  const snap = getSnap(k);
  const internal = getInternal(k);
  if (snap.busy) return;
  // Any response already in flight describes the transcript before this
  // optimistic turn. Let it finish for transport cleanup, but never allow it
  // to replace live content; `done` queues one authoritative reload.
  internal.historyGeneration += 1;

  const userLine: ChatLine = {
    id: crypto.randomUUID(),
    kind: "user",
    text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };

  // Any pending agent question or "Continue" prompt is considered
  // answered the moment the user sends a new message (whether they
  // picked an option button, clicked Continue, or typed freeform).
  // Strip those cards so stale affordances don't pile up.
  const prunedLines = snap.lines.filter((l) => l.kind !== "ask" && l.kind !== "continue_prompt");

  update(k, {
    error: null,
    lines: [...prunedLines, userLine],
    busy: true,
    conversationId,
  });

  internal.turnStartedAt = Date.now();

  const ws = new WebSocket(`${wsBaseUrl()}/ws/chat/${projectId}`);
  internal.ws = ws;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "message",
        content: text,
        conversationId,
        attachments: attachments?.map((a) => ({
          path: a.path,
          originalName: a.originalName,
          kind: a.kind,
        })),
      }),
    );
  };

  ws.onmessage = (evt) => {
    // A closed socket can still deliver queued callbacks after the user has
    // started a replacement turn. Never let those stale frames mutate the
    // replacement socket's transcript.
    if (internal.ws !== ws) return;

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
      const userEventId =
        typeof data.userEventId === "string" && data.userEventId ? data.userEventId : null;
      const lines = userEventId
        ? currentSnap.lines.map((line) =>
            line.kind === "user" && line.id === userLine.id ? { ...line, id: userEventId } : line,
          )
        : currentSnap.lines;
      snapshots.set(newK, { ...currentSnap, lines, conversationId: newConvId });
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

    if (type === "turn_accepted" && typeof data.userEventId === "string" && data.userEventId) {
      update(currentK, {
        lines: snap.lines.map((line) =>
          line.kind === "user" && line.id === userLine.id
            ? { ...line, id: data.userEventId as string }
            : line,
        ),
      });
    }

    if (type === "thinking_start") {
      let updated = finalizeStreaming(snap.lines);
      updated = finalizeThinking(updated, internal);
      internal.thinkingStart = Date.now();
      updated.push({
        id: typeof data.eventId === "string" && data.eventId ? data.eventId : crypto.randomUUID(),
        kind: "thinking",
        text: "",
        streaming: true,
      });
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
      const eventId =
        typeof data.eventId === "string" && data.eventId ? data.eventId : crypto.randomUUID();
      if (current?.kind === "assistant" && current.streaming && current.id === eventId) {
        updated = [...updated];
        updated[updated.length - 1] = { ...current, text: current.text + (data.text as string) };
      } else {
        updated = finalizeStreaming(updated);
        updated = [
          ...updated,
          {
            id: eventId,
            kind: "assistant" as const,
            text: data.text as string,
            streaming: true,
          },
        ];
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

    if (type === "tool_call" && typeof data.label === "string" && data.label) {
      // One subtle line per tool the agent is running. Finalise any
      // live-streaming assistant/thinking bubble first so the line
      // lands visually BETWEEN the reasoning and the next tool step,
      // not inside the middle of a word.
      let updated = finalizeStreaming(snap.lines);
      updated = finalizeThinking(updated, internal);
      updated = updated.filter((l) => l.kind !== "tool_active");
      updated.push({
        id: typeof data.eventId === "string" && data.eventId ? data.eventId : crypto.randomUUID(),
        kind: "tool_call",
        label: data.label,
      });
      update(currentK, { lines: updated });
    }

    if (type === "tool" && data.detail) {
      let updated: ChatLine[] = snap.lines.filter((l) => l.kind !== "tool_active");
      updated = finalizeStreaming(updated);
      updated = finalizeThinking(updated, internal);
      updated.push({
        id: typeof data.eventId === "string" && data.eventId ? data.eventId : crypto.randomUUID(),
        kind: "tool",
        detail: data.detail as string,
      });
      update(currentK, { lines: updated });
    }

    if (type === "continue_suggested") {
      // Server already auto-retried once and the turn is *still* short.
      // Surface a visible "Continue" button so the user can resume with
      // one click instead of typing.
      update(currentK, {
        lines: [
          ...snap.lines,
          {
            id:
              typeof data.eventId === "string" && data.eventId ? data.eventId : crypto.randomUUID(),
            kind: "continue_prompt",
          },
        ],
      });
    }

    if (type === "ask" && typeof data.question === "string" && Array.isArray(data.options)) {
      const askId = (typeof data.id === "string" && data.id) || crypto.randomUUID();
      const options = (data.options as unknown[]).filter((o): o is string => typeof o === "string");
      let updated = finalizeStreaming(snap.lines);
      updated = finalizeThinking(updated, internal);
      updated.push({
        id: askId,
        kind: "ask",
        question: data.question as string,
        options,
      });
      update(currentK, { lines: updated });
    }

    if (type === "done") {
      let updated = finalizeStreaming(snap.lines);
      updated = finalizeThinking(updated, internal);
      updated = updated.filter((l) => l.kind !== "tool_active");
      // Cost checkpoint, subtle full-width card summarising what this
      // turn cost and how long it took. We trust the server's costUsd
      // and durationMs but fall back to a locally-measured duration if
      // the payload is missing one.
      //
      // Skip the card entirely when the turn paused on an <ask> block: the
      // task isn't "done", the agent is waiting for the user's answer.
      // Showing a "Done in 3s" card under an open question is misleading.
      const costUsd =
        typeof data.costUsd === "number" && Number.isFinite(data.costUsd) ? data.costUsd : 0;
      const serverMs =
        typeof data.durationMs === "number" && Number.isFinite(data.durationMs)
          ? data.durationMs
          : 0;
      const localMs = internal.turnStartedAt > 0 ? Date.now() - internal.turnStartedAt : 0;
      const durationMs = serverMs > 0 ? serverMs : localMs;
      const nextCumulative = snap.cumulativeCostUsd + costUsd;
      const pausedForQuestion = data.pausedForQuestion === true;
      const checkpointEventId =
        typeof data.checkpointEventId === "string" && data.checkpointEventId
          ? data.checkpointEventId
          : null;
      if (!pausedForQuestion && checkpointEventId) {
        updated.push({
          id: checkpointEventId,
          kind: "checkpoint",
          costUsd,
          durationMs,
          cumulativeCostUsd: nextCumulative,
        });
      }
      internal.ws = null;
      internal.turnStartedAt = 0;
      // Cumulative cost still counts even when we don't render the card,
      // so the next checkpoint picks up an accurate running total.
      update(currentK, { lines: updated, busy: false, cumulativeCostUsd: nextCumulative });
      const completedConversationId = getSnap(currentK).conversationId;
      if (completedConversationId) {
        void loadHistory(projectId, completedConversationId, { force: true });
      }
      ws.close();
    }

    if (type === "refresh_preview") {
      // This is intentionally separate from `done`: the server only emits it
      // when the durable workspace may have changed, and the editor replaces
      // the isolated E2B snapshot instead of merely reloading stale bytes.
      onRefreshPreview?.();
    }

    // Emitted by the WS handler right after it clears the project's
    // migration_target. Tells the Editor to refetch the project row
    // so its `migrationTarget`-gated UI lock drops.
    if (type === "migration_complete") {
      onMigrationComplete?.();
    }

    if (type === "error") {
      const errMsg = (data.message as string) ?? "Error";
      let lines = finalizeStreaming(snap.lines);
      lines = finalizeThinking(lines, internal);
      lines = lines.filter((line) => line.kind !== "tool_active");
      lines.push({
        id: typeof data.eventId === "string" && data.eventId ? data.eventId : crypto.randomUUID(),
        kind: "error",
        message: errMsg,
      });
      const durableTurnContinues = typeof data.turnId === "string" && data.turnId.length > 0;
      if (!durableTurnContinues) internal.ws = null;
      update(currentK, {
        lines,
        busy: durableTurnContinues,
        error: errMsg,
      });
      if (!durableTurnContinues) ws.close();
    }
  };

  ws.onerror = () => {
    if (internal.ws !== ws) return;
    const currentK = (() => {
      for (const [ik, iv] of internals) {
        if (iv === internal) return ik;
      }
      return k;
    })();
    internal.ws = null;
    update(currentK, { busy: false, error: "Connection error" });
    ws.close();
  };

  ws.onclose = () => {
    if (internal.ws === ws) {
      const currentK = (() => {
        for (const [ik, iv] of internals) {
          if (iv === internal) return ik;
        }
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
