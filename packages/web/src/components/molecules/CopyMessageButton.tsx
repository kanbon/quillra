/**
 * Hover-revealed copy button for chat messages. Minimal styling by
 * design: no background, no border — just a subtle light-grey icon
 * at rest that darkens on hover.
 *
 * The hover-bridge problem:
 *   The button sits at `right-full` (to the left of its group, just
 *   outside the bubble's bounding box). Moving the cursor from the
 *   bubble to the icon crosses a small gap where — if the button had
 *   `pointer-events-none` — the browser would lose :hover on the
 *   group, the fade-out would start, and the user wouldn't reach
 *   the icon in time to click it.
 *
 *   Two things make the bridge seamless:
 *     1. No `pointer-events-none`. The button is always clickable;
 *        `opacity-0` only hides it visually. An invisible button at
 *        the left margin of a message is harmless because the user
 *        can only click what they see, and the fade-in on hover is
 *        near-instant.
 *     2. The button has generous right-padding (`pr-2.5`). The icon
 *        is laid out at the button's left edge; the padding extends
 *        the hit area rightward into the gap between icon and bubble.
 *        Cursor in that gap is still over the button, which is a
 *        descendant of the group, so group :hover stays active the
 *        whole way across.
 *
 * Copy feedback:
 *   Green check for 1.4s with a snap-in animation, then back to the
 *   copy icon. `copied` state also keeps the button visible during
 *   that window so the user sees the confirmation even if they
 *   already moved the cursor away.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Props = {
  text: string;
  className?: string;
};

async function writeToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyMessageButton({ text, className }: Props) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const onCopy = useCallback(async () => {
    const ok = await writeToClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1400);
  }, [text]);

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? t("chat.copyMessage.copied") : t("chat.copyMessage.copy")}
      title={copied ? t("chat.copyMessage.copied") : t("chat.copyMessage.copy")}
      className={cn(
        // Absolutely positioned with its right edge at the bubble's
        // left edge. `pr-2.5` adds 10px of hit area to the right of
        // the visible icon — the hover bridge.
        "absolute right-full top-1/2 flex h-7 -translate-y-1/2 items-center pr-2.5",
        // Transition opacity cheaply; never pointer-events-none so
        // the button catches the cursor the moment it reaches its
        // hit area (including the bridge).
        "opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100",
        "focus-visible:opacity-100 focus-visible:outline-none",
        copied && "opacity-100",
        className,
      )}
    >
      <span
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
          copied
            ? "text-green-600"
            : "text-neutral-400 hover:text-neutral-800 active:scale-95",
        )}
      >
        {copied ? (
          <svg
            className="h-3.5 w-3.5 animate-[copyPop_0.25s_ease-out]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </span>
    </button>
  );
}
