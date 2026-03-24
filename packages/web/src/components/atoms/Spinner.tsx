import { cn } from "@/lib/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900",
        className,
      )}
      aria-hidden
    />
  );
}
