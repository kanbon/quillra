/**
 * Organization-level token usage + cost breakdown. Reads
 * `/api/admin/usage` and renders three tables: per-project, per-user,
 * per-model. A small range selector pivots the window between the
 * last 7 / 30 / 90 days and all time.
 *
 * Intentionally spreadsheet-ish — the goal is "who cost what, per
 * project and per user, exact numbers, no design flourishes that get
 * in the way of scanning the table". Finance-style.
 */
import { useEffect, useMemo, useState } from "react";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";
import { Spinner } from "@/components/atoms/Spinner";

type Totals = {
  runs: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};

type ProjectRow = {
  project_id: string;
  project_name: string;
  runs: number;
  cost_usd: number;
  total_tokens: number;
};

type UserRow = {
  user_id: string | null;
  display_name: string;
  email: string;
  runs: number;
  cost_usd: number;
  total_tokens: number;
};

type ModelRow = {
  model: string;
  runs: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};

type UsageResponse = {
  range: string;
  since: number;
  totals: Totals;
  perProject: ProjectRow[];
  perUser: UserRow[];
  perModel: ModelRow[];
};

type Range = "7d" | "30d" | "90d" | "all";

function formatUsd(n: number): string {
  // Human-scale currency: show at least 2 fractional digits for small
  // values so sub-cent runs don't disappear into "$0.00". Small costs
  // are still useful as a relative comparison across projects.
  if (!Number.isFinite(n)) return "—";
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(5)}`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function UsageTab() {
  const { t } = useT();
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await apiJson<UsageResponse>(`/api/admin/usage?range=${range}`);
        if (!cancelled) setData(r);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  const totals = data?.totals;
  const rangeOptions: { id: Range; label: string }[] = useMemo(
    () => [
      { id: "7d", label: t("usage.range7d") },
      { id: "30d", label: t("usage.range30d") },
      { id: "90d", label: t("usage.range90d") },
      { id: "all", label: t("usage.rangeAll") },
    ],
    [t],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          {t("instanceSettings.tabUsage")}
        </h2>
        <div className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-white p-0.5 shadow-sm">
          {rangeOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setRange(opt.id)}
              className={cn(
                "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                range === opt.id
                  ? "bg-neutral-900 text-white shadow-sm"
                  : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center py-12">
          <Spinner className="size-5" />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">
          {error}
        </div>
      )}

      {data && totals && (
        <>
          {/* Totals cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label={t("usage.statCost")} value={formatUsd(totals.cost_usd)} emphasis />
            <StatCard label={t("usage.statRuns")} value={String(totals.runs)} />
            <StatCard
              label={t("usage.statInputTokens")}
              value={formatTokens(totals.input_tokens)}
              subValue={`${formatTokens(totals.cache_read_tokens)} ${t("usage.cachedSuffix")}`}
            />
            <StatCard label={t("usage.statOutputTokens")} value={formatTokens(totals.output_tokens)} />
          </div>

          {/* Per-project table */}
          <Section title={t("usage.sectionPerProject")}>
            <Table
              headers={[
                t("usage.colProject"),
                t("usage.colRuns"),
                t("usage.colTokens"),
                t("usage.colCost"),
              ]}
              rows={data.perProject.map((p) => [
                <span key="n" className="font-medium text-neutral-900">
                  {p.project_name}
                </span>,
                <span key="r">{p.runs}</span>,
                <span key="t" className="tabular-nums">
                  {formatTokens(p.total_tokens)}
                </span>,
                <span key="c" className="tabular-nums font-medium">
                  {formatUsd(p.cost_usd)}
                </span>,
              ])}
              emptyMessage={t("usage.empty")}
            />
          </Section>

          {/* Per-user table */}
          <Section title={t("usage.sectionPerUser")}>
            <Table
              headers={[
                t("usage.colUser"),
                t("usage.colRuns"),
                t("usage.colTokens"),
                t("usage.colCost"),
              ]}
              rows={data.perUser.map((u) => [
                <div key="n" className="min-w-0">
                  <p className="truncate font-medium text-neutral-900">{u.display_name}</p>
                  {u.email && u.email !== u.display_name && (
                    <p className="truncate text-[11px] text-neutral-500">{u.email}</p>
                  )}
                </div>,
                <span key="r">{u.runs}</span>,
                <span key="t" className="tabular-nums">
                  {formatTokens(u.total_tokens)}
                </span>,
                <span key="c" className="tabular-nums font-medium">
                  {formatUsd(u.cost_usd)}
                </span>,
              ])}
              emptyMessage={t("usage.empty")}
            />
          </Section>

          {/* Per-model table */}
          <Section title={t("usage.sectionPerModel")}>
            <Table
              headers={[
                t("usage.colModel"),
                t("usage.colRuns"),
                t("usage.colInput"),
                t("usage.colOutput"),
                t("usage.colCache"),
                t("usage.colCost"),
              ]}
              rows={data.perModel.map((m) => [
                <span key="n" className="font-mono text-[11px] text-neutral-700">
                  {m.model}
                </span>,
                <span key="r">{m.runs}</span>,
                <span key="i" className="tabular-nums">
                  {formatTokens(m.input_tokens)}
                </span>,
                <span key="o" className="tabular-nums">
                  {formatTokens(m.output_tokens)}
                </span>,
                <span key="ca" className="tabular-nums text-neutral-500">
                  {formatTokens(m.cache_read_tokens + m.cache_creation_tokens)}
                </span>,
                <span key="c" className="tabular-nums font-medium">
                  {formatUsd(m.cost_usd)}
                </span>,
              ])}
              emptyMessage={t("usage.empty")}
            />
          </Section>

          <p className="text-[11px] leading-snug text-neutral-400">
            {t("usage.footnote")}
          </p>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  subValue,
  emphasis,
}: {
  label: string;
  value: string;
  subValue?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        emphasis ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white",
      )}
    >
      <p
        className={cn(
          "text-[10px] font-semibold uppercase tracking-wider",
          emphasis ? "text-white/60" : "text-neutral-500",
        )}
      >
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums tracking-tight",
          emphasis ? "text-white" : "text-neutral-900",
        )}
      >
        {value}
      </p>
      {subValue && (
        <p
          className={cn(
            "mt-0.5 text-[11px]",
            emphasis ? "text-white/70" : "text-neutral-500",
          )}
        >
          {subValue}
        </p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Table({
  headers,
  rows,
  emptyMessage,
}: {
  headers: string[];
  rows: React.ReactNode[][];
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-200 bg-neutral-50 px-4 py-8 text-center text-[12px] text-neutral-400">
        {emptyMessage}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-neutral-50/60 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          <tr>
            {headers.map((h, i) => (
              <th
                key={h}
                className={cn(
                  "px-3 py-2 text-left",
                  i === headers.length - 1 && "text-right",
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr
              key={i}
              className="border-t border-neutral-100 transition-colors hover:bg-neutral-50/60"
            >
              {cells.map((cell, j) => (
                <td
                  key={j}
                  className={cn(
                    "px-3 py-2 align-top text-neutral-800",
                    j === cells.length - 1 && "text-right",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
