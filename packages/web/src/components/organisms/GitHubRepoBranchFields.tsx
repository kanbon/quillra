import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { GithubRepoRow } from "@/lib/github";
import { parseRepoFullName, selectLikeInputClassName } from "@/lib/github";
import { apiJson } from "@/lib/api";

type BranchPayload = { branches: string[]; defaultBranch: string };

type Props = {
  repoFullName: string;
  onRepoChange: (fullName: string, defaultBranchHint: string) => void;
  branch: string;
  onBranchChange: (branch: string) => void;
  disabled?: boolean;
  /** User chose manual entry even when API works */
  preferManual: boolean;
  setPreferManual: (v: boolean) => void;
};

export function GitHubRepoBranchFields({
  repoFullName,
  onRepoChange,
  branch,
  onBranchChange,
  disabled,
  preferManual,
  setPreferManual,
}: Props) {
  const reposQ = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => apiJson<{ repos: GithubRepoRow[] }>("/api/github/repos"),
    retry: false,
  });

  const parsed = useMemo(() => parseRepoFullName(repoFullName), [repoFullName]);

  const branchesQ = useQuery({
    queryKey: ["github-branches", repoFullName],
    queryFn: async () => {
      const p = parseRepoFullName(repoFullName);
      if (!p) throw new Error("Invalid repo");
      return apiJson<BranchPayload>(
        `/api/github/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/branches`,
      );
    },
    enabled: !!parsed && !preferManual && reposQ.isSuccess && !reposQ.isError,
    retry: false,
  });

  const repos = reposQ.data?.repos ?? [];
  const branches = branchesQ.data?.branches ?? [];
  const apiDefault = branchesQ.data?.defaultBranch;

  useEffect(() => {
    if (preferManual || !branches.length) return;
    if (branches.includes(branch)) return;
    const next = apiDefault && branches.includes(apiDefault) ? apiDefault : branches[0];
    if (next) onBranchChange(next);
  }, [preferManual, branches, branch, apiDefault, onBranchChange]);

  const useManual =
    preferManual ||
    (reposQ.isFetched && (reposQ.isError || repos.length === 0));

  if (useManual) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-1">
          <label className="mb-1 block text-xs font-medium text-neutral-600">GitHub repository</label>
          <input
            className={selectLikeInputClassName()}
            placeholder="owner/repo"
            value={repoFullName}
            onChange={(e) => onRepoChange(e.target.value.trim(), branch || "main")}
            disabled={disabled}
          />
          {reposQ.isError ? (
            <p className="mt-1 text-xs text-neutral-500">
              API unavailable (check server <code className="rounded bg-neutral-100 px-1">GITHUB_TOKEN</code>).
            </p>
          ) : null}
          {reposQ.isSuccess && repos.length === 0 ? (
            <p className="mt-1 text-xs text-neutral-500">No repositories returned for this token.</p>
          ) : null}
        </div>
        <div className="sm:col-span-1">
          <label className="mb-1 block text-xs font-medium text-neutral-600">Branch</label>
          <input
            className={selectLikeInputClassName()}
            placeholder="main"
            value={branch}
            onChange={(e) => onBranchChange(e.target.value.trim())}
            disabled={disabled}
          />
        </div>
        {!preferManual && reposQ.isSuccess && repos.length > 0 ? (
          <div className="sm:col-span-2">
            <button
              type="button"
              className="text-xs text-brand underline-offset-2 hover:underline"
              onClick={() => setPreferManual(false)}
            >
              Use list picker instead
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs font-medium text-neutral-600">GitHub repository</label>
        <select
          className={selectLikeInputClassName()}
          value={repoFullName}
          disabled={disabled || reposQ.isLoading}
          onChange={(e) => {
            const v = e.target.value;
            const row = repos.find((r) => r.fullName === v);
            onRepoChange(v, row?.defaultBranch ?? "main");
          }}
        >
          <option value="">Select repository…</option>
          {repos.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.fullName}
            </option>
          ))}
        </select>
        <div className="mt-1">
          <button
            type="button"
            className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline"
            onClick={() => setPreferManual(true)}
          >
            Enter owner/repo manually
          </button>
        </div>
      </div>
      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs font-medium text-neutral-600">Branch</label>
        {repoFullName && branchesQ.isError ? (
          <>
            <input
              className={selectLikeInputClassName()}
              placeholder="main"
              value={branch}
              onChange={(e) => onBranchChange(e.target.value.trim())}
              disabled={disabled}
            />
            <p className="mt-1 text-xs text-neutral-500">
              Type the branch name (API could not list branches).
            </p>
          </>
        ) : (
          <select
            className={selectLikeInputClassName()}
            value={branch}
            disabled={disabled || !repoFullName || branchesQ.isLoading}
            onChange={(e) => onBranchChange(e.target.value)}
          >
            {!branches.length && repoFullName && branchesQ.isLoading ? (
              <option value="">Loading branches…</option>
            ) : null}
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
                {b === apiDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
