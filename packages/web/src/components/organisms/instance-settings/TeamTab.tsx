/**
 * Team management tab: list of instance members, pending invites, and
 * the invite form. Moved wholesale from the old monolithic InstanceSettings
 * page — behaviour is identical, only the wrapping chrome changed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { Input } from "@/components/atoms/Input";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";

type ProjectBadge = { id: string; name: string; role: string };
type Member = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  instanceRole: string | null;
  createdAt: number;
  projects?: ProjectBadge[];
};

type Invite = {
  id: string;
  email: string;
  expiresAt: number;
};

function roleBadgeTint(role: string): { bg: string; text: string; label: string } {
  switch (role) {
    case "admin":
      return { bg: "bg-red-100", text: "text-red-700", label: "Admin" };
    case "editor":
      return { bg: "bg-blue-100", text: "text-blue-700", label: "Collaborator" };
    case "client":
      return { bg: "bg-purple-100", text: "text-purple-700", label: "Client" };
    case "translator":
      return { bg: "bg-emerald-100", text: "text-emerald-700", label: "Translator" };
    default:
      return { bg: "bg-neutral-100", text: "text-neutral-700", label: role };
  }
}

export function TeamTab() {
  const { t } = useT();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  const { data: members } = useQuery({
    queryKey: ["admin-members"],
    queryFn: () => apiJson<{ members: Member[] }>("/api/admin/members"),
  });

  const { data: invites } = useQuery({
    queryKey: ["admin-invites"],
    queryFn: () => apiJson<{ invites: Invite[] }>("/api/admin/invites"),
  });

  const inviteMut = useMutation({
    mutationFn: (email: string) =>
      apiJson<{ ok: boolean; email: string }>("/api/admin/invites", {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    onSuccess: (res) => {
      setEmail("");
      setFeedback(`Invited ${res.email}`);
      void qc.invalidateQueries({ queryKey: ["admin-invites"] });
    },
    onError: (e: Error) => setFeedback(e.message),
  });

  const removeMut = useMutation({
    mutationFn: (userId: string) =>
      apiJson(`/api/admin/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-members"] }),
  });

  const revokeInviteMut = useMutation({
    mutationFn: (inviteId: string) =>
      apiJson(`/api/admin/invites/${inviteId}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-invites"] }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          {t("instanceSettings.tabTeam")}
        </h2>
        <p className="mt-1 text-sm text-neutral-500">{t("instanceSettings.teamDescription")}</p>
      </div>

      {/* Invite user */}
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <Heading as="h3" className="mb-1 text-base font-semibold">
          {t("instanceSettings.inviteUser")}
        </Heading>
        <p className="mb-4 text-sm text-neutral-500">{t("instanceSettings.inviteHelp")}</p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) {
              setFeedback(null);
              inviteMut.mutate(email.trim());
            }
          }}
        >
          <Input
            type="email"
            placeholder={t("instanceSettings.emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1"
          />
          <Button
            type="submit"
            className="bg-brand text-white hover:bg-brand/90"
            disabled={inviteMut.isPending}
          >
            {t("instanceSettings.invite")}
          </Button>
        </form>
        {feedback && <p className="mt-2 text-sm text-neutral-600">{feedback}</p>}
      </section>

      {/* Pending invites */}
      {invites?.invites && invites.invites.length > 0 && (
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <Heading as="h3" className="mb-4 text-base font-semibold">
            {t("instanceSettings.pendingInvites")}
          </Heading>
          <ul className="space-y-3">
            {invites.invites.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-neutral-900">{inv.email}</p>
                  <p className="text-xs text-neutral-400">
                    {t("instanceSettings.expires", {
                      date: new Date(inv.expiresAt).toLocaleDateString(),
                    })}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  className="text-xs text-neutral-500"
                  onClick={() => revokeInviteMut.mutate(inv.id)}
                  disabled={revokeInviteMut.isPending}
                >
                  {t("instanceSettings.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Members */}
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <Heading as="h3" className="mb-1 text-base font-semibold">
          {t("instanceSettings.members")}
        </Heading>
        <p className="mb-4 text-sm text-neutral-500">{t("instanceSettings.membersHelp")}</p>
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {(members?.members ?? []).length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-neutral-400">
              {t("instanceSettings.noMembers")}
            </p>
          ) : (
            (members?.members ?? []).map((m) => (
              <div key={m.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
                {m.image ? (
                  <img src={m.image} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                ) : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-neutral-100 to-neutral-200 text-[11px] font-semibold text-neutral-500">
                    {m.name?.[0]?.toUpperCase() ?? "?"}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-[13px] font-semibold text-neutral-900">
                      {m.name || m.email}
                    </p>
                    {m.instanceRole === "owner" && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                        {t("instanceSettings.instanceOwnerBadge")}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-neutral-500">{m.email}</p>
                  {m.projects && m.projects.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.projects.map((p) => {
                        const tint = roleBadgeTint(p.role);
                        return (
                          <Link
                            key={p.id}
                            to={`/p/${p.id}/settings`}
                            className={`inline-flex items-center gap-1 rounded-md ${tint.bg} px-2 py-0.5 text-[10px] font-semibold no-underline ${tint.text} hover:opacity-80`}
                            title={`Manage this member on ${p.name}`}
                          >
                            <span className="max-w-[140px] truncate">{p.name}</span>
                            <span className="opacity-60">·</span>
                            <span className="uppercase tracking-wide opacity-80">{tint.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="mt-1.5 text-[10px] italic text-neutral-400">
                      {t("instanceSettings.notInAnyProject")}
                    </p>
                  )}
                </div>
                {m.instanceRole !== "owner" && (
                  <Button
                    variant="ghost"
                    className="shrink-0 text-xs text-red-500"
                    onClick={() => {
                      if (confirm(t("instanceSettings.removeConfirm", { name: m.name || m.email }))) {
                        removeMut.mutate(m.id);
                      }
                    }}
                    disabled={removeMut.isPending}
                  >
                    {t("common.remove")}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
