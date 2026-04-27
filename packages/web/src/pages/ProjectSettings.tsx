/**
 * Project Settings page shell. Owns the project query, the shared
 * react-hook-form instance driving GeneralSection (brand + git
 * connection), and the logo-draft state that GeneralSection mutates
 * while editing. Each section organism handles its own mutations
 * and queries so this shell stays small.
 */

import { Heading } from "@/components/atoms/Heading";
import { ProjectHeader } from "@/components/organisms/ProjectHeader";
import { BrandingSection } from "@/components/organisms/project-settings/BrandingSection";
import { DangerZoneSection } from "@/components/organisms/project-settings/DangerZoneSection";
import { GeneralSection } from "@/components/organisms/project-settings/GeneralSection";
import { TeamSection } from "@/components/organisms/project-settings/TeamSection";
import {
  type ProjectForm,
  inferDisplayNameMode,
  projectSchema,
} from "@/components/organisms/project-settings/types";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { parseRepoFullName } from "@/lib/github";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useParams } from "react-router-dom";

export function ProjectSettingsPage() {
  const { t } = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const [preferManualGit, setPreferManualGit] = useState(false);
  const [displayNameMode, setDisplayNameMode] = useState<"repo" | "full" | "custom">("repo");
  const [logoUrlDraft, setLogoUrlDraft] = useState<string | null>(null);

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
        logoUrl: string | null;
        brandDisplayName: string | null;
        brandAccentColor: string | null;
        groupId: string | null;
      }>(`/api/projects/${id}`),
  });

  // Owner check controls the group picker visibility in BrandingSection.
  // The instance-settings session endpoint already gates this server-side.
  const sessionQ = useQuery({
    queryKey: ["session"],
    queryFn: () => apiJson<{ user: { instanceRole?: string | null } | null }>("/api/session"),
    staleTime: 5 * 60 * 1000,
  });
  const isOwner = sessionQ.data?.user?.instanceRole === "owner";

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
    setLogoUrlDraft(p.logoUrl);
  }, [projectQ.data, resetProject]);

  useEffect(() => {
    if (displayNameMode === "custom") return;
    const p = parseRepoFullName(repoFull);
    if (!p) return;
    if (displayNameMode === "repo") setValue("name", p.repo);
    else setValue("name", `${p.owner} / ${p.repo}`);
  }, [repoFull, displayNameMode, setValue]);

  const isAdmin = projectQ.data?.role === "admin";

  return (
    <div className="min-h-screen bg-neutral-50">
      <ProjectHeader projectId={id} projectName={projectQ.data?.name ?? "…"} />
      <main className="mx-auto max-w-3xl px-4 py-10">
        {/* Page heading */}
        <div className="mb-8">
          <Heading as="h1" className="text-[26px] font-semibold tracking-tight text-neutral-900">
            {t("projectSettings.pageTitle")}
          </Heading>
          <p className="mt-1 text-sm text-neutral-500">
            {projectQ.data?.name ?? "…"}, {projectQ.data?.githubRepoFullName ?? ""}
          </p>
        </div>

        <div className="space-y-6">
          {isAdmin && (
            <GeneralSection
              projectId={id}
              projectName={projectQ.data?.name ?? ""}
              logoUrlDraft={logoUrlDraft}
              setLogoUrlDraft={setLogoUrlDraft}
              displayNameMode={displayNameMode}
              setDisplayNameMode={setDisplayNameMode}
              preferManualGit={preferManualGit}
              setPreferManualGit={setPreferManualGit}
              registerProject={registerProject}
              handleProjectSubmit={handleProjectSubmit}
              setValue={setValue}
              projectSubmitting={projectSubmitting}
              projectErrors={projectErrors}
              repoFull={repoFull}
              branch={branch}
              nameVal={nameVal}
            />
          )}

          {projectQ.data && (
            <BrandingSection
              projectId={id}
              isAdmin={Boolean(isAdmin)}
              isOwner={Boolean(isOwner)}
              initial={{
                brandDisplayName: projectQ.data.brandDisplayName,
                brandAccentColor: projectQ.data.brandAccentColor,
                groupId: projectQ.data.groupId,
              }}
            />
          )}

          <TeamSection projectId={id} isAdmin={Boolean(isAdmin)} />

          {isAdmin && projectQ.data && (
            <DangerZoneSection projectId={id} projectName={projectQ.data.name} />
          )}
        </div>
      </main>
    </div>
  );
}
