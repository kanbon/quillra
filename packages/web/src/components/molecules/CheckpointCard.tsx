import { useT } from "@/i18n/i18n";

type Props = {
  durationMs: number;
  costUsd: number;
  cumulativeCostUsd: number;
};

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function CheckpointCard({ durationMs, costUsd, cumulativeCostUsd }: Props) {
  const { t } = useT();
  return (
    <div
      className="-mx-3 flex animate-[fadeIn_0.25s_ease-out] items-center justify-between gap-3 border-y border-neutral-200/70 bg-neutral-50/70 px-4 py-2 text-[11px] font-medium"
      role="status"
      aria-label={t("chat.checkpointLabel")}
    >
      <div className="flex min-w-0 items-center gap-2 text-neutral-600">
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600"
          aria-hidden
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-2.5 w-2.5"
          >
            <path d="M3 8.5l3.2 3 6.8-7" />
          </svg>
        </span>
        <span className="truncate">
          {t("chat.doneIn", { duration: formatDuration(durationMs) })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-neutral-400 tabular-nums">
        <span className="text-neutral-500">{formatCost(costUsd)}</span>
        <span aria-hidden>·</span>
        <span>{t("chat.totalThisChat", { total: formatCost(cumulativeCostUsd) })}</span>
      </div>
    </div>
  );
}
