import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { Input } from "@/components/atoms/Input";
import { Modal } from "@/components/atoms/Modal";
import { Textarea } from "@/components/atoms/Textarea";
import { GitHubRepoBranchFields } from "@/components/organisms/GitHubRepoBranchFields";
import { InviteMemberModal } from "@/components/organisms/InviteMemberModal";
import { ProjectHeader } from "@/components/organisms/ProjectHeader";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { parseRepoFullName, repoSlugDisplay, selectLikeInputClassName } from "@/lib/github";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate, useParams } from "react-router-dom";
import { z } from "zod";

type DetectStatus =
  | "idle"
  | "loading"
  | { kind: "ok"; label: string }
  | { kind: "none" }
  | { kind: "error" };

const projectSchema = z.object({
  name: z.string().min(1).max(200),
  githubRepoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  defaultBranch: z.string().min(1).max(255),
  previewDevCommand: z.string().max(2000).optional(),
});

type ProjectForm = z.infer<typeof projectSchema>;

type Member = {
  id: string;
  userId: string;
  role: string;
  email: string;
  name: string;
  image: string | null;
  createdAt: number;
};

type PendingInvite = {
  id: string;
  email: string;
  role: string;
  expiresAt: number;
};

function inferDisplayNameMode(name: string, repoFull: string): "repo" | "full" | "custom" {
  const p = parseRepoFullName(repoFull);
  if (!p) return "custom";
  if (name === p.repo) return "repo";
  if (name === `${p.owner} / ${p.repo}`) return "full";
  return "custom";
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "·"
  );
}

function roleBadgeColor(
  role: string,
  t: (k: string) => string,
): { bg: string; text: string; label: string } {
  switch (role) {
    case "admin":
      return { bg: "bg-red-100", text: "text-red-700", label: t("projectSettings.roleAdmin") };
    case "editor":
      return {
        bg: "bg-blue-100",
        text: "text-blue-700",
        label: t("projectSettings.roleCollaborator"),
      };
    case "client":
      return {
        bg: "bg-purple-100",
        text: "text-purple-700",
        label: t("projectSettings.roleClient"),
      };
    default:
      return { bg: "bg-neutral-100", text: "text-neutral-700", label: role };
  }
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-sm">
      <header className="border-b border-neutral-200/80 bg-neutral-50/50 px-6 py-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-neutral-900">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-neutral-500">{description}</p>}
      </header>
      <div className="p-6">{children}</div>
    </section>
  );
}

