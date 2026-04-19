/**
 * Admin-only "general" block of the Project Settings page: brand
 * (logo + display-name) and Git connection (repo, branch, dev preview
 * command, re-detect framework). Both share a single RHF form so the
 * Save button at the bottom persists the whole block in one PATCH.
 *
 * Extracted out of packages/web/src/pages/ProjectSettings.tsx. Logic
 * and markup were moved verbatim, no behaviour change.
 */

import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { Textarea } from "@/components/atoms/Textarea";
import { GitHubRepoBranchFields } from "@/components/organisms/GitHubRepoBranchFields";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { repoSlugDisplay, selectLikeInputClassName } from "@/lib/github";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type {
  FieldErrors,
  UseFormHandleSubmit,
  UseFormRegister,
  UseFormSetValue,
} from "react-hook-form";
import { SectionCard } from "./SectionCard";
import type { DetectStatus, ProjectForm } from "./types";
import { initialsOf } from "./types";

type Props = {
  projectId: string;
  projectName: string;
  logoUrlDraft: string | null;
  setLogoUrlDraft: (url: string | null) => void;
  displayNameMode: "repo" | "full" | "custom";
  setDisplayNameMode: (m: "repo" | "full" | "custom") => void;
  preferManualGit: boolean;
  setPreferManualGit: (v: boolean) => void;
  registerProject: UseFormRegister<ProjectForm>;
  handleProjectSubmit: UseFormHandleSubmit<ProjectForm>;
  setValue: UseFormSetValue<ProjectForm>;
  projectSubmitting: boolean;
  projectErrors: FieldErrors<ProjectForm>;
  repoFull: string;
  branch: string;
  nameVal: string;
};

