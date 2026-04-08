import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "@/components/atoms/Modal";
import { Input } from "@/components/atoms/Input";
import { Textarea } from "@/components/atoms/Textarea";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type GitHubRepo = { fullName: string; defaultBranch: string };

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
};

/**
 * Redesigned project-connection modal. Single screen, scannable layout:
 *  - Repo picker (searchable list, skeleton while loading, manual fallback)
 *  - Branch (auto-loaded from the picked repo)
 *  - Display name (auto-derived, editable)
 *  - Advanced (collapsed): custom dev preview command
 */
export function ConnectProjectModal({ open, onClose, onCreated }: Props) {
  const { t } = useT();
  const [search, setSearch] = useState("");
  const [pickedRepo, setPickedRepo] = useState<GitHubRepo | null>(null);
  const [branch, setBranch] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [previewCmd, setPreviewCmd] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualRepo, setManualRepo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setSearch("");
      setPickedRepo(null);
      setBranch("");
      setName("");
      setNameTouched(false);
      setShowAdvanced(false);
      setPreviewCmd("");
      setManualMode(false);
      setManualRepo("");
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  const reposQ = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => apiJson<{ repos: GitHubRepo[] }>("/api/github/repos"),
    enabled: open,
    retry: false,
  });

  const branchesQ = useQuery({
    queryKey: ["github-branches", pickedRepo?.fullName],
    queryFn: async () => {
      if (!pickedRepo) throw new Error("no repo");
      const [owner, repo] = pickedRepo.fullName.split("/");
      return apiJson<{ branches: string[]; defaultBranch: string }>(
        `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
      );
    },
    enabled: open && !!pickedRepo && !manualMode,
    retry: false,
  });

  // When repo is picked, default branch + display name
  useEffect(() => {
    if (!pickedRepo) return;
    setBranch(pickedRepo.defaultBranch);
    if (!nameTouched) {
      const repoSlug = pickedRepo.fullName.split("/")[1] ?? pickedRepo.fullName;
      setName(repoSlug);
    }
  }, [pickedRepo, nameTouched]);

  // When branches load, prefer the API-reported default if it's available
  useEffect(() => {
    if (!branchesQ.data) return;
    const apiDefault = branchesQ.data.defaultBranch;
    if (apiDefault && branchesQ.data.branches.includes(apiDefault)) {
      setBranch(apiDefault);
    }
  }, [branchesQ.data]);

  const filteredRepos = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = reposQ.data?.repos ?? [];
    if (!q) return list;
    return list.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [reposQ.data, search]);

  const repoApiUnavailable = reposQ.isError || (reposQ.isSuccess && (reposQ.data?.repos?.length ?? 0) === 0);

  // Auto-flip to manual mode if the API has nothing
  useEffect(() => {
    if (repoApiUnavailable) setManualMode(true);
  }, [repoApiUnavailable]);

  const effectiveRepoFull = manualMode ? manualRepo.trim() : pickedRepo?.fullName ?? "";
  const repoValid = /^[\w.-]+\/[\w.-]+$/.test(effectiveRepoFull);
  const canSubmit =
    repoValid && branch.trim().length > 0 && name.trim().length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiJson("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          githubRepoFullName: effectiveRepoFull,
          defaultBranch: branch.trim(),
          previewDevCommand: previewCmd.trim() || null,
        }),
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={() => !submitting && onClose()} className="max-w-2xl">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-neutral-900">{t("dashboard.connectAnother")}</h2>
          <p className="mt-0.5 text-[13px] text-neutral-500">{t("dashboard.connectAnotherDescription")}</p>
        </div>
        <button
          type="button"
          onClick={() => !submitting && onClose()}
          className="-mr-2 -mt-1 flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          aria-label={t("common.close")}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="space-y-5">
        {/* Repo picker */}
        <section>
          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
            {t("github.repository")}
          </label>

          {manualMode ? (
            <>
              <Input
                placeholder={t("github.repoPlaceholder")}
                value={manualRepo}
                onChange={(e) => setManualRepo(e.target.value.trim())}
                disabled={submitting}
              />
              {!repoApiUnavailable && (
                <button
                  type="button"
                  className="mt-1.5 text-xs text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline"
                  onClick={() => setManualMode(false)}
                >
                  {t("github.useListPicker")}
                </button>
              )}
              {repoApiUnavailable && reposQ.isError && (
                <p className="mt-1.5 text-xs text-amber-600">{t("github.apiUnavailable")}</p>
              )}
            </>
          ) : (
            <div className="rounded-xl border border-neutral-200 bg-neutral-50/50">
              <div className="relative">
                <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search your repositories…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="block w-full border-0 bg-transparent py-2.5 pl-9 pr-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-0"
                  disabled={reposQ.isLoading}
                />
              </div>
              <div className="max-h-64 overflow-y-auto border-t border-neutral-200">
                {reposQ.isLoading ? (
                  <ul className="p-2">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <li key={i} className="flex items-center gap-2 px-2 py-2.5">
                        <div className="h-3.5 w-3.5 shrink-0 rounded bg-neutral-200" />
                        <div className="h-3 flex-1 rounded bg-neutral-200" style={{ animation: `pulse 1.4s ease-in-out ${i * 0.1}s infinite`, maxWidth: `${50 + (i % 3) * 15}%` }} />
                      </li>
                    ))}
                  </ul>
                ) : filteredRepos.length === 0 ? (
                  <div className="px-4 py-6 text-center text-xs text-neutral-400">
                    {search ? "No matches" : t("github.noRepos")}
                  </div>
                ) : (
                  <ul>
                    {filteredRepos.map((r) => {
                      const active = pickedRepo?.fullName === r.fullName;
                      return (
                        <li key={r.fullName}>
                          <button
                            type="button"
                            onClick={() => setPickedRepo(r)}
                            className={cn(
                              "flex w-full items-center gap-2.5 border-b border-neutral-100 px-3 py-2.5 text-left text-[13px] transition-colors last:border-b-0",
                              active
                                ? "bg-brand/5 font-medium text-brand"
                                : "text-neutral-700 hover:bg-neutral-100",
                            )}
                          >
                            <svg className="h-3.5 w-3.5 shrink-0 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                            </svg>
                            <span className="min-w-0 truncate">{r.fullName}</span>
                            {active && (
                              <svg className="ml-auto h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <div className="border-t border-neutral-200 px-3 py-2 text-right">
                <button
                  type="button"
                  className="text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline"
                  onClick={() => setManualMode(true)}
                >
                  {t("github.enterManually")}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Branch + Name (only after a repo is picked or manual entry is filled) */}
        {(repoValid || (manualMode && manualRepo)) && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                {t("github.branch")}
              </label>
              {manualMode || branchesQ.isError ? (
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value.trim())}
                  placeholder={t("github.branchPlaceholder")}
                  disabled={submitting}
                />
              ) : branchesQ.isLoading ? (
                <div className="h-[42px] animate-pulse rounded-md border border-neutral-200 bg-neutral-100" />
              ) : (
                <select
                  className="block h-[42px] w-full rounded-md border border-neutral-300 bg-white px-3 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  disabled={submitting}
                >
                  {branchesQ.data?.branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                      {b === branchesQ.data?.defaultBranch ? ` ${t("github.defaultSuffix")}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                {t("connectForm.displayName")}
              </label>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                placeholder={t("connectForm.clientHomepage")}
                disabled={submitting}
              />
            </div>
          </div>
        )}

        {/* Advanced */}
        {(repoValid || (manualMode && manualRepo)) && (
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="flex items-center gap-1.5 text-xs font-medium text-neutral-500 transition-colors hover:text-neutral-800"
            >
              <svg
                className="h-3 w-3 transition-transform"
                style={{ transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)" }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Advanced
            </button>
            {showAdvanced && (
              <div className="mt-3">
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  {t("connectForm.devCommandLabel")}
                </label>
                <Textarea
                  rows={2}
                  value={previewCmd}
                  onChange={(e) => setPreviewCmd(e.target.value)}
                  placeholder={t("connectForm.devCommandPlaceholder")}
                  className="font-mono text-xs"
                  disabled={submitting}
                />
                <p className="mt-1 text-xs text-neutral-500">
                  {t("connectForm.devCommandHelp", { portCode: "{port}" })}
                </p>
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => !submitting && onClose()}
          className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm transition-all",
            canSubmit ? "hover:bg-brand/90 hover:shadow" : "cursor-not-allowed opacity-50",
          )}
        >
          {submitting ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              {t("connectForm.connecting")}
            </>
          ) : (
            t("connectForm.connect")
          )}
        </button>
      </div>
    </Modal>
  );
}