export function ProjectSettingsPage() {
  const { t } = useT();
  const nav = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const qc = useQueryClient();
  const [preferManualGit, setPreferManualGit] = useState(false);
  const [displayNameMode, setDisplayNameMode] = useState<"repo" | "full" | "custom">("repo");
  const [detectStatus, setDetectStatus] = useState<DetectStatus>("idle");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [logoUrlDraft, setLogoUrlDraft] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

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
      }>(`/api/projects/${id}`),
  });

  const membersQ = useQuery({
    queryKey: ["members", id],
    enabled: !!id,
    queryFn: () => apiJson<{ members: Member[] }>(`/api/team/projects/${id}/members`),
  });

  const pendingInvitesQ = useQuery({
    queryKey: ["pending-invites", id],
    enabled: !!id && projectQ.data?.role === "admin",
    queryFn: () => apiJson<{ invites: PendingInvite[] }>(`/api/team/projects/${id}/invites`),
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
    setLogoUrlDraft(p.logoUrl);
  }, [projectQ.data, resetProject]);

  useEffect(() => {
    if (displayNameMode === "custom") return;
    const p = parseRepoFullName(repoFull);
    if (!p) return;
    if (displayNameMode === "repo") setValue("name", p.repo);
    else setValue("name", `${p.owner} / ${p.repo}`);
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

  const deleteProject = useMutation({
    mutationFn: () => apiJson(`/api/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      nav("/dashboard", { replace: true });
    },
  });

  const removeMember = useMutation({
    mutationFn: (memberId: string) =>
      apiJson(`/api/team/projects/${id}/members/${memberId}`, { method: "DELETE" }),
    onSuccess: () => void membersQ.refetch(),
  });

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) =>
      apiJson(`/api/team/projects/${id}/invites/${inviteId}`, { method: "DELETE" }),
    onSuccess: () => void pendingInvitesQ.refetch(),
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

  const isAdmin = projectQ.data?.role === "admin";
  const currentUserId = membersQ.data?.members.find((m) => m.role === "admin")?.userId;
  const slug = repoFull ? repoSlugDisplay(repoFull) : "…";
  const fullPretty = repoFull ? repoFull.replace("/", " / ") : "…";

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
            {projectQ.data?.name ?? "…"} — {projectQ.data?.githubRepoFullName ?? ""}
          </p>
        </div>

        <div className="space-y-6">
          {/* Brand section */}
          {isAdmin && (
            <SectionCard
              title={t("projectSettings.brandSection")}
              description={t("projectSettings.brandDescription")}
            >
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <div className="flex flex-col items-center gap-2">
                  <div className="relative flex h-24 w-24 items-center justify-center overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50">
                    {logoUrlDraft ? (
                      <img
                        src={logoUrlDraft}
                        alt="Project logo"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-2xl font-semibold text-neutral-400">
                        {initialsOf(projectQ.data?.name ?? "")}
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
                    <p className="max-w-[140px] text-center text-[11px] text-red-600">
                      {logoError}
                    </p>
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
                        onChange={(e) =>
                          setDisplayNameMode(e.target.value as "repo" | "full" | "custom")
                        }
                      >
                        <option value="repo">{t("connectForm.useRepoName", { slug })}</option>
                        <option value="full">
                          {t("connectForm.useOwnerRepo", { fullPretty })}
                        </option>
                        <option value="custom">{t("connectForm.custom")}</option>
                      </select>
                      {displayNameMode === "custom" ? (
                        <div className="mt-2">
                          <Input {...registerProject("name")} placeholder="Client homepage" />
                          {projectErrors.name && (
                            <p className="mt-1 text-xs text-red-600">
                              {projectErrors.name.message}
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-800">
                          {nameVal || "—"}
                        </p>
                      )}
                    </div>
                  </form>
                </div>
              </div>
            </SectionCard>
          )}

          {/* Git connection section */}
          {isAdmin && (
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
                    {projectErrors.githubRepoFullName?.message ??
                      projectErrors.defaultBranch?.message}
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
          )}

          {/* Team section */}
          <SectionCard
            title={t("projectSettings.teamSection")}
            description={
              isAdmin
                ? t("projectSettings.teamSectionDescriptionAdmin")
                : t("projectSettings.teamSectionDescriptionViewer")
            }
          >
            {/* Header row with count + invite button */}
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[12px] font-medium text-neutral-500">
                {(membersQ.data?.members ?? []).length === 1
                  ? t("projectSettings.memberCount")
                  : t("projectSettings.membersCount", {
                      count: (membersQ.data?.members ?? []).length,
                    })}
                {pendingInvitesQ.data && pendingInvitesQ.data.invites.length > 0 && (
                  <>
                    {" "}
                    · {pendingInvitesQ.data.invites.length}{" "}
                    {t("projectSettings.pendingInvites").toLowerCase()}
                  </>
                )}
              </p>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setInviteOpen(true)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 text-[12px] font-semibold text-white shadow-sm hover:bg-neutral-800"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  {t("projectSettings.inviteButton")}
                </button>
              )}
            </div>

            {/* Members table */}
            <div className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
              {(membersQ.data?.members ?? []).length === 0 ? (
                <p className="px-4 py-6 text-center text-[12px] text-neutral-400">
                  {t("projectSettings.noMembers")}
                </p>
              ) : (
                (membersQ.data?.members ?? []).map((m) => {
                  const badge = roleBadgeColor(m.role, t);
                  return (
                    <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                      {m.image ? (
                        <img
                          src={m.image}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-neutral-100 to-neutral-200 text-[11px] font-semibold text-neutral-500">
                          {initialsOf(m.name)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold text-neutral-900">
                          {m.name || m.email}
                        </p>
                        <p className="truncate text-[11px] text-neutral-500">{m.email}</p>
                      </div>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          badge.bg,
                          badge.text,
                        )}
                      >
                        {badge.label}
                      </span>
                      {isAdmin && m.userId !== currentUserId && (
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`${t("projectSettings.removeMember")}?`)) {
                              removeMember.mutate(m.id);
                            }
                          }}
                          disabled={removeMember.isPending}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                          title={t("projectSettings.removeMember")}
                          aria-label={t("projectSettings.removeMember")}
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.8}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Pending invites */}
            {isAdmin && pendingInvitesQ.data && pendingInvitesQ.data.invites.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  {t("projectSettings.pendingInvites")}
                </p>
                <div className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-dashed border-neutral-200 bg-neutral-50/50">
                  {pendingInvitesQ.data.invites.map((inv) => {
                    const badge = roleBadgeColor(inv.role, t);
                    return (
                      <div key={inv.id} className="flex items-center gap-3 px-4 py-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-neutral-300 text-neutral-400">
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.8}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                            />
                          </svg>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-neutral-800">
                            {inv.email}
                          </p>
                          <p className="text-[11px] text-neutral-400">
                            {t("projectSettings.expires", {
                              date: new Date(inv.expiresAt).toLocaleDateString(),
                            })}
                          </p>
                        </div>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                            badge.bg,
                            badge.text,
                          )}
                        >
                          {badge.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => revokeInvite.mutate(inv.id)}
                          disabled={revokeInvite.isPending}
                          className="text-[11px] font-medium text-neutral-500 underline-offset-2 hover:text-red-600 hover:underline disabled:opacity-50"
                        >
                          {t("projectSettings.revoke")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </SectionCard>

          {/* Danger zone */}
          {isAdmin && projectQ.data && (
            <div className="overflow-hidden rounded-2xl border border-red-200 bg-red-50/40 shadow-sm">
              <header className="border-b border-red-200 bg-red-50/60 px-6 py-4">
                <h2 className="text-[15px] font-semibold tracking-tight text-red-900">
                  {t("projectSettings.dangerZone")}
                </h2>
                <p className="mt-0.5 text-[13px] text-red-800/80">
                  {t("projectSettings.dangerZoneDescription")}
                </p>
              </header>
              <div className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-red-900">
                      {t("projectSettings.deleteProject")}
                    </p>
                    <p className="mt-1 text-[13px] text-red-800/80">
                      {t("projectSettings.deleteProjectDescription")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteConfirm("");
                      setDeleteOpen(true);
                    }}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3.5 text-[13px] font-semibold text-red-700 transition-colors hover:bg-red-50"
                  >
                    {t("projectSettings.deleteButton")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      <InviteMemberModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        projectId={id}
        onInvited={() => {
          void membersQ.refetch();
          void pendingInvitesQ.refetch();
        }}
      />

      {/* Delete confirmation modal */}
      <Modal
        open={deleteOpen}
        onClose={() => !deleteProject.isPending && setDeleteOpen(false)}
        className="max-w-md"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-100 text-red-600">
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-[17px] font-semibold tracking-tight text-neutral-900">
              {t("projectSettings.deleteModalTitle")}
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-neutral-600">
              {t("projectSettings.deleteModalBody")}
            </p>
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
            {t("projectSettings.deleteConfirmLabel")}{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-[11px] text-neutral-700">
              {projectQ.data?.name ?? ""}
            </code>
          </label>
          <Input
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            placeholder={projectQ.data?.name ?? ""}
            disabled={deleteProject.isPending}
            autoFocus
          />
        </div>
        {deleteProject.isError && (
          <p className="mt-2 text-sm text-red-600">
            {(deleteProject.error as Error)?.message ?? t("projectSettings.deleteFailed")}
          </p>
        )}
        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => !deleteProject.isPending && setDeleteOpen(false)}
            disabled={deleteProject.isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => deleteProject.mutate()}
            disabled={
              deleteProject.isPending ||
              deleteConfirm.trim().toLowerCase() !==
                (projectQ.data?.name ?? "").trim().toLowerCase()
            }
            className={cn(
              "inline-flex h-10 items-center gap-1.5 rounded-lg bg-red-600 px-4 text-[13px] font-semibold text-white shadow-sm transition-all",
              deleteProject.isPending ||
                deleteConfirm.trim().toLowerCase() !==
                  (projectQ.data?.name ?? "").trim().toLowerCase()
                ? "cursor-not-allowed opacity-50"
                : "hover:bg-red-700 hover:shadow",
            )}
          >
            {deleteProject.isPending ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                {t("projectSettings.deleteButtonLoading")}
              </>
            ) : (
              t("projectSettings.deleteButtonFinal")
            )}
          </button>
        </div>
      </Modal>
    </div>
  );
}
