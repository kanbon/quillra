import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { Input } from "@/components/atoms/Input";
import { LogoMark } from "@/components/atoms/LogoMark";
import { apiJson } from "@/lib/api";

type Member = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  instanceRole: string | null;
  createdAt: number;
};

type Invite = {
  id: string;
  email: string;
  expiresAt: number;
};

export function InstanceSettingsPage() {
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
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Link to="/dashboard" className="flex items-center gap-2 no-underline">
            <LogoMark size={22} />
          </Link>
          <div className="h-6 w-px bg-neutral-200" />
          <Heading as="h1" className="text-lg font-semibold">Instance Settings</Heading>
        </div>
      </header>

      <div className="mx-auto max-w-2xl space-y-8 px-6 py-8">
        <section className="rounded-2xl border border-neutral-200 bg-white p-6">
          <Heading as="h2" className="mb-1 text-base font-semibold">Invite user</Heading>
          <p className="mb-4 text-sm text-neutral-500">
            Only invited users can sign into this instance.
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
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" className="bg-brand text-white hover:bg-brand/90" disabled={inviteMut.isPending}>
              Invite
            </Button>
          </form>
          {feedback && (
            <p className="mt-2 text-sm text-neutral-600">{feedback}</p>
          )}
        </section>

        {invites?.invites && invites.invites.length > 0 && (
          <section className="rounded-2xl border border-neutral-200 bg-white p-6">
            <Heading as="h2" className="mb-4 text-base font-semibold">Pending invites</Heading>
            <ul className="space-y-3">
              {invites.invites.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-neutral-900">{inv.email}</p>
                    <p className="text-xs text-neutral-400">
                      Expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    className="text-xs text-neutral-500"
                    onClick={() => revokeInviteMut.mutate(inv.id)}
                    disabled={revokeInviteMut.isPending}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-2xl border border-neutral-200 bg-white p-6">
          <Heading as="h2" className="mb-4 text-base font-semibold">Members</Heading>
          <ul className="space-y-3">
            {members?.members.map((m) => (
              <li key={m.id} className="flex items-center gap-3">
                {m.image ? (
                  <img src={m.image} alt="" className="h-8 w-8 rounded-full" />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-200 text-xs font-medium text-neutral-600">
                    {m.name?.[0]?.toUpperCase() ?? "?"}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-neutral-900">{m.name}</p>
                  <p className="truncate text-xs text-neutral-500">{m.email}</p>
                </div>
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
                  {m.instanceRole ?? "—"}
                </span>
                {m.instanceRole !== "owner" && (
                  <Button
                    variant="ghost"
                    className="text-xs text-red-500"
                    onClick={() => removeMut.mutate(m.id)}
                    disabled={removeMut.isPending}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