export function GeneralSection({
  projectId,
  projectName,
  logoUrlDraft,
  setLogoUrlDraft,
  displayNameMode,
  setDisplayNameMode,
  preferManualGit,
  setPreferManualGit,
  registerProject,
  handleProjectSubmit,
  setValue,
  projectSubmitting,
  projectErrors,
  repoFull,
  branch,
  nameVal,
}: Props) {
  const { t } = useT();
  const qc = useQueryClient();
  const id = projectId;
  const [detectStatus, setDetectStatus] = useState<DetectStatus>("idle");
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const patchProject = useMutation({
    mutationFn: (body: {
      name: string;
      githubRepoFullName: string;
      defaultBranch: string;
      previewDevCommand: string | null;
    }) => apiJson(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project", id] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  async function uploadLogo(file: File) {
    setLogoError(null);
    setLogoUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/projects/${id}/logo`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `Upload failed (${res.status})`);
      }
      const data = (await res.json()) as { logoUrl: string };
      setLogoUrlDraft(data.logoUrl);
      void qc.invalidateQueries({ queryKey: ["project", id] });
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLogoUploading(false);
    }
  }

  async function clearLogo() {
    setLogoError(null);
    setLogoUploading(true);
    try {
      await apiJson(`/api/projects/${id}/logo`, { method: "DELETE" });
      setLogoUrlDraft(null);
      void qc.invalidateQueries({ queryKey: ["project", id] });
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLogoUploading(false);
    }
  }

  const slug = repoFull ? repoSlugDisplay(repoFull) : "…";
  const fullPretty = repoFull ? repoFull.replace("/", " / ") : "…";

  return (
    <>
      {/* Brand section */}
      <SectionCard
        title={t("projectSettings.brandSection")}
        description={t("projectSettings.brandDescription")}
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div className="flex flex-col items-center gap-2">
            <div className="relative flex h-24 w-24 items-center justify-center overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50">
              {logoUrlDraft ? (
                <img src={logoUrlDraft} alt="Project logo" className="h-full w-full object-cover" />
              ) : (
                <span className="text-2xl font-semibold text-neutral-400">
                  {initialsOf(projectName)}
                </span>
              )}
              {logoUploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/60">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
                </div>
              )}
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => logoInputRef.current?.click()}
                disabled={logoUploading}
                className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
              >
                {logoUrlDraft ? "Change" : "Upload"}
              </button>
              {logoUrlDraft && (
                <button
                  type="button"
                  onClick={clearLogo}
                  disabled={logoUploading}
                  className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-red-700 disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadLogo(f);
                e.target.value = "";
              }}
            />
            {logoError && (
              <p className="max-w-[140px] text-center text-[11px] text-red-600">{logoError}</p>
            )}
          </div>

          <div className="flex-1 space-y-4">
            <form
              className="flex flex-col gap-4"
              onSubmit={handleProjectSubmit(async (v) => {
                await patchProject.mutateAsync({
                  name: v.name.trim(),
                  githubRepoFullName: v.githubRepoFullName.trim(),
                  defaultBranch: v.defaultBranch.trim(),
                  previewDevCommand: v.previewDevCommand?.trim() || null,
                });
              })}
              id="project-form"
            >
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  Display name
                </label>
                <select
                  className={selectLikeInputClassName()}
                  value={displayNameMode}
                  disabled={projectSubmitting || patchProject.isPending}
                  onChange={(e) => setDisplayNameMode(e.target.value as "repo" | "full" | "custom")}
                >
                  <option value="repo">{t("connectForm.useRepoName", { slug })}</option>
                  <option value="full">{t("connectForm.useOwnerRepo", { fullPretty })}</option>
                  <option value="custom">{t("connectForm.custom")}</option>
                </select>
                {displayNameMode === "custom" ? (
                  <div className="mt-2">
                    <Input {...registerProject("name")} placeholder="Client homepage" />
                    {projectErrors.name && (
                      <p className="mt-1 text-xs text-red-600">{projectErrors.name.message}</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-800">
                    {nameVal || "-"}
                  </p>
                )}
              </div>
            </form>
          </div>
        </div>
      </SectionCard>

      {/* Git connection section */}
      <SectionCard
        title={t("projectSettings.gitConnection")}
        description={t("projectSettings.gitConnectionDescription")}
      >
        <div className="space-y-5">
          <GitHubRepoBranchFields
            repoFullName={repoFull}
            branch={branch}
            disabled={projectSubmitting || patchProject.isPending}
            preferManual={preferManualGit}
            setPreferManual={setPreferManualGit}
            onRepoChange={(full, dbHint) => {
              setValue("githubRepoFullName", full, { shouldValidate: true });
              setValue("defaultBranch", dbHint, { shouldValidate: true });
            }}
            onBranchChange={(b) => setValue("defaultBranch", b, { shouldValidate: true })}
          />
          {(projectErrors.githubRepoFullName || projectErrors.defaultBranch) && (
            <p className="text-xs text-red-600">
              {projectErrors.githubRepoFullName?.message ?? projectErrors.defaultBranch?.message}
            </p>
          )}

          <div className="rounded-xl border border-neutral-200 bg-neutral-50/50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <label className="text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                Dev preview command
              </label>
              <button
                type="button"
                onClick={async () => {
                  setDetectStatus("loading");
                  try {
                    const fw = await apiJson<{ id: string; label: string }>(
                      `/api/projects/${id}/framework`,
                    );
                    setDetectStatus(
                      fw.id && fw.id !== "unknown"
                        ? { kind: "ok", label: fw.label }
                        : { kind: "none" },
                    );
                  } catch {
                    setDetectStatus({ kind: "error" });
                  }
                }}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
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
                Re-detect
              </button>
            </div>
            <Textarea
              rows={2}
              className="font-mono text-xs"
              placeholder="Leave empty to auto-detect"
              {...registerProject("previewDevCommand")}
            />
            {detectStatus !== "idle" && detectStatus !== "loading" && (
              <p
                className={cn(
                  "mt-2 text-xs",
                  typeof detectStatus === "object" &&
                    detectStatus.kind === "ok" &&
                    "text-green-600",
                  typeof detectStatus === "object" &&
                    detectStatus.kind === "none" &&
                    "text-amber-600",
                  typeof detectStatus === "object" &&
                    detectStatus.kind === "error" &&
                    "text-red-600",
                )}
              >
                {typeof detectStatus === "object" &&
                  detectStatus.kind === "ok" &&
                  `Detected ${detectStatus.label}. Leave the command empty to use the default.`}
                {typeof detectStatus === "object" &&
                  detectStatus.kind === "none" &&
                  "No known framework detected. Set a custom command above."}
                {typeof detectStatus === "object" &&
                  detectStatus.kind === "error" &&
                  "Couldn't re-detect. Try again."}
              </p>
            )}
          </div>

          <div className="flex justify-end">
            <Button
              type="submit"
              form="project-form"
              disabled={projectSubmitting || patchProject.isPending}
            >
              {patchProject.isPending
                ? t("projectSettings.saving")
                : t("projectSettings.saveChanges")}
            </Button>
          </div>
        </div>
      </SectionCard>
    </>
  );
}
