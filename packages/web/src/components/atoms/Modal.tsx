import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

type Props = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
};

export function Modal({ open, onClose, children, className }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    // Lock body scroll while a modal is open
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={cn(
          "relative mx-4 w-full max-w-md rounded-2xl bg-white p-6 shadow-xl",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
