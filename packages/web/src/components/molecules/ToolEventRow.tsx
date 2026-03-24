export function ToolEventRow({ detail }: { detail: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-neutral-150 bg-neutral-50/80 px-3 py-1.5 text-xs text-neutral-500">
      <span className="mt-px shrink-0 text-brand/60">&#9679;</span>
      <span className="min-w-0 break-words">{detail}</span>
    </div>
  );
}
