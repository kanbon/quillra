/**
 * Reusable tab list. On desktop (≥ md) it renders vertically as a
 * sidebar-style list with icon + label + description. On mobile it
 * collapses into a horizontal scrollable strip showing just the labels.
 *
 * The parent owns {activeId} and reacts to {onChange}, we deliberately
 * don't couple this to the router, so tab switches don't push history
 * entries and the rest of the page can hold form state across switches.
 */

import { cn } from "@/lib/cn";
import { type KeyboardEvent, type ReactNode, useRef } from "react";

export type TabItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  description?: string;
};

type Props = {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
  /** Accessible label for the tab list. */
  ariaLabel?: string;
};

export function Tabs({ items, activeId, onChange, className, ariaLabel }: Props) {
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activeIndex = Math.max(
    0,
    items.findIndex((i) => i.id === activeId),
  );

  const moveFocus = (nextIndex: number) => {
    const clamped = (nextIndex + items.length) % items.length;
    const target = items[clamped];
    if (!target) return;
    onChange(target.id);
    // Defer focus so React has committed the state + the target button
    // has its active styling when we focus.
    requestAnimationFrame(() => {
      btnRefs.current[target.id]?.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Vertical (desktop) and horizontal (mobile) navigation both supported.
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      moveFocus(activeIndex + 1);
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      moveFocus(activeIndex - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveFocus(0);
    } else if (e.key === "End") {
      e.preventDefault();
      moveFocus(items.length - 1);
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      className={cn(
        // Desktop: vertical stacked sidebar
        "md:flex md:flex-col md:gap-1",
        // Mobile: horizontal scrollable strip
        "-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 md:mx-0 md:overflow-visible md:px-0 md:pb-0",
        className,
      )}
    >
      {items.map((item) => {
        const isActive = item.id === activeId;
        return (
          <button
            key={item.id}
            ref={(el) => {
              btnRefs.current[item.id] = el;
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={cn(
              "group shrink-0 rounded-xl border text-left transition-colors",
              // Mobile: compact pill
              "flex items-center gap-2 px-3 py-2 text-[13px] font-medium",
              // Desktop: full card with description underneath
              "md:block md:px-4 md:py-3",
              isActive
                ? "border-neutral-900 bg-neutral-900 text-white shadow-sm"
                : "border-transparent bg-white text-neutral-700 hover:border-neutral-200 hover:bg-neutral-50",
            )}
          >
            <div className="flex items-center gap-2.5">
              {item.icon && (
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center",
                    isActive ? "text-white" : "text-neutral-400",
                  )}
                >
                  {item.icon}
                </span>
              )}
              <span className="truncate">{item.label}</span>
            </div>
            {item.description && (
              <p
                className={cn(
                  "mt-0.5 hidden pl-[30px] text-[11px] leading-snug md:block",
                  isActive ? "text-neutral-300" : "text-neutral-400",
                )}
              >
                {item.description}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}
