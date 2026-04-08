/**
 * Bottom-sheet style preview for mobile. Slides up from the bottom of
 * the viewport with a translucent backdrop — dismiss by tapping the
 * backdrop, the close button, or the drag handle.
 *
 * Renders the actual PreviewPane iframe inside so the same
 * loading/boot-page + framework badge behaviour works on mobile too.
 */
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Props = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

export function MobilePreviewSheet({ open, onClose, children }: Props) {
  const { t } = useT();
  // Lock body scroll while the sheet is open; dismiss on Escape.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[900] md:hidden",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className={cn(
          "absolute inset-0 bg-black/40 backdrop-blur-[1px] transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      {/* Sheet */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col overflow-hidden rounded-t-3xl bg-white shadow-[0_-8px_32px_rgba(0,0,0,0.2)] transition-transform duration-300 ease-out",
          open ? "translate-y-0" : "translate-y-full",
        )}
        style={{ height: "92vh" }}
      >
        {/* Drag handle — tappable close */}
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 items-center justify-center bg-white"
          aria-label={t("preview.mobileClose")}
        >
          <span className="h-1 w-10 rounded-full bg-neutral-300" />
        </button>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
