/**
 * Per-user usage drill-down modal. Fetches a 12-month (or configurable)
 * breakdown for one user and renders it as a stacked bar chart plus
 * three raw tables (monthly / per-project / per-model). Opens from a
 * clickable row in the main Usage tab.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Modal } from "@/components/atoms/Modal";
import { Spinner } from "@/components/atoms/Spinner";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Months = 3 | 6 | 12 | 24;

type DetailResponse = {
  user: { id: string; displayName: string; email: string };
  since: number;
  months: number;
  monthly: Array<{
    month: string;
    runs: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  }>;
  perProject: Array<{ project_id: string; project_name: string; runs: number; cost_usd: number }>;
  perModel: Array<{
    model: string;
    runs: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  }>;
  totals: {
    runs: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
};

function formatUsd(n: number): string {
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

function formatMonth(ymd: string): string {
  const [y, m] = ymd.split("-").map((s) => parseInt(s, 10));
  if (!y || !m) return ymd;
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

export function UserUsageDetail({
  userId,
  userName,
  onClose,
}: {
  userId: string;
  userName: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [months, setMonths] = useState<Months>(12);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await apiJson<DetailResponse>(
          `/api/admin/usage/users/${userId}?months=${months}`,
        );
        if (!cancelled) setData(r);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, months]);

  const chartData = useMemo(
    () =>
      (data?.monthly ?? []).map((m) => ({
        month: formatMonth(m.month),
        rawMonth: m.month,
        cost: Number(m.cost_usd.toFixed(4)),
        runs: m.runs,
      })),
    [data],
  );

  const rangeOptions: Array<{ id: Months; label: string }> = [
    { id: 3, label: t("usage.drillRange3") },
    { id: 6, label: t("usage.drillRange6") },
    { id: 12, label: t("usage.drillRange12") },
    { id: 24, label: t("usage.drillRange24") },
  ];

  return (
    <Modal open onClose={onClose} className="max-w-5xl p-0">
      <div className="flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl bg-white">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-100 px-6 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold tracking-tight text-neutral-900">
              {t("usage.drillTitle", { name: userName })}
            </h2>
            {data && (
              <p className="mt-0.5 text-[12px] text-neutral-500">
                {data.user.email} · {data.totals.runs} tasks · {formatUsd(data.totals.cost_usd)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-white p-0.5">
            {rangeOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setMonths(opt.id)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                  months === opt.id
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-600 hover:bg-neutral-100",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md px-2 py-1 text-[12px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
          >
            {t("usage.drillClose")}
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && !data && (
            <div className="flex items-center justify-center py-16">
              <Spinner className="size-5" />
            </div>
          )}

          {data && (
            <>
              <section className="mb-6">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  {t("usage.drillChartTitle")}
                </h3>
                <div className="h-72 rounded-xl border border-neutral-200 bg-white p-3">
                  {chartData.length === 0 ? (
                    <EmptyBox message={t("usage.drillEmpty")} />
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
                        <CartesianGrid stroke="#f1f1f1" vertical={false} />
                        <XAxis
                          dataKey="month"
                          tick={{ fontSize: 11, fill: "#737373" }}
                          axisLine={{ stroke: "#e5e5e5" }}
                          tickLine={false}
                        />
                        <YAxis
                          tickFormatter={(n: number) => formatUsd(n)}
                          tick={{ fontSize: 11, fill: "#737373" }}
                          axisLine={{ stroke: "#e5e5e5" }}
                          tickLine={false}
                        />
                        <Tooltip
                          cursor={{ fill: "rgba(23,23,23,0.04)" }}
                          contentStyle={{
                            fontSize: 12,
                            borderRadius: 8,
                            border: "1px solid #e5e5e5",
                          }}
                          formatter={(v) => [formatUsd(Number(v)), t("usage.drillColCost")]}
                        />
                        <Bar dataKey="cost" radius={[6, 6, 0, 0]}>
                          {chartData.map((_, i) => (
                            <Cell key={i} fill="#C1121F" />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </section>

              <section className="mb-6">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  {t("usage.drillMonthly")}
                </h3>
                <BreakdownTable
                  headers={[
                    t("usage.drillColMonth"),
                    t("usage.drillColRuns"),
                    t("usage.drillColInput"),
                    t("usage.drillColOutput"),
                    t("usage.drillColCost"),
                  ]}
                  rows={data.monthly.map((m) => [
                    formatMonth(m.month),
                    String(m.runs),
                    formatTokens(m.input_tokens),
                    formatTokens(m.output_tokens),
                    formatUsd(m.cost_usd),
                  ])}
                  emptyMessage={t("usage.drillEmpty")}
                />
              </section>

              <section className="mb-6">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  {t("usage.drillPerProject")}
                </h3>
                <BreakdownTable
                  headers={[t("usage.colProject"), t("usage.colRuns"), t("usage.colCost")]}
                  rows={data.perProject.map((p) => [p.project_name, String(p.runs), formatUsd(p.cost_usd)])}
                  emptyMessage={t("usage.drillEmpty")}
                />
              </section>

              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  {t("usage.drillPerModel")}
                </h3>
                <BreakdownTable
                  headers={[
                    t("usage.colModel"),
                    t("usage.colRuns"),
                    t("usage.drillColInput"),
                    t("usage.drillColOutput"),
                    t("usage.drillColCost"),
                  ]}
                  rows={data.perModel.map((m) => [
                    m.model,
                    String(m.runs),
                    formatTokens(m.input_tokens),
                    formatTokens(m.output_tokens),
                    formatUsd(m.cost_usd),
                  ])}
                  emptyMessage={t("usage.drillEmpty")}
                />
              </section>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function EmptyBox({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center text-[12px] text-neutral-400">
      {message}
    </div>
  );
}

function BreakdownTable({
  headers,
  rows,
  emptyMessage,
}: {
  headers: string[];
  rows: string[][];
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-200 bg-neutral-50 px-4 py-6 text-center text-[12px] text-neutral-400">
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
                className={cn("px-3 py-2 text-left", i !== 0 && "text-right")}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-neutral-100">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={cn(
                    "px-3 py-2 text-neutral-800",
                    j !== 0 && "text-right tabular-nums",
                    j === row.length - 1 && "font-medium",
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
