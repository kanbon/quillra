/**
 * Per-project white-label overrides. Three knobs the project admin can
 * change:
 *
 *  - Display name shown to clients (overrides the technical project name)
 *  - Accent color (hex) used by the branded sign-in page and editor chrome
 *  - Group membership, owner-only because Groups themselves are an
 *    instance-level resource defined in Instance Settings, Groups tab
 *
 * Logo upload is intentionally NOT here, it already lives in
 * GeneralSection.tsx and rolls up automatically.
 *
 * Inheritance is handled server-side by services/branding.ts:
 *   project.brand* > group.brand* > instance.* > Quillra defaults.
 * Leaving any field blank here drops back one level in that chain.
 */

import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SectionCard } from "./SectionCard";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type Group = {
  id: string;
  name: string;
  slug: string;
  brandLogoUrl: string | null;
  brandAccentColor: string | null;
  brandDisplayName: string | null;
  brandTagline: string | null;
};

type ProjectBrandFields = {
  brandDisplayName: string | null;
  brandAccentColor: string | null;
  groupId: string | null;
};

type Props = {
  projectId: string;
  isAdmin: boolean;
  isOwner: boolean;
  initial: ProjectBrandFields;
};

export function BrandingSection({ projectId, isAdmin, isOwner, initial }: Props) {
  const { t: _t } = useT();
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(initial.brandDisplayName ?? "");
  const [accent, setAccent] = useState(initial.brandAccentColor ?? "");
  const [groupId, setGroupId] = useState<string>(initial.groupId ?? "");
  const [accentError, setAccentError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Resync when the parent re-fetches the project (e.g. after navigating
  // back to this page). Without this, the Save button would compare the
  // stale state and the field would remain dirty forever.
  useEffect(() => {
    setDisplayName(initial.brandDisplayName ?? "");
    setAccent(initial.brandAccentColor ?? "");
    setGroupId(initial.groupId ?? "");
  }, [initial.brandDisplayName, initial.brandAccentColor, initial.groupId]);

  // Owners list groups, everyone else hides the picker. The endpoint
  // itself is owner-gated server-side, so non-owners never see this.
  const groupsQ = useQuery({
    queryKey: ["admin-groups"],
    enabled: isOwner,
    queryFn: () => apiJson<{ groups: Group[] }>("/api/admin/groups"),
  });

  const saveMut = useMutation({
    mutationFn: (body: ProjectBrandFields) =>
      apiJson(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setFeedback("Saved.");
      void qc.invalidateQueries({ queryKey: ["project", projectId] });
      void qc.invalidateQueries({ queryKey: ["project-brand", projectId] });
    },
    onError: (e: Error) => setFeedback(e.message),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setAccentError(null);
    const trimmedAccent = accent.trim();
    if (trimmedAccent && !HEX_RE.test(trimmedAccent)) {
      setAccentError("Use a hex color like #C1121F");
      return;
    }
    saveMut.mutate({
      brandDisplayName: displayName.trim() || null,
      brandAccentColor: trimmedAccent || null,
      groupId: isOwner ? groupId || null : initial.groupId,
    });
  }

  const swatchColor = HEX_RE.test(accent.trim()) ? accent.trim() : "#e5e5e5";

  return (
    <SectionCard
      title="Branding"
      description="Override the brand your clients see. Leave any field blank to inherit from the group, the instance, or the Quillra default."
    >
      <form className="space-y-5" onSubmit={onSubmit}>
        <div>
          <label
            htmlFor="brand-display-name"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            Brand display name
          </label>
          <Input
            id="brand-display-name"
            placeholder="Acme Studio"
            value={displayName}
            disabled={!isAdmin || saveMut.isPending}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <p className="mt-1.5 text-[11px] text-neutral-500">
            Shown on the client sign-in page and in the editor chrome for client viewers.
          </p>
        </div>

        <div>
          <label
            htmlFor="brand-accent"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            Accent color
          </label>
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="h-9 w-9 shrink-0 rounded-md border border-neutral-200"
              style={{ backgroundColor: swatchColor }}
            />
            <Input
              id="brand-accent"
              placeholder="#C1121F"
              value={accent}
              disabled={!isAdmin || saveMut.isPending}
              onChange={(e) => setAccent(e.target.value)}
              className="font-mono"
            />
          </div>
          {accentError && <p className="mt-1.5 text-[11px] text-red-600">{accentError}</p>}
          <p className="mt-1.5 text-[11px] text-neutral-500">
            Hex format like #C1121F. Drives the primary button on the client sign-in page.
          </p>
        </div>

        {isOwner && (
          <div>
            <label
              htmlFor="brand-group"
              className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
            >
              Group
            </label>
            <select
              id="brand-group"
              value={groupId}
              disabled={saveMut.isPending}
              onChange={(e) => setGroupId(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
            >
              <option value="">(no group)</option>
              {(groupsQ.data?.groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[11px] text-neutral-500">
              Group brand fields fill in any blanks above. Manage groups in Instance Settings.
            </p>
          </div>
        )}

        {isAdmin && (
          <div className="flex items-center justify-end gap-3">
            {feedback && <span className="text-[12px] text-neutral-500">{feedback}</span>}
            <Button type="submit" disabled={saveMut.isPending}>
              {saveMut.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        )}
      </form>
    </SectionCard>
  );
}
