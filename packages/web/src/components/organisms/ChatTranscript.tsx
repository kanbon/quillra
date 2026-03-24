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
  // Expanded by default while streaming, collapsed after
  const [expanded, setExpanded] = useState(streaming ?? false);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevStreaming = useRef(streaming);

  useEffect(() => {
    if (!streaming) return;
    startRef.current = Date.now();
    const interval = setInterval(() => setElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(interval);
  }, [streaming]);

  // Auto-expand when streaming starts, auto-collapse when done
  useEffect(() => {
    if (streaming && !prevStreaming.current) setExpanded(true);
    if (!streaming && prevStreaming.current) {
      // Collapse after a short delay so user can see final thought
      const t = setTimeout(() => setExpanded(false), 600);
      return () => clearTimeout(t);
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  const seconds = streaming ? Math.round(elapsed / 1000) : Math.round((durationMs ?? 0) / 1000);

  return (
    <div className="max-w-[min(100%,42rem)] transition-all duration-300 ease-out">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg border border-neutral-200/80 bg-neutral-50/80 px-3 py-2 text-left text-xs text-neutral-500 transition-all duration-200 hover:bg-neutral-100"
        onClick={() => text && setExpanded((e) => !e)}
      >
        {streaming ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400 animate-[pulse_1.5s_ease-in-out_infinite]" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-300 transition-colors duration-300" />
        )}
        <span className="font-medium text-neutral-600 transition-colors duration-200">
          {streaming ? "Thinking" : "Thought"}
          {seconds > 0 && ` for ${seconds}s`}
          {streaming && "…"}
        </span>
        {text && (
          <span className="ml-auto text-neutral-400 transition-transform duration-200" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>
            ▸
          </span>
        )}
      </button>
      <div
        ref={contentRef}
        className="overflow-hidden transition-all duration-300 ease-out"
        style={{
          maxHeight: expanded && text ? `${Math.min(200, text.length * 0.15 + 60)}px` : "0px",
          opacity: expanded && text ? 1 : 0,
        }}
      >
        <div className="mt-1 rounded-lg border border-neutral-200/60 bg-white px-3 py-2 text-xs leading-relaxed text-neutral-500">
          {streaming ? text : (text.length > 500 ? text.slice(0, 500) + "…" : text)}
        </div>
      </div>
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
            <div key={`tg-${i}`} className="flex animate-[fadeIn_0.2s_ease-out] flex-col gap-1">
              {entry.items.map((t) => (
                <ToolEventRow key={t.id} detail={(t as { detail: string }).detail} />
              ))}
            </div>
          );
        }
        if (entry.kind === "tool_active") {
          return (
            <div key={entry.id} className="flex animate-[fadeIn_0.15s_ease-out] items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-2 text-xs text-blue-600">
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
        if (entry.kind === "user") {
          return (
            <div key={entry.id} className="animate-[fadeIn_0.2s_ease-out]">
              <ChatBubble role="user">{entry.text}</ChatBubble>
            </div>
          );
        }
        return (
          <div key={entry.id} className="animate-[fadeIn_0.2s_ease-out]">
            <ChatBubble role="assistant" streaming={entry.streaming}>{entry.text}</ChatBubble>
          </div>
        );
      })}
      {busy && !lines.some((l) => l.kind === "thinking" && "streaming" in l && l.streaming) && !lines.some((l) => l.kind === "tool_active") && (
        <div className="flex animate-[fadeIn_0.2s_ease-out] items-center gap-2 text-xs text-neutral-500">
          <Spinner />
          Working…
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
