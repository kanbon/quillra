import { Spinner } from "@/components/atoms/Spinner";
import { UsageLimitsPanel } from "@/components/organisms/instance-settings/UsageLimitsPanel";
import { UserUsageDetail } from "@/components/organisms/instance-settings/UserUsageDetail";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
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
import { useCallback, useEffect, useMemo, useState } from "react";

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
  /** 1 if the user has opted into the monthly usage report email. */
  reports_enabled: number;
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

const ONBOARD_KEY = "quillra:usage-report-onboarded";

export function UsageTab() {
  const { t } = useT();
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drillUser, setDrillUser] = useState<{ id: string; name: string } | null>(null);
  const [onboardDismissed, setOnboardDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(ONBOARD_KEY) === "1";
  });
  const dismissOnboard = () => {
    setOnboardDismissed(true);
    try {
      window.localStorage.setItem(ONBOARD_KEY, "1");
    } catch {
      /* private mode */
    }
  };

  const refetch = useCallback(async () => {
    try {
      const r = await apiJson<UsageResponse>(`/api/admin/usage?range=${range}`);
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }, [range]);

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

  const toggleReports = async (userId: string, enabled: boolean) => {
    // Optimistic flip so the toggle feels instant; refetch reconciles.
    setData((prev) =>
      prev
        ? {
            ...prev,
            perUser: prev.perUser.map((u) =>
              u.user_id === userId ? { ...u, reports_enabled: enabled ? 1 : 0 } : u,
            ),
          }
        : prev,
    );
    try {
      await apiJson(`/api/admin/users/${userId}/preferences`, {
        method: "PATCH",
        body: JSON.stringify({ monthlyUsageReportsEnabled: enabled }),
      });
    } catch {
      await refetch();
    }
  };

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
            <StatCard
              label={t("usage.statOutputTokens")}
              value={formatTokens(totals.output_tokens)}
            />
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

          {/* Per-user table — each row drills into the user detail modal.
              Reports toggle lives in its own column; clicks are stopped so
              toggling doesn't also open the drill-down. */}
          <Section title={t("usage.sectionPerUser")}>
            {!onboardDismissed && (
              <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <p className="text-[13px] font-semibold text-amber-900">
                      {t("usage.reportsOnboardTitle")}
                    </p>
                    <p className="mt-1 text-[12px] leading-relaxed text-amber-800">
                      {t("usage.reportsOnboardBody")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={dismissOnboard}
                    className="shrink-0 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
                  >
                    {t("usage.reportsOnboardDismiss")}
                  </button>
                </div>
              </div>
            )}
            {data.perUser.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-200 bg-neutral-50 px-4 py-8 text-center text-[12px] text-neutral-400">
                {t("usage.empty")}
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
                <table className="w-full border-collapse text-[12px]">
                  <thead className="bg-neutral-50/60 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                    <tr>
                      <th className="px-3 py-2 text-left">{t("usage.colUser")}</th>
                      <th className="px-3 py-2 text-right">{t("usage.colRuns")}</th>
                      <th className="px-3 py-2 text-right">{t("usage.colTokens")}</th>
                      <th className="px-3 py-2 text-right">{t("usage.colCost")}</th>
                      <th className="px-3 py-2 text-right">{t("usage.colReports")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perUser.map((u) => {
                      const uid = u.user_id;
                      const reportsOn = u.reports_enabled > 0;
                      return (
                        <tr
                          key={uid ?? u.email}
                          className={cn(
                            "border-t border-neutral-100 transition-colors",
                            uid && "cursor-pointer hover:bg-neutral-50/60",
                          )}
                          onClick={() => {
                            if (uid) setDrillUser({ id: uid, name: u.display_name });
                          }}
                        >
                          <td className="px-3 py-2 align-top text-neutral-800">
                            <div className="min-w-0">
                              <p className="truncate font-medium text-neutral-900">
                                {u.display_name}
                              </p>
                              {u.email && u.email !== u.display_name && (
                                <p className="truncate text-[11px] text-neutral-500">{u.email}</p>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-neutral-800">
                            {u.runs}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-neutral-800">
                            {formatTokens(u.total_tokens)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-neutral-900">
                            {formatUsd(u.cost_usd)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {uid ? (
                              <button
                                type="button"
                                role="switch"
                                aria-checked={reportsOn}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void toggleReports(uid, !reportsOn);
                                }}
                                className={cn(
                                  "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
                                  reportsOn
                                    ? "border-emerald-600 bg-emerald-500"
                                    : "border-neutral-300 bg-neutral-200",
                                )}
                                title={
                                  reportsOn ? t("usage.reportsEnabled") : t("usage.reportsDisabled")
                                }
                              >
                                <span
                                  className={cn(
                                    "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
                                    reportsOn ? "translate-x-4" : "translate-x-0.5",
                                  )}
                                />
                              </button>
                            ) : (
                              <span className="text-neutral-300">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
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

          <p className="text-[11px] leading-snug text-neutral-400">{t("usage.footnote")}</p>

          <UsageLimitsPanel
            users={data.perUser
              .filter((u): u is UserRow & { user_id: string } => Boolean(u.user_id))
              .map((u) => ({ id: u.user_id, name: u.display_name, email: u.email }))}
          />
        </>
      )}

      {drillUser && (
        <UserUsageDetail
          userId={drillUser.id}
          userName={drillUser.name}
          onClose={() => setDrillUser(null)}
        />
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
        <p className={cn("mt-0.5 text-[11px]", emphasis ? "text-white/70" : "text-neutral-500")}>
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
                className={cn("px-3 py-2 text-left", i === headers.length - 1 && "text-right")}
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
