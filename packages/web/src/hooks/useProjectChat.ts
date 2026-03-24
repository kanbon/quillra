import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  subscribe,
  getSnapshot,
  loadHistory,
  sendMessage,
  type ChatLine,
  type ChatSnapshot,
} from "@/lib/chat-store";

export type { ChatLine };

const EMPTY: ChatSnapshot = { lines: [], busy: false, error: null, conversationId: null };

export function useProjectChat(
  projectId: string | undefined,
  conversationId: string | null,
  onRefreshPreview?: () => void,
  onConversationCreated?: (id: string) => void,
) {
  const id = projectId ?? "";

  const snap = useSyncExternalStore(
    (cb) => (id ? subscribe(id, conversationId, cb) : () => {}),
    () => (id ? getSnapshot(id, conversationId) : EMPTY),
  );

  useEffect(() => {
    if (id && conversationId) loadHistory(id, conversationId);
  }, [id, conversationId]);

  const send = useCallback(
    (text: string) => {
      if (id) sendMessage(id, conversationId, text, onRefreshPreview, onConversationCreated);
    },
    [id, conversationId, onRefreshPreview, onConversationCreated],
  );

  return { lines: snap.lines, busy: snap.busy, error: snap.error, send };
}
