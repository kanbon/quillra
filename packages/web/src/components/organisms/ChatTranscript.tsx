import { useEffect, useRef } from "react";
import { ChatBubble } from "@/components/molecules/ChatBubble";
import { ToolEventRow } from "@/components/molecules/ToolEventRow";
import { Spinner } from "@/components/atoms/Spinner";
import type { ChatLine } from "@/hooks/useProjectChat";

type Props = {
  lines: ChatLine[];
  busy: boolean;
};

export function ChatTranscript({ lines, busy }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto-scroll to bottom when new lines arrive or busy state changes
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
    <div ref={containerRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-4">
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
        return (
          <ChatBubble key={entry.id} role="assistant" streaming={entry.streaming}>
            {entry.text}
          </ChatBubble>
        );
      })}
      {busy && (
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <Spinner />
          Thinking…
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
