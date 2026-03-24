import { useEffect, useRef, useState } from "react";
import { ChatBubble } from "@/components/molecules/ChatBubble";
import { ToolEventRow } from "@/components/molecules/ToolEventRow";
import { Spinner } from "@/components/atoms/Spinner";
import type { ChatLine } from "@/hooks/useProjectChat";

type Props = {
  lines: ChatLine[];
  busy: boolean;
};

function ThinkingCard({ text, durationMs, streaming }: { text: string; durationMs?: number; streaming?: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (!streaming) return;
    startRef.current = Date.now();
    const interval = setInterval(() => setElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(interval);
  }, [streaming]);

  const seconds = streaming ? Math.round(elapsed / 1000) : Math.round((durationMs ?? 0) / 1000);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="max-w-[min(100%,42rem)]">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg border border-neutral-200/80 bg-neutral-50/80 px-3 py-2 text-left text-xs text-neutral-500 transition-colors hover:bg-neutral-100"
        onClick={() => text && setExpanded((e) => !e)}
      >
        {streaming ? (
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-300" />
        )}
        <span className="font-medium text-neutral-600">
          {streaming ? "Thinking" : "Thought"}
          {seconds > 0 && ` for ${seconds}s`}
          {streaming && "…"}
        </span>
        {text && !streaming && (
          <span className="ml-auto text-neutral-400">{expanded ? "▾" : "▸"}</span>
        )}
      </button>
      {expanded && text && (
        <div className="mt-1 rounded-lg border border-neutral-200/60 bg-white px-3 py-2 text-xs leading-relaxed text-neutral-500">
          {text.length > 500 ? text.slice(0, 500) + "…" : text}
        </div>
      )}
    </div>
  );
}

export function ChatTranscript({ lines, busy }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bottomRef.current;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [lines.length, busy]);

  // Group consecutive tool events together
  const grouped: (ChatLine | { kind: "tool-group"; items: ChatLine[] })[] = [];
  for (const line of lines) {
    if (line.kind === "tool") {
      const last = grouped[grouped.length - 1];
      if (last && "items" in last) {
        last.items.push(line);
      } else {
        grouped.push({ kind: "tool-group", items: [line] });
      }
    } else {
      grouped.push(line);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-4">
      {grouped.map((entry, i) => {
        if ("items" in entry) {
          return (
            <div key={`tg-${i}`} className="flex flex-col gap-1">
              {entry.items.map((t) => (
                <ToolEventRow key={t.id} detail={(t as { detail: string }).detail} />
              ))}
            </div>
          );
        }
        if (entry.kind === "user") {
          return (
            <ChatBubble key={entry.id} role="user">
              {entry.text}
            </ChatBubble>
          );
        }
        if (entry.kind === "tool_active") {
          return (
            <div key={entry.id} className="flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-2 text-xs text-blue-600">
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-400" />
              <span className="font-medium">{entry.toolName}</span>
              {entry.elapsed > 0 && <span className="text-blue-400">{Math.round(entry.elapsed)}s</span>}
            </div>
          );
        }
        if (entry.kind === "thinking") {
          return (
            <ThinkingCard
              key={entry.id}
              text={entry.text}
              durationMs={entry.durationMs}
              streaming={entry.streaming}
            />
          );
        }
        return (
          <ChatBubble key={entry.id} role="assistant" streaming={entry.streaming}>
            {entry.text}
          </ChatBubble>
        );
      })}
      {busy && !lines.some((l) => l.kind === "thinking" && "streaming" in l && l.streaming) && (
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <Spinner />
          Working…
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
