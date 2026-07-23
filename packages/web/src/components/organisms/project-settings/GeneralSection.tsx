import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { Textarea } from "@/components/atoms/Textarea";
import { GitHubRepoBranchFields } from "@/components/organisms/GitHubRepoBranchFields";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  githubConnectUrl,
  isGitHubConnectionRequired,
  repoSlugDisplay,
  selectLikeInputClassName,
} from "@/lib/github";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
  FieldErrors,
  UseFormHandleSubmit,
  UseFormRegister,
  UseFormSetValue,
} from "react-hook-form";
import { SectionCard } from "./SectionCard";
import type { DetectStatus, ProjectForm } from "./types";

type Props = {
  projectId: string;
  displayNameMode: "repo" | "full" | "custom";
  setDisplayNameMode: (mode: "repo" | "full" | "custom") => void;
  registerProject: UseFormRegister<ProjectForm>;
  handleProjectSubmit: UseFormHandleSubmit<ProjectForm>;
  setValue: UseFormSetValue<ProjectForm>;
  projectSubmitting: boolean;
  projectErrors: FieldErrors<ProjectForm>;
  githubRepositoryId: string | null;
  githubInstallationId: string | null;
  initialGithubRepositoryId: string | null;
  initialGithubInstallationId: string | null;
  initialRepoFull: string;
  initialBranch: string;
  repoFull: string;
  branch: string;
  nameVal: string;
};

