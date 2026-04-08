import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { Input } from "@/components/atoms/Input";
import { Textarea } from "@/components/atoms/Textarea";
import { AppHeader } from "@/components/organisms/AppHeader";
import { GitHubRepoBranchFields } from "@/components/organisms/GitHubRepoBranchFields";
import { apiJson } from "@/lib/api";
import { parseRepoFullName, repoSlugDisplay, selectLikeInputClassName } from "@/lib/github";
import { useT } from "@/i18n/i18n";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "editor", "translator"]),
});

type InviteForm = z.infer<typeof inviteSchema>;

const projectSchema = z.object({
  name: z.string().min(1).max(200),
  githubRepoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  defaultBranch: z.string().min(1).max(255),
  previewDevCommand: z.string().max(2000).optional(),
});

type ProjectForm = z.infer<typeof projectSchema>;

function inferDisplayNameMode(name: string, repoFull: string): "repo" | "full" | "custom" {
  const p = parseRepoFullName(repoFull);
  if (!p) return "custom";
  if (name === p.repo) return "repo";
  if (name === `${p.owner} / ${p.repo}`) return "full";
  return "custom";
}

export function ProjectSettingsPage() {
  const { t } = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const qc = useQueryClient();
  const [preferManualGit, setPreferManualGit] = useState(false);
  const [displayNameMode, setDisplayNameMode] = useState<"repo" | "full" | "custom">("repo");

  const projectQ = useQuery({
    queryKey: ["project", id],
    enabled: !!id,
    queryFn: () =>
      apiJson<{
        name: string;
        role: string;
        githubRepoFullName: string;
        defaultBranch: string;
        previewDevCommand: string | null;
      }>(`/api/projects/${id}`),
  });

  const membersQ = useQuery({
    queryKey: ["members", id],
    enabled: !!id,
    queryFn: () =>
      apiJson<{
        members: {
          id: string;
          userId: string;
          role: string;
        }[];
      }>(`/api/team/projects/${id}/members`),
  });

  const {
    register: registerInvite,
    handleSubmit: handleInviteSubmit,
    reset: resetInvite,
    formState: { isSubmitting: inviteSubmitting },
  } = useForm<InviteForm>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "editor" },
  });

  const {
    register: registerProject,
    handleSubmit: handleProjectSubmit,
    reset: resetProject,
    setValue,
    watch,
    formState: { isSubmitting: projectSubmitting, errors: projectErrors },
  } = useForm<ProjectForm>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      name: "",
      githubRepoFullName: "",
      defaultBranch: "main",
      previewDevCommand: "",
    },
  });

  const repoFull = watch("githubRepoFullName");
  const branch = watch("defaultBranch");
  const nameVal = watch("name");

  useEffect(() => {
    const p = projectQ.data;
    if (!p) return;
    resetProject({
      name: p.name,
      githubRepoFullName: p.githubRepoFullName,
      defaultBranch: p.defaultBranch,
      previewDevCommand: p.previewDevCommand ?? "",
    });
    setDisplayNameMode(inferDisplayNameMode(p.name, p.githubRepoFullName));
    setPreferManualGit(false);
  }, [projectQ.data, resetProject]);

  useEffect(() => {
    if (displayNameMode === "custom") return;
    const p = parseRepoFullName(repoFull);
    if (!p) return;
    if (displayNameMode === "repo") {
      setValue("name", p.repo);
    } else {
      setValue("name", `${p.owner} / ${p.repo}`);
    }
  }, [repoFull, displayNameMode, setValue]);

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

  const isAdmin = projectQ.data?.role === "admin";

  const slug = repoFull ? repoSlugDisplay(repoFull) : "…";
  const fullPretty = repoFull ? repoFull.replace("/", " / ") : "…";

  return (
    <div className="min-h-screen bg-neutral-50">
      <AppHeader showNav projectId={id} />
      <main className="mx-auto max-w-lg px-4 py-10">
        <Heading as="h1" className="mb-2 text-2xl font-semibold tracking-tight">
          {t("projectSettings.teamProjectHeading")}
        </Heading>
        <p className="mb-8 text-sm text-neutral-600">
          {t("projectSettings.teamProjectHelp")}
        </p>

        {isAdmin && (
          <div className="mb-10 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
            <Heading as="h2" className="mb-1 text-base font-semibold">
              {t("projectSettings.gitConnection")}
            </Heading>
            <p className="mb-4 text-sm text-neutral-600">
              {t("projectSettings.gitConnectionHelp")}
            </p>
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
            >
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

              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">{t("connectForm.displayName")}</label>
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
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">
                  {displayNameMode === "custom" ? t("connectForm.customName") : t("connectForm.shownInApp")}
                </label>
                {displayNameMode === "custom" ? (
                  <>
                    <Input {...registerProject("name")} />
                    {projectErrors.name && (
                      <p className="mt-1 text-xs text-red-600">{projectErrors.name.message}</p>
                    )}
                  </>
                ) : (
                  <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-800">
                    {nameVal || "—"}
                  </p>
                )}
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">
                  {t("connectForm.devCommandLabel")}
                </label>
                <Textarea
                  rows={2}
                  className="font-mono text-xs"
                  placeholder={t("projectSettings.devCommandPlaceholder")}
                  {...registerProject("previewDevCommand")}
                />
              </div>
              <Button type="submit" disabled={projectSubmitting || patchProject.isPending}>
                {t("projectSettings.saveProject")}
              </Button>
            </form>
          </div>
        )}

        <div className="mb-8">
          <Heading as="h2" className="mb-3 text-base font-semibold">
            {t("projectSettings.members")}
          </Heading>
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {(membersQ.data?.members ?? []).map((m) => (
              <li key={m.id} className="flex justify-between px-4 py-3 text-sm">
                <span className="font-mono text-xs text-neutral-600">{m.userId.slice(0, 8)}…</span>
                <span className="text-neutral-500">{m.role}</span>
              </li>
            ))}
          </ul>
        </div>

        {isAdmin && (
          <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
            <Heading as="h2" className="mb-1 text-base font-semibold">
              {t("projectSettings.inviteByEmail")}
            </Heading>
            <p className="mb-4 text-sm text-neutral-600">
              {t("projectSettings.inviteByEmailHelp")}
            </p>
            <form
              className="flex flex-col gap-3"
              onSubmit={handleInviteSubmit(async (v) => {
                const res = await apiJson<{ inviteLink: string }>(`/api/team/projects/${id}/invites`, {
                  method: "POST",
                  body: JSON.stringify(v),
                });
                alert(`Invite created. Link:\n${res.inviteLink}`);
                resetInvite();
                void membersQ.refetch();
              })}
            >
              <Input type="email" placeholder={t("projectSettings.emailPlaceholder")} {...registerInvite("email")} />
              <select
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
                {...registerInvite("role")}
              >
                <option value="editor">{t("projectSettings.roleEditor")}</option>
                <option value="translator">{t("projectSettings.roleTranslator")}</option>
                <option value="admin">{t("projectSettings.roleAdmin")}</option>
              </select>
              <Button type="submit" disabled={inviteSubmitting}>
                {t("projectSettings.createInvite")}
              </Button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
