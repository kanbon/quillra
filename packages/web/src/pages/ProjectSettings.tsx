import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { Input } from "@/components/atoms/Input";
import { Textarea } from "@/components/atoms/Textarea";
import { AppHeader } from "@/components/organisms/AppHeader";
import { apiJson } from "@/lib/api";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "editor", "translator"]),
});

type InviteForm = z.infer<typeof inviteSchema>;

const projectSchema = z.object({
  name: z.string().min(1).max(200),
  previewDevCommand: z.string().max(2000).optional(),
});

type ProjectForm = z.infer<typeof projectSchema>;

export function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const qc = useQueryClient();

  const projectQ = useQuery({
    queryKey: ["project", id],
    enabled: !!id,
    queryFn: () =>
      apiJson<{
        name: string;
        role: string;
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
    formState: { isSubmitting: projectSubmitting },
  } = useForm<ProjectForm>({
    resolver: zodResolver(projectSchema),
    defaultValues: { name: "", previewDevCommand: "" },
  });

  useEffect(() => {
    const p = projectQ.data;
    if (!p) return;
    resetProject({
      name: p.name,
      previewDevCommand: p.previewDevCommand ?? "",
    });
  }, [projectQ.data, resetProject]);

  const patchProject = useMutation({
    mutationFn: (body: { name: string; previewDevCommand: string | null }) =>
      apiJson(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project", id] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const isAdmin = projectQ.data?.role === "admin";

  return (
    <div className="min-h-screen bg-neutral-50">
      <AppHeader showNav projectId={id} />
      <main className="mx-auto max-w-lg px-4 py-10">
        <Heading as="h1" className="mb-2 text-2xl font-semibold tracking-tight">
          Team & project
        </Heading>
        <p className="mb-8 text-sm text-neutral-600">
          Invites are scoped to this repository only—not a separate organization product.
        </p>

        {isAdmin && (
          <div className="mb-10 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
            <Heading as="h2" className="mb-1 text-base font-semibold">
              Project details
            </Heading>
            <p className="mb-4 text-sm text-neutral-600">
              Display name and optional dev preview command (use{" "}
              <code className="rounded bg-neutral-100 px-1 text-xs">{`{port}`}</code> in the command).
            </p>
            <form
              className="flex flex-col gap-4"
              onSubmit={handleProjectSubmit(async (v) => {
                await patchProject.mutateAsync({
                  name: v.name.trim(),
                  previewDevCommand: v.previewDevCommand?.trim() || null,
                });
              })}
            >
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">Name</label>
                <Input {...registerProject("name")} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">
                  Dev preview command (optional)
                </label>
                <Textarea
                  rows={2}
                  className="font-mono text-xs"
                  placeholder="Leave empty for auto-detect"
                  {...registerProject("previewDevCommand")}
                />
              </div>
              <Button type="submit" disabled={projectSubmitting || patchProject.isPending}>
                Save
              </Button>
            </form>
          </div>
        )}

        <div className="mb-8">
          <Heading as="h2" className="mb-3 text-base font-semibold">
            Members
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
              Invite by email
            </Heading>
            <p className="mb-4 text-sm text-neutral-600">
              They must sign in with GitHub using the same email (or accept via your configured flow).
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
              <Input type="email" placeholder="client@example.com" {...registerInvite("email")} />
              <select
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
                {...registerInvite("role")}
              >
                <option value="editor">Editor</option>
                <option value="translator">Translator</option>
                <option value="admin">Admin</option>
              </select>
              <Button type="submit" disabled={inviteSubmitting}>
                Create invite
              </Button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