export function GeneralSection({
  projectId,
  displayNameMode,
  setDisplayNameMode,
  registerProject,
  handleProjectSubmit,
  setValue,
  projectSubmitting,
  projectErrors,
  githubRepositoryId,
  githubInstallationId,
  initialGithubRepositoryId,
  initialGithubInstallationId,
  initialRepoFull,
  initialBranch,
  repoFull,
  branch,
  nameVal,
}: Props) {
  const { t } = useT();
  const qc = useQueryClient();
  const [detectStatus, setDetectStatus] = useState<DetectStatus>("idle");

  const saveProject = useMutation({
    mutationFn: async (body: {
      name: string;
      githubRepositoryId: string | null;
      githubInstallationId: string | null;
      githubRepoFullName: string;
      defaultBranch: string;
      previewDevCommand: string | null;
    }) => {
      const githubBindingChanged =
        body.githubRepositoryId !== initialGithubRepositoryId ||
        body.githubInstallationId !== initialGithubInstallationId ||
        body.githubRepoFullName !== initialRepoFull ||
        body.defaultBranch !== initialBranch;

      if (githubBindingChanged) {
        if (!body.githubRepositoryId || !body.githubInstallationId) {
          throw new Error(t("github.selectRepoRequired"));
        }
        await apiJson(`/api/projects/${projectId}/github/rebind`, {
          method: "POST",
          body: JSON.stringify({
            githubRepositoryId: body.githubRepositoryId,
            githubInstallationId: body.githubInstallationId,
            defaultBranch: body.defaultBranch,
          }),
        });
      }

      return apiJson(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: body.name,
          previewDevCommand: body.previewDevCommand,
        }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["project", projectId] }),
        qc.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });

  const slug = repoFull ? repoSlugDisplay(repoFull) : "…";
  const fullPretty = repoFull ? repoFull.replace("/", " / ") : "…";
  const busy = projectSubmitting || saveProject.isPending;

  return (
    <SectionCard
      title={t("projectSettings.siteDetails.title")}
      description={t("projectSettings.siteDetails.description")}
    >
      <form
        className="space-y-6"
        onSubmit={handleProjectSubmit(async (value) => {
          await saveProject.mutateAsync({
            name: value.name.trim(),
            githubRepositoryId: value.githubRepositoryId,
            githubInstallationId: value.githubInstallationId,
            githubRepoFullName: value.githubRepoFullName.trim(),
            defaultBranch: value.defaultBranch.trim(),
            previewDevCommand: value.previewDevCommand?.trim() || null,
          });
        })}
      >
        <div>
          <label
            htmlFor="project-display-name-mode"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            {t("projectSettings.siteDetails.internalName")}
          </label>
          <select
            id="project-display-name-mode"
            className={selectLikeInputClassName()}
            value={displayNameMode}
            disabled={busy}
            onChange={(event) =>
              setDisplayNameMode(event.target.value as "repo" | "full" | "custom")
            }
          >
            <option value="repo">{t("connectForm.useRepoName", { slug })}</option>
            <option value="full">{t("connectForm.useOwnerRepo", { fullPretty })}</option>
            <option value="custom">{t("connectForm.custom")}</option>
          </select>
          {displayNameMode === "custom" ? (
            <div className="mt-2">
              <label htmlFor="project-custom-name" className="sr-only">
                {t("projectSettings.siteDetails.customInternalName")}
              </label>
              <Input
                id="project-custom-name"
                {...registerProject("name")}
                placeholder={t("projectSettings.siteDetails.customPlaceholder")}
              />
              {projectErrors.name && (
                <p className="mt-1 text-xs text-red-600">{projectErrors.name.message}</p>
              )}
            </div>
          ) : (
            <p className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-800">
              {nameVal || "-"}
            </p>
          )}
          <p className="mt-1.5 text-[11px] text-neutral-500">
            {t("projectSettings.siteDetails.internalHelp")}
          </p>
        </div>

        <div className="border-t border-neutral-200 pt-6">
          <GitHubRepoBranchFields
            repositoryId={githubRepositoryId}
            installationId={githubInstallationId}
            repoFullName={repoFull}
            branch={branch}
            disabled={busy}
            onRepoChange={(repo) => {
              setValue("githubRepositoryId", repo.repositoryId, { shouldValidate: true });
              setValue("githubInstallationId", repo.installationId, { shouldValidate: true });
              setValue("githubRepoFullName", repo.fullName, { shouldValidate: true });
              setValue("defaultBranch", repo.defaultBranch, { shouldValidate: true });
            }}
            onBranchChange={(value) => setValue("defaultBranch", value, { shouldValidate: true })}
          />
          {(projectErrors.githubRepoFullName || projectErrors.defaultBranch) && (
            <p className="mt-2 text-xs text-red-600">
              {projectErrors.githubRepoFullName?.message ?? projectErrors.defaultBranch?.message}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-neutral-200 bg-neutral-50/50 p-4">
          <div className="mb-2 flex items-center justify-between">
            <label
              htmlFor="project-preview-command"
              className="text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
            >
              {t("projectSettings.devPreviewCommand")}
            </label>
            <button
              type="button"
              disabled={busy || detectStatus === "loading"}
              onClick={async () => {
                setDetectStatus("loading");
                try {
                  const framework = await apiJson<{ id: string; label: string }>(
                    `/api/projects/${projectId}/framework`,
                  );
                  setDetectStatus(
                    framework.id && framework.id !== "unknown"
                      ? { kind: "ok", label: framework.label }
                      : { kind: "none" },
                  );
                } catch {
                  setDetectStatus({ kind: "error" });
                }
              }}
              className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-50"
            >
              <svg
                className={cn("h-3 w-3", detectStatus === "loading" && "animate-spin")}
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
              {t("projectSettings.reDetect")}
            </button>
          </div>
          <Textarea
            id="project-preview-command"
            rows={2}
            className="font-mono text-xs"
            placeholder={t("projectSettings.devCommandPlaceholder")}
            {...registerProject("previewDevCommand")}
          />
          {detectStatus !== "idle" && detectStatus !== "loading" && (
            <p
              className={cn(
                "mt-2 text-xs",
                detectStatus.kind === "ok" && "text-green-600",
                detectStatus.kind === "none" && "text-amber-600",
                detectStatus.kind === "error" && "text-red-600",
              )}
            >
              {detectStatus.kind === "ok" &&
                t("projectSettings.devPreviewDetected", { label: detectStatus.label })}
              {detectStatus.kind === "none" && t("projectSettings.devPreviewNotDetected")}
              {detectStatus.kind === "error" && t("projectSettings.devPreviewDetectError")}
            </p>
          )}
        </div>

        {saveProject.isError && isGitHubConnectionRequired(saveProject.error) ? (
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
            <p className="text-sm font-medium text-neutral-900">{t("github.connectTitle")}</p>
            <p className="mt-1 text-xs text-neutral-500">{t("github.connectDescription")}</p>
            <button
              type="button"
              className="mt-3 inline-flex h-9 items-center rounded-lg bg-neutral-900 px-4 text-xs font-semibold text-white transition-colors hover:bg-neutral-800"
              onClick={() => window.location.assign(githubConnectUrl(saveProject.error))}
            >
              {t("github.connect")}
            </button>
          </div>
        ) : saveProject.isError ? (
          <p role="alert" className="text-sm text-red-600">
            {(saveProject.error as Error).message}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={busy}>
            {saveProject.isPending ? t("projectSettings.saving") : t("projectSettings.saveChanges")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
