import { useEffect, useRef, useState } from "react";
import { ChatBubble } from "@/components/molecules/ChatBubble";
import { ToolEventRow } from "@/components/molecules/ToolEventRow";
import { Spinner } from "@/components/atoms/Spinner";
import { useT } from "@/i18n/i18n";
import type { ChatLine } from "@/hooks/useProjectChat";

type Props = {
  lines: ChatLine[];
  busy: boolean;
  onNewChat?: () => void;
};

function ThinkingCard({ text, durationMs, streaming }: { text: string; durationMs?: number; streaming?: boolean }) {
  const { t } = useT();
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
      // Collapse after a delay so user can see the final thought
      const t = setTimeout(() => setExpanded(false), 1500);
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
          {streaming ? t("chat.thinking") : t("chat.thought")}
          {seconds > 0 && ` ${t("chat.forSeconds", { seconds })}`}
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

export function ChatTranscript({ lines, busy, onNewChat }: Props) {
  const { t } = useT();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Derive a scroll key that changes when content grows (not just line count)
  const lastLine = lines[lines.length - 1];
  const scrollKey = `${lines.length}-${busy}-${lastLine && "text" in lastLine ? (lastLine as { text: string }).text.length : 0}`;

  useEffect(() => {
    const el = bottomRef.current;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [scrollKey]);

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
      {grouped.length === 0 && !busy && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-neutral-400">{t("chat.noMessages")}</p>
          {onNewChat && (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 shadow-sm transition-colors hover:bg-neutral-50 hover:text-neutral-800"
              onClick={onNewChat}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              {t("chat.newChat")}
            </button>
          )}
        </div>
      )}
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
            <div key={entry.id} className="flex animate-[fadeIn_0.2s_ease-out] flex-col items-end gap-1.5">
              {entry.attachments && entry.attachments.length > 0 && (
                <div className="flex max-w-[min(100%,42rem)] flex-wrap justify-end gap-1.5">
                  {entry.attachments.map((a, idx) => {
                    const isImage = a.kind === "image" || (!a.kind && Boolean(a.previewUrl));
                    return isImage ? (
                      <div
                        key={`${entry.id}-att-${idx}`}
                        className="h-20 w-20 overflow-hidden rounded-md border border-neutral-200 bg-neutral-50"
                        title={a.originalName}
                      >
                        {a.previewUrl ? (
                          <img src={a.previewUrl} alt={a.originalName} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-neutral-400">
                            {a.originalName.split(".").pop()?.toUpperCase() ?? "IMG"}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        key={`${entry.id}-att-${idx}`}
                        className="flex h-12 max-w-[260px] items-center gap-2.5 rounded-lg border border-neutral-200 bg-white px-3"
                        title={a.originalName}
                      >
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-neutral-50 text-neutral-500 ring-1 ring-neutral-200">
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[12px] font-medium text-neutral-800">{a.originalName}</p>
                          <p className="text-[10px] uppercase tracking-wide text-neutral-400">
                            {a.originalName.split(".").pop()?.toUpperCase() ?? "FILE"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {entry.text && <ChatBubble role="user">{entry.text}</ChatBubble>}
            </div>
          );
        }
        if (entry.kind === "assistant") {
          return (
            <div key={entry.id} className="animate-[fadeIn_0.2s_ease-out]">
              <ChatBubble role="assistant" streaming={entry.streaming}>{entry.text}</ChatBubble>
            </div>
          );
        }
        return null;
      })}
      {busy && !lines.some((l) => l.kind === "thinking" && "streaming" in l && l.streaming) && !lines.some((l) => l.kind === "tool_active") && (
        <div className="flex animate-[fadeIn_0.2s_ease-out] items-center gap-2 text-xs text-neutral-500">
          <Spinner />
          {t("chat.working")}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
