import { cn } from "@/lib/cn";

export function ToolEventRow({ detail }: { detail: string }) {
  return (
    <div
      className={cn(
        "max-w-[min(100%,42rem)] rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-600",
      )}
    >
      <span className="text-brand">●</span> {detail}
    </div>
  );
}
