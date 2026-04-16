/**
 * Copy-to-clipboard icon button designed to float next to a chat
 * message bubble on hover.
 *
 * Layout contract:
 *   - Render inside a parent that's `group relative` and tightly
 *     sized to the bubble.
 *   - This button positions itself absolutely just OUTSIDE the left
 *     edge of that parent with `right-full`, plus a gap so the
 *     cursor has a clear target without being crammed against the
 *     bubble.
 *
 * Why it doesn't vanish when the cursor moves over it: `group-hover`
 * fires as long as ANY descendant of the group is under the cursor,
 * and this button is a descendant. Absolute positioning doesn't
 * remove it from the DOM tree, only from the flow. So the "dead
 * zone" between bubble and button is actually still hot — moving
 * the mouse from the bubble onto the button keeps the parent's
 * hover state active the whole way.
 *
 * Interaction details tuned for a satisfying feel:
 *   - 150ms fade-in on hover, 100ms fade-out (slightly faster out).
 *   - Click → clipboard write → swap the icon to a checkmark for
 *     1.4s, then flip back.
 *   - Active state scales down to 95% for the classic "tactile" pop.
 *   - Tooltip on hover uses the native title attribute, good enough
 *     without adding a floating-ui popup for a single-icon button.
 *   - Falls back to document.execCommand("copy") on any browser that
 *     doesn't expose navigator.clipboard (legacy http origins).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Props = {
  text: string;
  className?: string;
};

async function writeToClipboard(text: string): Promise<boolean> {
  // Preferred path: modern Clipboard API (requires https or localhost).
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }
  // Legacy fallback: hidden textarea + execCommand. Still works on
  // insecure origins where the Clipboard API is disabled.
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
        "absolute right-full top-1/2 mr-1.5 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500 shadow-sm transition-all duration-150 ease-out",
        // Hidden by default, revealed on parent :hover (and kept visible
        // while the button itself is focused — so keyboard users can
        // Tab to it without it disappearing).
        "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
        "focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
        "hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-800 active:scale-95",
        copied && "pointer-events-auto border-green-200 bg-green-50 text-green-700 opacity-100",
        className,
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
    </button>
  );
}
