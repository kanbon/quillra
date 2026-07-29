import {
  type Attachment,
  type ChatLine,
  type ChatSnapshot,
  getSnapshot,
  loadHistory,
  sendMessage,
  subscribe,
} from "@/lib/chat-store";
import { useCallback, useEffect, useSyncExternalStore } from "react";

export type { ChatLine, Attachment };

const EMPTY: ChatSnapshot = {
  lines: [],
  busy: false,
  error: null,
  conversationId: null,
  cumulativeCostUsd: 0,
};

export function useProjectChat(
  projectId: string | undefined,
  conversationId: string | null,
  onRefreshPreview?: () => void,
  onConversationCreated?: (id: string) => void,
  onMigrationComplete?: () => void,
) {
  const id = projectId ?? "";

  const snap = useSyncExternalStore(
    (cb) => (id ? subscribe(id, conversationId, cb) : () => {}),
    () => (id ? getSnapshot(id, conversationId) : EMPTY),
  );

  useEffect(() => {
    if (!id || !conversationId) return;
    void loadHistory(id, conversationId);
    const refreshFromServer = () => {
      if (document.visibilityState === "visible") {
        void loadHistory(id, conversationId, { force: true });
      }
    };
    window.addEventListener("focus", refreshFromServer);
    window.addEventListener("online", refreshFromServer);
    document.addEventListener("visibilitychange", refreshFromServer);
    return () => {
      window.removeEventListener("focus", refreshFromServer);
      window.removeEventListener("online", refreshFromServer);
      document.removeEventListener("visibilitychange", refreshFromServer);
    };
  }, [id, conversationId]);

  const send = useCallback(
    (text: string, attachments?: Attachment[]) => {
      if (id)
        sendMessage(
          id,
          conversationId,
          text,
          onRefreshPreview,
          onConversationCreated,
          attachments,
          onMigrationComplete,
        );
    },
    [id, conversationId, onRefreshPreview, onConversationCreated, onMigrationComplete],
  );

  return { lines: snap.lines, busy: snap.busy, error: snap.error, send };
}
