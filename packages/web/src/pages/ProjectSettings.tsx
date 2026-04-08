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
import { cn } from "@/lib/cn";

type DetectStatus =
  | "idle"
  | "loading"
  | { kind: "ok"; label: string }
  | { kind: "none" }
  | { kind: "error" };

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "editor", "translator", "client"]),
  name: z.string().max(120).optional(),
});

type InviteForm = z.infer<typeof inviteSchema>;

const projectSchema = z.object({
  name: z.string().min(1).max(200),
  githubRepoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  defaultBranch: z.string().min(1).max(255),
  previewDevCommand: z.string().max(2000).optional(),
  logoUrl: z.string().url().max(2048).optional().or(z.literal("")),
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
  const [detectStatus, setDetectStatus] = useState<DetectStatus>("idle");
  const [inviteResult, setInviteResult] = useState<
    | null
    | { ok: true; emailSent: boolean; inviteLink: string; role: string; emailError: string | null }
    | { ok: false; error: string }
  >(null);

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
    defaultValues: { email: "", role: "editor", name: "" },
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
      logoUrl: "",
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
      logoUrl: p.logoUrl ?? "",
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
      logoUrl: string | null;
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
                  logoUrl: v.logoUrl?.trim() || null,
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
                <label className="mb-1 block text-xs font-medium text-neutral-600">Project logo URL</label>
                <Input placeholder="https://yourcompany.com/logo.png" {...registerProject("logoUrl")} />
                <p className="mt-1 text-xs text-neutral-500">
                  Shown on the branded client login page. Square images work best.
                </p>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-xs font-medium text-neutral-600">
                    {t("connectForm.devCommandLabel")}
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
                    className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-50"
                    title="Re-detect framework and dev command from package.json"
                  >
                    <svg
                      className={cn("h-3 w-3", detectStatus === "loading" && "animate-spin")}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M5.5 9A8 8 0 0118 8.5M18.5 15A8 8 0 016 15.5" />
                    </svg>
                    Re-detect
                  </button>
                </div>
                <Textarea
                  rows={2}
                  className="font-mono text-xs"
                  placeholder={t("projectSettings.devCommandPlaceholder")}
                  {...registerProject("previewDevCommand")}
                />
                {detectStatus !== "idle" && detectStatus !== "loading" && (
                  <p className={cn(
                    "mt-1 text-xs",
                    detectStatus.kind === "ok" && "text-green-600",
                    detectStatus.kind === "none" && "text-amber-600",
                    detectStatus.kind === "error" && "text-red-600",
                  )}>
                    {detectStatus.kind === "ok" && `Detected ${detectStatus.label}. Leave the command empty to use the default.`}
                    {detectStatus.kind === "none" && "No known framework detected. Set a custom command above."}
                    {detectStatus.kind === "error" && "Couldn't re-detect. Try again."}
                  </p>
                )}
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
                setInviteResult(null);
                try {
                  const res = await apiJson<{
                    inviteLink: string;
                    emailSent: boolean;
                    emailError: string | null;
                    role: string;
                  }>(`/api/team/projects/${id}/invites`, {
                    method: "POST",
                    body: JSON.stringify(v),
                  });
                  setInviteResult({ ok: true, ...res });
                  resetInvite();
                  void membersQ.refetch();
                } catch (e) {
                  setInviteResult({ ok: false, error: e instanceof Error ? e.message : "Failed" });
                }
              })}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  type="email"
                  placeholder={t("projectSettings.emailPlaceholder")}
                  {...registerInvite("email")}
                />
                <Input placeholder="Their name (optional)" {...registerInvite("name")} />
              </div>

              {/* Role picker as cards so the difference is visible */}
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  { value: "client", title: "Client", desc: "Branded login. Edits text and images via chat. Sees only this site." },
                  { value: "editor", title: "Collaborator", desc: "Full access. Signs in with GitHub. Sees all sites they belong to." },
                  { value: "admin", title: "Admin", desc: "Collaborator + can manage members and project settings." },
                  { value: "translator", title: "Translator", desc: "Edits content in non-English locales only." },
                ].map((r) => (
                  <label
                    key={r.value}
                    className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-neutral-200 bg-neutral-50/60 p-3 text-left transition-colors hover:border-neutral-300 hover:bg-white has-[:checked]:border-brand has-[:checked]:bg-brand/5"
                  >
                    <input
                      type="radio"
                      value={r.value}
                      className="mt-1 accent-brand"
                      {...registerInvite("role")}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-neutral-900">{r.title}</p>
                      <p className="mt-0.5 text-[12px] leading-snug text-neutral-500">{r.desc}</p>
                    </div>
                  </label>
                ))}
              </div>

              <Button type="submit" disabled={inviteSubmitting}>
                {inviteSubmitting ? "Sending invite…" : t("projectSettings.createInvite")}
              </Button>

              {inviteResult && inviteResult.ok && (
                <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm">
                  {inviteResult.emailSent ? (
                    <p className="text-green-700">
                      ✓ Invite email sent. They'll get a {inviteResult.role === "client" ? "branded sign-in page" : "GitHub sign-in link"} in their inbox.
                    </p>
                  ) : (
                    <>
                      <p className="text-amber-700">
                        Email isn't configured on this server. Copy the link and send it yourself:
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <code className="flex-1 truncate rounded-lg border border-neutral-200 bg-white px-2 py-1.5 font-mono text-[11px] text-neutral-700">
                          {inviteResult.inviteLink}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(inviteResult.inviteLink);
                          }}
                          className="rounded-md bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-neutral-700"
                        >
                          Copy
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              {inviteResult && !inviteResult.ok && (
                <p className="text-sm text-red-600">{inviteResult.error}</p>
              )}
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
