/**
 * Bottom-sheet style preview for mobile. Slides up from the bottom of
 * the viewport with a translucent backdrop — dismiss by tapping the
 * backdrop, the close button, the drag handle, hitting Escape, or
 * pulling the drag handle / header area downward.
 *
 * Renders the actual PreviewPane iframe inside so the same
 * loading/boot-page + framework badge behaviour works on mobile too.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Props = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

/** Pulling the handle further than this (in px) dismisses the sheet on release. */
const DISMISS_THRESHOLD = 120;

export function MobilePreviewSheet({ open, onClose, children }: Props) {
  const { t } = useT();
  // Live drag offset in px while the user is pulling down.
  const [dragY, setDragY] = useState(0);
  const dragStartY = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

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

  // Reset drag offset whenever the sheet re-opens.
  useEffect(() => {
    if (open) setDragY(0);
  }, [open]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    dragStartY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (dragStartY.current === null) return;
    // Only track downward pulls; upward motion is clamped to 0.
    const delta = Math.max(0, e.clientY - dragStartY.current);
    setDragY(delta);
  }, []);

  const endDrag = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (dragStartY.current === null) return;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch { /* already released */ }
      const shouldDismiss = dragY > DISMISS_THRESHOLD;
      dragStartY.current = null;
      if (shouldDismiss) {
        onClose();
      } else {
        // Snap back up.
        setDragY(0);
      }
    },
    [dragY, onClose],
  );

  if (typeof document === "undefined") return null;

  const dragging = dragStartY.current !== null;

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
        ref={sheetRef}
        className={cn(
          "absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col overflow-hidden rounded-t-3xl bg-white shadow-[0_-8px_32px_rgba(0,0,0,0.2)]",
          // Only animate when not actively dragging — during a drag we want
          // the sheet to track the finger 1:1 without lag.
          !dragging && "transition-transform duration-300 ease-out",
          open ? "translate-y-0" : "translate-y-full",
        )}
        style={{
          height: "92vh",
          transform: open ? `translateY(${dragY}px)` : undefined,
        }}
      >
        {/* Drag handle — tap to close, swipe down to dismiss */}
        <div
          className="flex h-8 shrink-0 cursor-grab touch-none items-center justify-center bg-white active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={(e) => {
            // Treat a tap (no drag) as an explicit close.
            if (dragY === 0 && dragStartY.current === null) onClose();
            e.stopPropagation();
          }}
          role="button"
          aria-label={t("preview.mobileClose")}
          tabIndex={0}
        >
          <span className="h-1 w-10 rounded-full bg-neutral-300" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
