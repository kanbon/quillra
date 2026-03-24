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

const EMPTY: ChatSnapshot = { lines: [], busy: false, error: null };

export function useProjectChat(projectId: string | undefined, onRefreshPreview?: () => void) {
  const id = projectId ?? "";

  const snap = useSyncExternalStore(
    (cb) => (id ? subscribe(id, cb) : () => {}),
    () => (id ? getSnapshot(id) : EMPTY),
  );

  useEffect(() => {
    if (id) loadHistory(id);
  }, [id]);

  const send = useCallback(
    (text: string) => {
      if (id) sendMessage(id, text, onRefreshPreview);
    },
    [id, onRefreshPreview],
  );

  return { lines: snap.lines, busy: snap.busy, error: snap.error, send };
}
