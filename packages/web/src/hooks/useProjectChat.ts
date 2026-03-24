import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/api";

export type ChatLine =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; streaming?: boolean }
  | { id: string; kind: "tool"; detail: string };

type WsPayload =
  | { type: "stream"; text?: string }
  | { type: "tool"; detail?: string }
  | { type: "done"; result?: string }
  | { type: "error"; message?: string };

function wsBaseUrl() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}

export function useProjectChat(projectId: string | undefined) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    setLines([]);
    setError(null);
    void (async () => {
      try {
        const res = await apiJson<{
          messages: { id: number; role: string; content: string; createdAt: number }[];
        }>(`/api/projects/${projectId}/messages`);
        const mapped: ChatLine[] = [];
        for (const m of res.messages) {
          if (m.role === "user") {
            mapped.push({ id: `h-${m.id}`, kind: "user", text: m.content });
          } else if (m.role === "assistant") {
            mapped.push({
              id: `h-${m.id}`,
              kind: "assistant",
              text: m.content,
              streaming: false,
            });
          }
        }
        setLines(mapped);
      } catch {
        setError("Could not load history");
      }
    })();
  }, [projectId]);

  const send = useCallback(
    (text: string) => {
      if (!projectId || !text.trim()) return;
      setError(null);
      const uid = crypto.randomUUID();
      setLines((prev) => [...prev, { id: uid, kind: "user", text }]);
      setBusy(true);

      const ws = new WebSocket(`${wsBaseUrl()}/ws/chat/${projectId}`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "message", content: text }));
      };

      ws.onmessage = (evt) => {
        let data: WsPayload;
        try {
          data = JSON.parse(String(evt.data)) as WsPayload;
        } catch {
          return;
        }

        if (data.type === "stream" && data.text) {
          setLines((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "assistant" && last.streaming) {
              return [
                ...prev.slice(0, -1),
                { ...last, text: last.text + data.text },
              ];
            }
            return [
              ...prev,
              {
                id: crypto.randomUUID(),
                kind: "assistant",
                text: data.text ?? "",
                streaming: true,
              },
            ];
          });
        }

        if (data.type === "tool") {
          const detail = data.detail ?? "";
          if (detail) {
            setLines((prev) => [
              ...prev,
              { id: crypto.randomUUID(), kind: "tool", detail },
            ]);
          }
        }

        if (data.type === "done") {
          setLines((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "assistant") {
              return [...prev.slice(0, -1), { ...last, streaming: false }];
            }
            return prev;
          });
          setBusy(false);
          ws.close();
        }

        if (data.type === "error") {
          const errMsg = data.message ?? "Error";
          setLines((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "assistant" && last.streaming) {
              return [
                ...prev.slice(0, -1),
                {
                  ...last,
                  streaming: false,
                  text: `${last.text}\n\n_${errMsg}_`,
                },
              ];
            }
            return [
              ...prev,
              {
                id: crypto.randomUUID(),
                kind: "assistant",
                text: `_${errMsg}_`,
                streaming: false,
              },
            ];
          });
          setBusy(false);
          setError(errMsg);
          ws.close();
        }
      };

      ws.onerror = () => {
        setBusy(false);
        setError("Connection error");
        ws.close();
      };

      ws.onclose = () => {
        setBusy(false);
        setLines((prev) => {
          const last = prev[prev.length - 1];
          if (last?.kind === "assistant" && last.streaming) {
            return [...prev.slice(0, -1), { ...last, streaming: false }];
          }
          return prev;
        });
      };
    },
    [projectId],
  );

  return { lines, busy, error, send };
}
