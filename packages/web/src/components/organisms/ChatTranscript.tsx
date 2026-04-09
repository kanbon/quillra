import { useEffect, useRef, useState } from "react";
import { ChatBubble } from "@/components/molecules/ChatBubble";
import { ToolEventRow } from "@/components/molecules/ToolEventRow";
import { Spinner } from "@/components/atoms/Spinner";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";
import type { ChatLine } from "@/hooks/useProjectChat";

type Props = {
  lines: ChatLine[];
  busy: boolean;
};

function ThinkingCard({ text, durationMs, streaming }: { text: string; durationMs?: number; streaming?: boolean }) {
  const { t } = useT();
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  // User-controlled expand state. While streaming we keep it expanded so
  // the thought shows live; once done we leave the state alone — NO
  // auto-collapse. The previous version collapsed after 1.5s which felt
  // like the thinking bubble was "disappearing" right as the user noticed it.
  const [expanded, setExpanded] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!streaming) return;
    startRef.current = Date.now();
    const interval = setInterval(() => setElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(interval);
  }, [streaming]);

  const seconds = streaming ? Math.round(elapsed / 1000) : Math.round((durationMs ?? 0) / 1000);

  return (
    <div className="max-w-[min(100%,42rem)] animate-[fadeIn_0.2s_ease-out]">
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-all duration-200",
          streaming
            ? "border-amber-200 bg-amber-50/60 text-amber-800 hover:bg-amber-50"
            : "border-neutral-200/80 bg-neutral-50/80 text-neutral-500 hover:bg-neutral-100",
        )}
        onClick={() => text && setExpanded((e) => !e)}
      >
        {streaming ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500 animate-[pulse_1.5s_ease-in-out_infinite]" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-300" />
        )}
        <span className={cn("font-medium", streaming ? "text-amber-800" : "text-neutral-600")}>
          {streaming ? t("chat.thinking") : t("chat.thought")}
          {seconds > 0 && ` ${t("chat.forSeconds", { seconds })}`}
          {streaming && "…"}
        </span>
        {text && (
          <span
            className={cn(
              "ml-auto transition-transform duration-200",
              streaming ? "text-amber-500" : "text-neutral-400",
            )}
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ▸
          </span>
        )}
      </button>
      <div
        ref={contentRef}
        className="overflow-hidden transition-all duration-300 ease-out"
        style={{
          maxHeight: expanded && text ? "600px" : "0px",
          opacity: expanded && text ? 1 : 0,
        }}
      >
        <div
          className={cn(
            "mt-1 rounded-lg border px-3 py-2 text-xs leading-relaxed",
            streaming ? "border-amber-100 bg-white text-neutral-600" : "border-neutral-200/60 bg-white text-neutral-500",
          )}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

export function ChatTranscript({ lines, busy }: Props) {
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
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-2.5 text-center">
            {/* Lucide 'sparkles' icon, no container box — just the glyph */}
            <svg
              className="h-6 w-6 text-neutral-300"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
              <path d="M20 3v4" />
              <path d="M22 5h-4" />
              <path d="M4 17v2" />
              <path d="M5 18H3" />
            </svg>
            <p className="text-[13px] font-medium text-neutral-400">{t("chat.greeting")}</p>
          </div>
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
