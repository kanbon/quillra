import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { Input } from "@/components/atoms/Input";
import { LogoMark } from "@/components/atoms/LogoMark";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";

type Organization = {
  instanceName: string;
  operatorName: string | null;
  company: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
};

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

type Invite = {
  id: string;
  email: string;
  expiresAt: number;
};

export function InstanceSettingsPage() {
  const { t } = useT();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [org, setOrg] = useState<Organization>({
    instanceName: "Quillra",
    operatorName: "",
    company: "",
    email: "",
    address: "",
    website: "",
  });
  const [orgFeedback, setOrgFeedback] = useState<string | null>(null);
  const [orgSaving, setOrgSaving] = useState(false);

  // Load organization info once on mount
  useEffect(() => {
    (async () => {
      try {
        const o = await apiJson<Organization>("/api/instance/organization");
        setOrg({
          instanceName: o.instanceName ?? "Quillra",
          operatorName: o.operatorName ?? "",
          company: o.company ?? "",
          email: o.email ?? "",
          address: o.address ?? "",
          website: o.website ?? "",
        });
      } catch { /* ignore */ }
    })();
  }, []);

  async function saveOrg() {
    setOrgSaving(true);
    setOrgFeedback(null);
    try {
      await apiJson("/api/setup/save", {
        method: "POST",
        body: JSON.stringify({
          values: {
            INSTANCE_NAME: org.instanceName.trim() || null,
            INSTANCE_OPERATOR_NAME: (org.operatorName ?? "").trim() || null,
            INSTANCE_OPERATOR_COMPANY: (org.company ?? "").trim() || null,
            INSTANCE_OPERATOR_EMAIL: (org.email ?? "").trim() || null,
            INSTANCE_OPERATOR_ADDRESS: (org.address ?? "").trim() || null,
            INSTANCE_OPERATOR_WEBSITE: (org.website ?? "").trim() || null,
          },
        }),
      });
      setOrgFeedback("Saved.");
    } catch (e) {
      setOrgFeedback(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setOrgSaving(false);
    }
  }

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
    <div className="min-h-screen bg-neutral-50">
      <header className="flex h-14 shrink-0 items-center border-b border-neutral-200 bg-white px-4">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
          <Link to="/dashboard" className="flex items-center gap-2 no-underline">
            <LogoMark size={22} />
          </Link>
          <div className="h-6 w-px bg-neutral-200" />
          <Heading as="h1" className="text-base font-semibold">{t("instanceSettings.title")}</Heading>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
        <section className="rounded-2xl border border-neutral-200 bg-white p-6">
          <Heading as="h2" className="mb-1 text-base font-semibold">Organisation</Heading>
          <p className="mb-4 text-sm text-neutral-500">
            Contact details for whoever operates this Quillra instance.
          </p>
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-[12px] leading-relaxed text-amber-800">
            <strong className="font-semibold">Publicly visible.</strong> These values appear in every email footer and on the public{" "}
            <Link to="/impressum" className="underline-offset-2 hover:underline">/impressum</Link> page.
          </div>
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                Instance name
              </label>
              <Input
                value={org.instanceName}
                onChange={(e) => setOrg({ ...org, instanceName: e.target.value })}
                placeholder="Quillra"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  Your name
                </label>
                <Input
                  value={org.operatorName ?? ""}
                  onChange={(e) => setOrg({ ...org, operatorName: e.target.value })}
                  placeholder="Jane Doe"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  Company
                </label>
                <Input
                  value={org.company ?? ""}
                  onChange={(e) => setOrg({ ...org, company: e.target.value })}
                  placeholder="Acme Studio GmbH"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                Contact email
              </label>
              <Input
                type="email"
                value={org.email ?? ""}
                onChange={(e) => setOrg({ ...org, email: e.target.value })}
                placeholder="hello@yourdomain.com"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                Postal address
              </label>
              <textarea
                rows={3}
                value={org.address ?? ""}
                onChange={(e) => setOrg({ ...org, address: e.target.value })}
                placeholder={"Musterstraße 1\n1010 Vienna\nAustria"}
                className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                Website
              </label>
              <Input
                type="url"
                value={org.website ?? ""}
                onChange={(e) => setOrg({ ...org, website: e.target.value })}
                placeholder="https://yourdomain.com"
              />
            </div>
            <div className="flex items-center justify-between">
              <Button type="button" onClick={saveOrg} disabled={orgSaving}>
                {orgSaving ? "Saving…" : "Save organisation"}
              </Button>
              {orgFeedback && <p className="text-sm text-neutral-500">{orgFeedback}</p>}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-neutral-200 bg-white p-6">
          <Heading as="h2" className="mb-1 text-base font-semibold">{t("instanceSettings.inviteUser")}</Heading>
          <p className="mb-4 text-sm text-neutral-500">
            {t("instanceSettings.inviteHelp")}
          </p>
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
            <Button type="submit" className="bg-brand text-white hover:bg-brand/90" disabled={inviteMut.isPending}>
              {t("instanceSettings.invite")}
            </Button>
          </form>
          {feedback && (
            <p className="mt-2 text-sm text-neutral-600">{feedback}</p>
          )}
        </section>

        {invites?.invites && invites.invites.length > 0 && (
          <section className="rounded-2xl border border-neutral-200 bg-white p-6">
            <Heading as="h2" className="mb-4 text-base font-semibold">{t("instanceSettings.pendingInvites")}</Heading>
            <ul className="space-y-3">
              {invites.invites.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-neutral-900">{inv.email}</p>
                    <p className="text-xs text-neutral-400">
                      {t("instanceSettings.expires", { date: new Date(inv.expiresAt).toLocaleDateString() })}
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

        <section className="rounded-2xl border border-neutral-200 bg-white p-6">
          <Heading as="h2" className="mb-1 text-base font-semibold">{t("instanceSettings.members")}</Heading>
          <p className="mb-4 text-sm text-neutral-500">
            Everyone who has a Quillra account on this instance, and which projects they can access.
          </p>
          <div className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
            {(members?.members ?? []).length === 0 ? (
              <p className="px-4 py-6 text-center text-[12px] text-neutral-400">No members yet.</p>
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
                      <p className="truncate text-[13px] font-semibold text-neutral-900">{m.name || m.email}</p>
                      {m.instanceRole === "owner" && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                          Instance owner
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[11px] text-neutral-500">{m.email}</p>
                    {/* Per-project badges */}
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
                      <p className="mt-1.5 text-[10px] italic text-neutral-400">Not a member of any project yet.</p>
                    )}
                  </div>
                  {m.instanceRole !== "owner" && (
                    <Button
                      variant="ghost"
                      className="shrink-0 text-xs text-red-500"
                      onClick={() => {
                        if (confirm(`Remove ${m.name || m.email} from this instance? This revokes access to all projects.`)) {
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
    </div>
  );
}
