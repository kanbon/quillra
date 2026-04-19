/**
 * Project-level team roster: current members (with per-row remove
 * button for admins), pending invites with revoke, and the "Invite"
 * button that opens the shared InviteMemberModal.
 *
 * Extracted out of packages/web/src/pages/ProjectSettings.tsx. Logic
 * and markup were moved verbatim, no behaviour change.
 */

import { InviteMemberModal } from "@/components/organisms/InviteMemberModal";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { SectionCard } from "./SectionCard";
import type { Member, PendingInvite } from "./types";
import { initialsOf, roleBadgeColor } from "./types";

type Props = {
  projectId: string;
  isAdmin: boolean;
};

export function TeamSection({ projectId, isAdmin }: Props) {
  const { t } = useT();
  const id = projectId;
  const [inviteOpen, setInviteOpen] = useState(false);

  const membersQ = useQuery({
    queryKey: ["members", id],
    enabled: !!id,
    queryFn: () => apiJson<{ members: Member[] }>(`/api/team/projects/${id}/members`),
  });

  const pendingInvitesQ = useQuery({
    queryKey: ["pending-invites", id],
    enabled: !!id && isAdmin,
    queryFn: () => apiJson<{ invites: PendingInvite[] }>(`/api/team/projects/${id}/invites`),
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

  const currentUserId = membersQ.data?.members.find((m) => m.role === "admin")?.userId;

  return (
    <>
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

      <InviteMemberModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        projectId={id}
        onInvited={() => {
          void membersQ.refetch();
          void pendingInvitesQ.refetch();
        }}
      />
    </>
  );
}
