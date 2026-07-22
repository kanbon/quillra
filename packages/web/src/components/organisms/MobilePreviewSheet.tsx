/**
 * Bottom-sheet style preview for mobile. Slides up from the bottom of
 * the viewport with a translucent backdrop, dismiss by tapping the
 * backdrop, the close button, the drag handle, hitting Escape, or
 * pulling the drag handle / header area downward.
 *
 * Renders the actual PreviewPane iframe inside so the same
 * loading/boot-page + framework badge behaviour works on mobile too.
 */

import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";
import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // A real modal dialog keeps the editor inert while the preview is open.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const desktop = window.matchMedia("(min-width: 768px)");
    if (desktop.matches) {
      onCloseRef.current();
      return;
    }
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener("cancel", handleCancel);
    if (!dialog.open) dialog.showModal();

    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) onCloseRef.current();
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      desktop.removeEventListener("change", closeOnDesktop);
      dialog.removeEventListener("cancel", handleCancel);
      if (dialog.open) dialog.close();
      document.body.style.overflow = prev;
      dragStartY.current = null;
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [open]);

  // Reset drag offset whenever the sheet re-opens.
  useEffect(() => {
    if (open) setDragY(0);
  }, [open]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    dragStartY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    if (dragStartY.current === null) return;
    // Only track downward pulls; upward motion is clamped to 0.
    const delta = Math.max(0, e.clientY - dragStartY.current);
    setDragY(delta);
  }, []);

  const endDrag = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      if (dragStartY.current === null) return;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      const shouldDismiss = dragY > DISMISS_THRESHOLD;
      dragStartY.current = null;
      if (shouldDismiss) {
        onCloseRef.current();
      } else {
        // Snap back up.
        setDragY(0);
      }
    },
    [dragY],
  );

  if (!open || typeof document === "undefined") return null;

  const dragging = dragStartY.current !== null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-[900] m-0 hidden h-dvh max-h-none w-full max-w-none border-0 bg-transparent p-0 open:block md:hidden"
      aria-label={t("preview.title")}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 opacity-100 backdrop-blur-[1px] transition-opacity duration-200"
        onClick={() => onCloseRef.current()}
      />
      {/* Sheet */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col overflow-hidden rounded-t-3xl bg-white shadow-[0_-8px_32px_rgba(0,0,0,0.2)]",
          // Only animate when not actively dragging, during a drag we want
          // the sheet to track the finger 1:1 without lag.
          !dragging && "transition-transform duration-300 ease-out",
        )}
        style={{
          height: "92vh",
          transform: `translateY(${dragY}px)`,
        }}
      >
        {/* Drag handle, tap to close, swipe down to dismiss */}
        <button
          type="button"
          className="flex h-8 shrink-0 cursor-grab touch-none items-center justify-center bg-white active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={(e) => {
            // Treat a tap (no drag) as an explicit close.
            if (dragY === 0 && dragStartY.current === null) onCloseRef.current();
            e.stopPropagation();
          }}
          aria-label={t("preview.mobileClose")}
        >
          <span className="h-1 w-10 rounded-full bg-neutral-300" aria-hidden="true" />
        </button>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </dialog>,
    document.body,
  );
}
