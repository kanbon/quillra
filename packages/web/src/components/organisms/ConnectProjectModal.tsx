import { Input } from "@/components/atoms/Input";
import { Modal } from "@/components/atoms/Modal";
import { Textarea } from "@/components/atoms/Textarea";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

type GitHubRepo = { fullName: string; defaultBranch: string };

type FrameworkSummary = {
  id: string;
  label: string;
  iconSlug: string;
  color: string;
  blurb: string;
  optimizes: boolean;
};

type FrameworkCheckResult =
  | { supported: true; framework: FrameworkSummary }
  | { supported: false; reason: string; rootFilesSample?: string[] };

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
};

type Step = "repo" | "framework" | "name";

/**
 * Two-step (well, three-screen) connect flow:
 *
 *   1. Pick a repository + branch.
 *   2. Quillra inspects the repo via the GitHub API and shows the
 *      detected framework with its logo and a friendly description,
 *      OR a clear "we don't support this yet" message.
 *   3. Confirm display name + advanced (collapsed by default), submit.
 */
export function ConnectProjectModal({ open, onClose, onCreated }: Props) {
  const { t } = useT();
  const [step, setStep] = useState<Step>("repo");
  const [search, setSearch] = useState("");
  const [pickedRepo, setPickedRepo] = useState<GitHubRepo | null>(null);
  const [branch, setBranch] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualRepo, setManualRepo] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [previewCmd, setPreviewCmd] = useState("");
  const [convertToAstro, setConvertToAstro] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setStep("repo");
    setSearch("");
    setPickedRepo(null);
    setBranch("");
    setManualMode(false);
    setManualRepo("");
    setName("");
    setNameTouched(false);
    setShowAdvanced(false);
    setPreviewCmd("");
    setConvertToAstro(false);
    setSubmitting(false);
    setError(null);
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

  const repoApiUnavailable =
    reposQ.isError || (reposQ.isSuccess && (reposQ.data?.repos?.length ?? 0) === 0);
  useEffect(() => {
    if (repoApiUnavailable) setManualMode(true);
  }, [repoApiUnavailable]);

  const effectiveRepoFull = manualMode ? manualRepo.trim() : (pickedRepo?.fullName ?? "");
  const repoValid = /^[\w.-]+\/[\w.-]+$/.test(effectiveRepoFull);
  const canContinueRepo = repoValid && branch.trim().length > 0;

  // Framework check (only runs once we're on the framework step)
  const fwQ = useQuery({
    queryKey: ["framework-check", effectiveRepoFull, branch],
    queryFn: async () => {
      const [owner, repo] = effectiveRepoFull.split("/");
      return apiJson<FrameworkCheckResult>(
        `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/framework?ref=${encodeURIComponent(branch)}`,
      );
    },
    enabled: open && step === "framework" && canContinueRepo,
    retry: false,
  });

  async function handleSubmit() {
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
          migrationTarget: convertToAstro ? "astro" : null,
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
      {/* Header */}
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
            {t("dashboard.connectAnother")}
          </h2>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            {step === "repo" && "Pick a repository and branch."}
            {step === "framework" && "We're checking what framework your site uses."}
            {step === "name" && "Almost done, give it a name."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => !submitting && onClose()}
          className="-mr-2 -mt-1 flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          aria-label={t("common.close")}
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Steps indicator */}
      <div className="mb-5 flex items-center gap-2">
        {(["repo", "framework", "name"] as const).map((s, i) => {
          const order: Record<Step, number> = { repo: 0, framework: 1, name: 2 };
          const isActive = s === step;
          const isDone = order[s] < order[step];
          return (
            <div key={s} className="flex flex-1 items-center gap-2">
              <div
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors",
                  isDone
                    ? "bg-green-500 text-white"
                    : isActive
                      ? "bg-neutral-900 text-white"
                      : "bg-neutral-100 text-neutral-400",
                )}
              >
                {isDone ? (
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={cn(
                  "text-[12px] font-medium",
                  isActive ? "text-neutral-900" : "text-neutral-400",
                )}
              >
                {s === "repo" ? "Repository" : s === "framework" ? "Framework" : "Name"}
              </span>
              {i < 2 && <div className="h-px flex-1 bg-neutral-200" />}
            </div>
          );
        })}
      </div>

      {/* STEP 1, repo + branch */}
      {step === "repo" && (
        <div className="space-y-5">
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
                  <svg
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.8}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z"
                    />
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
                          <div
                            className="h-3 flex-1 rounded bg-neutral-200"
                            style={{
                              animation: `pulse 1.4s ease-in-out ${i * 0.1}s infinite`,
                              maxWidth: `${50 + (i % 3) * 15}%`,
                            }}
                          />
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
                              <svg
                                className="h-3.5 w-3.5 shrink-0 text-neutral-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.8}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                                />
                              </svg>
                              <span className="min-w-0 truncate">{r.fullName}</span>
                              {active && (
                                <svg
                                  className="ml-auto h-4 w-4 shrink-0"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  strokeWidth={2.5}
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M5 13l4 4L19 7"
                                  />
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

          {(repoValid || (manualMode && manualRepo)) && (
            <section>
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
                <div className="flex items-center gap-2.5 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />
                  <span className="text-sm text-neutral-500">Loading branches…</span>
                </div>
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
            </section>
          )}
        </div>
      )}

      {/* STEP 2, framework check */}
      {step === "framework" && (
        <div className="min-h-[220px]">
          {fwQ.isLoading && (
            <div className="flex flex-col items-center justify-center gap-4 py-10">
              <div className="relative h-14 w-14">
                <div className="absolute inset-0 rounded-full border-2 border-neutral-200" />
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-neutral-900" />
              </div>
              <p className="text-sm text-neutral-500">
                Inspecting <span className="font-mono text-neutral-700">{effectiveRepoFull}</span>…
              </p>
              <p className="text-xs text-neutral-400">
                Reading <code className="rounded bg-neutral-100 px-1 font-mono">package.json</code>{" "}
                on <strong>{branch}</strong>
              </p>
            </div>
          )}
          {fwQ.isError && (
            <div className="rounded-2xl border border-red-200 bg-red-50/60 p-5 text-sm text-red-700">
              <p className="font-medium">Couldn't inspect this repository.</p>
              <p className="mt-1 text-red-600/80">
                {(fwQ.error as Error)?.message ?? "Unknown error"}
              </p>
              <button
                type="button"
                onClick={() => void fwQ.refetch()}
                className="mt-3 inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2.5 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-50"
              >
                <svg
                  className="h-3 w-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 4v6h6M20 20v-6h-6M5.5 9A8 8 0 0118 8.5M18.5 15A8 8 0 016 15.5"
                  />
                </svg>
                Retry
              </button>
            </div>
          )}
          {fwQ.data && !fwQ.isLoading && (
            <>
              {fwQ.data.supported ? (
                <div className="rounded-2xl border border-neutral-200 bg-gradient-to-br from-neutral-50 to-white p-6">
                  <div className="flex items-start gap-4">
                    <div
                      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl shadow-sm ring-1 ring-black/5"
                      style={{ backgroundColor: fwQ.data.framework.color }}
                    >
                      <img
                        src={`https://cdn.simpleicons.org/${fwQ.data.framework.iconSlug}/ffffff`}
                        alt={fwQ.data.framework.label}
                        width={28}
                        height={28}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-[18px] font-semibold tracking-tight text-neutral-900">
                          {fwQ.data.framework.label}
                        </h3>
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700">
                          Supported
                        </span>
                      </div>
                      <p className="mt-1 text-[13px] leading-relaxed text-neutral-600">
                        {fwQ.data.framework.blurb}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <span className="rounded-md bg-white px-2 py-0.5 text-[10px] font-medium text-neutral-600 ring-1 ring-neutral-200">
                          Live preview
                        </span>
                        <span className="rounded-md bg-white px-2 py-0.5 text-[10px] font-medium text-neutral-600 ring-1 ring-neutral-200">
                          Image upload
                        </span>
                        {fwQ.data.framework.optimizes && (
                          <span className="rounded-md bg-white px-2 py-0.5 text-[10px] font-medium text-neutral-600 ring-1 ring-neutral-200">
                            Auto image optimization
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-6">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                      <svg
                        className="h-5 w-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.8}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[15px] font-semibold text-amber-900">
                        Framework not supported
                      </h3>
                      <p className="mt-1 text-[13px] leading-relaxed text-amber-800/80">
                        {fwQ.data.reason}
                      </p>
                      <p className="mt-2 text-[11px] text-amber-700/80">
                        Quillra currently supports Astro, Next.js, Nuxt, Gatsby, SvelteKit, Remix,
                        Eleventy, Vite, React (CRA), Docusaurus, VitePress, Qwik, SolidStart, Hugo,
                        and Jekyll. You can still connect the project by passing a custom dev
                        command under Advanced on the next step.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              <div className="mt-3 text-right">
                <button
                  type="button"
                  onClick={() => void fwQ.refetch()}
                  disabled={fwQ.isFetching}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-50"
                >
                  <svg
                    className={cn("h-3 w-3", fwQ.isFetching && "animate-spin")}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 4v6h6M20 20v-6h-6M5.5 9A8 8 0 0118 8.5M18.5 15A8 8 0 016 15.5"
                    />
                  </svg>
                  Re-check
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* STEP 3, name + advanced */}
      {step === "name" && (
        <div className="space-y-5">
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
              autoFocus
            />
          </div>

          {/*
            Convert-to-Astro card. Shown only when the detected framework
            is NOT already Astro or Next.js, those two work natively
            with Quillra, so migration would be a no-op. Subtle: muted
            border by default, Astro logo tile + a native-looking
            switch. Activating it flips a flag on the project row and
            the Editor auto-kicks off a migration agent on first open.
          */}
          {fwQ.data?.supported &&
            fwQ.data.framework.id !== "astro" &&
            fwQ.data.framework.id !== "next" && (
              <label
                className={cn(
                  "relative block cursor-pointer overflow-hidden rounded-xl border p-4 transition-colors",
                  convertToAstro
                    ? "border-[#FF5D01] bg-gradient-to-br from-[#FF5D01]/10 via-[#FF5D01]/5 to-transparent"
                    : "border-neutral-200 bg-white hover:border-neutral-300",
                )}
              >
                {/* Subtle Astro-branded background accent when toggled on */}
                {convertToAstro && (
                  <div
                    className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-[#FF5D01] opacity-[0.06] blur-3xl"
                    aria-hidden
                  />
                )}
                <div className="relative flex items-start gap-3">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: "#FF5D01" }}
                  >
                    <img
                      src="https://cdn.simpleicons.org/astro/ffffff"
                      alt="Astro"
                      width={20}
                      height={20}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold text-neutral-900">
                      {t("astroMigration.toggleTitle")}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-snug text-neutral-500">
                      {t("astroMigration.toggleHelp")}
                    </p>
                  </div>
                  <div className="shrink-0 pt-0.5">
                    <input
                      type="checkbox"
                      checked={convertToAstro}
                      onChange={(e) => setConvertToAstro(e.target.checked)}
                      disabled={submitting}
                      className="sr-only"
                    />
                    <span
                      aria-hidden
                      className={cn(
                        "block h-6 w-10 rounded-full transition-colors",
                        convertToAstro ? "bg-[#FF5D01]" : "bg-neutral-300",
                      )}
                    >
                      <span
                        className={cn(
                          "block h-5 w-5 translate-y-0.5 rounded-full bg-white shadow-sm transition-transform",
                          convertToAstro ? "translate-x-[22px]" : "translate-x-0.5",
                        )}
                      />
                    </span>
                  </div>
                </div>
              </label>
            )}
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
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {/* Footer actions */}
      <div className="mt-6 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            if (step === "framework") setStep("repo");
            else if (step === "name") setStep("framework");
            else if (!submitting) onClose();
          }}
          disabled={submitting}
          className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50"
        >
          {step === "repo" ? t("common.cancel") : "Back"}
        </button>

        {step === "repo" && (
          <button
            type="button"
            onClick={() => setStep("framework")}
            disabled={!canContinueRepo}
            className={cn(
              "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm transition-all",
              canContinueRepo ? "hover:bg-brand/90 hover:shadow" : "cursor-not-allowed opacity-50",
            )}
          >
            Continue
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
        {step === "framework" && (
          <button
            type="button"
            onClick={() => setStep("name")}
            disabled={!fwQ.data}
            className={cn(
              "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm transition-all",
              fwQ.data ? "hover:bg-brand/90 hover:shadow" : "cursor-not-allowed opacity-50",
            )}
          >
            Continue
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
        {step === "name" && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || name.trim().length === 0}
            className={cn(
              "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm transition-all",
              !submitting && name.trim().length > 0
                ? "hover:bg-brand/90 hover:shadow"
                : "cursor-not-allowed opacity-50",
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
        )}
      </div>
    </Modal>
  );
}
