/**
 * Project Settings page shell. Owns the project query, the shared
 * react-hook-form instance driving internal site and Git details.
 * Client-facing identity is owned by the single Brand Studio section.
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
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useParams } from "react-router-dom";

export function ProjectSettingsPage() {
  const { t } = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const [displayNameMode, setDisplayNameMode] = useState<"repo" | "full" | "custom">("repo");

  const projectQ = useQuery({
    queryKey: ["project", id],
    enabled: !!id,
    queryFn: () =>
      apiJson<{
        name: string;
        role: string;
        githubRepositoryId: string | null;
        githubInstallationId: string | null;
        githubRepoFullName: string;
        defaultBranch: string;
        previewDevCommand: string | null;
        logoUrl: string | null;
        brandDisplayName: string | null;
        brandAccentColor: string | null;
        groupId: string | null;
        instanceBrand: {
          displayName: string;
          logoUrl: string | null;
          accentColor: string;
          tagline: string | null;
        };
        inheritedBrand: {
          displayName: string;
          logoUrl: string | null;
          accentColor: string;
          tagline: string | null;
        };
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
      githubRepositoryId: null,
      githubInstallationId: null,
      githubRepoFullName: "",
      defaultBranch: "main",
      previewDevCommand: "",
    },
  });

  const repoFull = watch("githubRepoFullName");
  const githubRepositoryId = watch("githubRepositoryId");
  const githubInstallationId = watch("githubInstallationId");
  const branch = watch("defaultBranch");
  const nameVal = watch("name");
  const hydratedProjectDetails = useRef<string | null>(null);

  useEffect(() => {
    const p = projectQ.data;
    if (!p) return;
    const detailsKey = JSON.stringify([
      id,
      p.name,
      p.githubRepositoryId,
      p.githubInstallationId,
      p.githubRepoFullName,
      p.defaultBranch,
      p.previewDevCommand,
    ]);
    if (hydratedProjectDetails.current === detailsKey) return;
    hydratedProjectDetails.current = detailsKey;
    resetProject({
      name: p.name,
      githubRepositoryId: p.githubRepositoryId,
      githubInstallationId: p.githubInstallationId,
      githubRepoFullName: p.githubRepoFullName,
      defaultBranch: p.defaultBranch,
      previewDevCommand: p.previewDevCommand ?? "",
    });
    setDisplayNameMode(inferDisplayNameMode(p.name, p.githubRepoFullName));
  }, [id, projectQ.data, resetProject]);

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
      <ProjectHeader
        projectId={id}
        projectName={projectQ.data?.name ?? "…"}
        detectFramework={false}
      />
      <main className="mx-auto max-w-5xl px-4 py-10">
        {/* Page heading */}
        <div className="mb-8 max-w-3xl">
          <Heading as="h1" className="text-[26px] font-semibold tracking-tight text-neutral-900">
            {t("projectSettings.pageTitle")}
          </Heading>
          <p className="mt-1 text-sm text-neutral-500">
            {projectQ.data?.name ?? "…"}, {projectQ.data?.githubRepoFullName ?? ""}
          </p>
        </div>

        <div className="space-y-6">
          {projectQ.data && (
            <BrandingSection
              key={id}
              projectId={id}
              projectName={projectQ.data?.name ?? ""}
              logoUrl={projectQ.data.logoUrl}
              isAdmin={Boolean(isAdmin)}
              isOwner={Boolean(isOwner)}
              initial={{
                brandDisplayName: projectQ.data.brandDisplayName,
                brandAccentColor: projectQ.data.brandAccentColor,
                groupId: projectQ.data.groupId,
                instanceBrand: projectQ.data.instanceBrand,
                inheritedBrand: projectQ.data.inheritedBrand,
              }}
            />
          )}

          <div className="mx-auto max-w-3xl space-y-6">
            {isAdmin && (
              <GeneralSection
                projectId={id}
                displayNameMode={displayNameMode}
                setDisplayNameMode={setDisplayNameMode}
                registerProject={registerProject}
                handleProjectSubmit={handleProjectSubmit}
                setValue={setValue}
                projectSubmitting={projectSubmitting}
                projectErrors={projectErrors}
                githubRepositoryId={githubRepositoryId}
                githubInstallationId={githubInstallationId}
                initialGithubRepositoryId={projectQ.data?.githubRepositoryId ?? null}
                initialGithubInstallationId={projectQ.data?.githubInstallationId ?? null}
                initialRepoFull={projectQ.data?.githubRepoFullName ?? ""}
                initialBranch={projectQ.data?.defaultBranch ?? ""}
                repoFull={repoFull}
                branch={branch}
                nameVal={nameVal}
              />
            )}

            <TeamSection projectId={id} isAdmin={Boolean(isAdmin)} />

            {isAdmin && projectQ.data && (
              <DangerZoneSection projectId={id} projectName={projectQ.data.name} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
