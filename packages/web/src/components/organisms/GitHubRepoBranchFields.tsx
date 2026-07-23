import { useGitHubRepositories } from "@/hooks/useGitHubRepositories";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import type { GithubRepoRow } from "@/lib/github";
import {
  githubConnectUrl,
  isGitHubConnectionRequired,
  parseRepoFullName,
  selectLikeInputClassName,
} from "@/lib/github";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo } from "react";

type BranchPayload = { branches: string[]; defaultBranch: string };

type Props = {
  repositoryId: string | null;
  installationId: string | null;
  repoFullName: string;
  onRepoChange: (repo: GithubRepoRow) => void;
  branch: string;
  onBranchChange: (branch: string) => void;
  disabled?: boolean;
};

export function GitHubRepoBranchFields({
  repositoryId,
  installationId,
  repoFullName,
  onRepoChange,
  branch,
  onBranchChange,
  disabled,
}: Props) {
  const { t } = useT();
  const fieldId = useId();
  const repositoryFieldId = `${fieldId}-repository`;
  const branchId = `${fieldId}-branch`;
  const { userId, connectionQ, reposQ, disconnect, connectionRequired, connectUrl } =
    useGitHubRepositories();

  const parsed = useMemo(() => parseRepoFullName(repoFullName), [repoFullName]);
  const repos = reposQ.data?.repos ?? [];
  const selectedRepo =
    repositoryId && installationId
      ? repos.find(
          (repo) => repo.repositoryId === repositoryId && repo.installationId === installationId,
        )
      : undefined;

  const branchesQ = useQuery({
    queryKey: ["github-branches", userId, installationId, repositoryId],
    queryFn: async () => {
      if (!parsed) throw new Error("Invalid repo");
      return apiJson<BranchPayload>(
        `/api/github/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/branches`,
      );
    },
    enabled: !!parsed && !!selectedRepo && !connectionRequired,
    retry: false,
  });

  const branches = branchesQ.data?.branches ?? [];
  const apiDefault = branchesQ.data?.defaultBranch;
  const branchConnectionRequired = isGitHubConnectionRequired(branchesQ.error);
  const needsConnection = connectionRequired || branchConnectionRequired;

  useEffect(() => {
    if (!branches.length || branches.includes(branch)) return;
    const next = apiDefault && branches.includes(apiDefault) ? apiDefault : branches[0];
    if (next) onBranchChange(next);
  }, [branches, branch, apiDefault, onBranchChange]);

  if (needsConnection) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
        <p className="text-sm font-medium text-neutral-900">{t("github.connectTitle")}</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          {t("github.connectSettingsDescription", { repo: repoFullName })}
        </p>
        <button
          type="button"
          className="mt-3 inline-flex h-9 items-center rounded-lg bg-neutral-900 px-4 text-xs font-semibold text-white transition-colors hover:bg-neutral-800"
          onClick={() =>
            window.location.assign(
              branchConnectionRequired ? githubConnectUrl(branchesQ.error) : connectUrl,
            )
          }
        >
          {t("github.connect")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {connectionQ.data?.connected && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
          <span>
            {connectionQ.data.githubLogin
              ? t("github.connectedAs", { login: connectionQ.data.githubLogin })
              : t("github.connected")}
          </span>
          <button
            type="button"
            className="shrink-0 text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline disabled:opacity-50"
            disabled={disabled || disconnect.isPending}
            onClick={() => {
              if (!window.confirm(t("github.disconnectConfirm"))) return;
              disconnect.mutate();
            }}
          >
            {disconnect.isPending ? t("github.disconnecting") : t("github.disconnect")}
          </button>
        </div>
      )}

      {reposQ.isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50/60 p-3 text-xs text-red-700">
          <p>{reposQ.error.message}</p>
          <button
            type="button"
            className="mt-2 font-medium underline underline-offset-2"
            onClick={() => void reposQ.refetch()}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor={repositoryFieldId}
              className="mb-1 block text-xs font-medium text-neutral-600"
            >
              {t("github.repository")}
            </label>
            <select
              id={repositoryFieldId}
              className={selectLikeInputClassName()}
              value={selectedRepo?.repositoryId ?? (repoFullName ? "__current" : "")}
              disabled={disabled || reposQ.isLoading}
              onChange={(event) => {
                const repo = repos.find((item) => item.repositoryId === event.target.value);
                if (repo) onRepoChange(repo);
              }}
            >
              {!repoFullName && <option value="">{t("github.selectRepo")}</option>}
              {!selectedRepo && repoFullName && (
                <option value="__current" disabled>
                  {repoFullName} {t("github.currentUnavailableSuffix")}
                </option>
              )}
              {repos.map((repo) => (
                <option key={repo.repositoryId} value={repo.repositoryId}>
                  {repo.fullName}
                </option>
              ))}
            </select>
            {reposQ.isSuccess && repos.length === 0 && (
              <div className="mt-2">
                <p className="text-xs text-neutral-500">{t("github.noRepos")}</p>
                <button
                  type="button"
                  className="mt-1 text-xs font-medium text-brand underline-offset-2 hover:underline"
                  onClick={() => window.location.assign(connectionQ.data?.installUrl ?? connectUrl)}
                >
                  {t("github.reviewAccess")}
                </button>
              </div>
            )}
            {reposQ.isSuccess && repoFullName && !selectedRepo && repos.length > 0 && (
              <p className="mt-1 text-xs text-amber-700">{t("github.currentRepoUnavailable")}</p>
            )}
          </div>

          <div>
            <label htmlFor={branchId} className="mb-1 block text-xs font-medium text-neutral-600">
              {t("github.branch")}
            </label>
            {selectedRepo && branchesQ.isError ? (
              <>
                <input
                  id={branchId}
                  className={selectLikeInputClassName()}
                  placeholder={t("github.branchPlaceholder")}
                  value={branch}
                  onChange={(event) => onBranchChange(event.target.value.trim())}
                  disabled={disabled}
                />
                <p className="mt-1 text-xs text-neutral-500">{t("github.branchTypeHelp")}</p>
              </>
            ) : (
              <select
                id={branchId}
                className={selectLikeInputClassName()}
                value={branch}
                disabled={
                  disabled ||
                  !selectedRepo ||
                  branchesQ.isLoading ||
                  (!branchesQ.isError && branches.length === 0)
                }
                onChange={(event) => onBranchChange(event.target.value)}
              >
                {!selectedRepo && branch && <option value={branch}>{branch}</option>}
                {selectedRepo && branchesQ.isLoading && (
                  <option value={branch}>{t("github.loadingBranches")}</option>
                )}
                {branches.map((item) => (
                  <option key={item} value={item}>
                    {item}
                    {item === apiDefault ? ` ${t("github.defaultSuffix")}` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      )}

      {disconnect.isError && (
        <p role="alert" className="text-xs text-red-600">
          {disconnect.error.message}
        </p>
      )}
    </div>
  );
}
