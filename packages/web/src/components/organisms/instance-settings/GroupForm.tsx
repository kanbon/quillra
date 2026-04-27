/**
 * Inline create/edit form for a brand group. Lives next to GroupsTab,
 * not a barrel re-export, GroupsTab imports it directly.
 *
 * Owns nothing: parent passes the draft state and submit handler so
 * GroupsTab can wipe / mutate from a single place.
 */

import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export type GroupDraft = {
  name: string;
  slug: string;
  brandDisplayName: string;
  brandAccentColor: string;
  brandTagline: string;
};

type Props = {
  mode: "new" | "edit";
  draft: GroupDraft;
  setDraft: React.Dispatch<React.SetStateAction<GroupDraft>>;
  onNameChange: (name: string) => void;
  onSlugChange: (slug: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
};

export function GroupForm({
  mode,
  draft,
  setDraft,
  onNameChange,
  onSlugChange,
  onSubmit,
  onCancel,
  submitting,
  error,
}: Props) {
  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5"
    >
      <h3 className="text-[14px] font-semibold tracking-tight text-neutral-900">
        {mode === "new" ? "New group" : "Edit group"}
      </h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="group-name">
          <Input
            id="group-name"
            value={draft.name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Acme Studio"
          />
        </Field>
        <Field label="Slug" htmlFor="group-slug">
          <Input
            id="group-slug"
            value={draft.slug}
            onChange={(e) => onSlugChange(e.target.value)}
            placeholder="acme-studio"
            className="font-mono"
          />
        </Field>
        <Field label="Brand display name" htmlFor="group-brand-display">
          <Input
            id="group-brand-display"
            value={draft.brandDisplayName}
            onChange={(e) => setDraft((d) => ({ ...d, brandDisplayName: e.target.value }))}
            placeholder="(optional)"
          />
        </Field>
        <Field label="Accent color (hex)" htmlFor="group-brand-accent">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-9 w-9 shrink-0 rounded-md border border-neutral-200"
              style={{
                backgroundColor: HEX_RE.test(draft.brandAccentColor.trim())
                  ? draft.brandAccentColor.trim()
                  : "#e5e5e5",
              }}
            />
            <Input
              id="group-brand-accent"
              value={draft.brandAccentColor}
              onChange={(e) => setDraft((d) => ({ ...d, brandAccentColor: e.target.value }))}
              placeholder="#C1121F"
              className="font-mono"
            />
          </div>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Tagline" htmlFor="group-brand-tagline">
            <Input
              id="group-brand-tagline"
              value={draft.brandTagline}
              onChange={(e) => setDraft((d) => ({ ...d, brandTagline: e.target.value }))}
              placeholder="(optional)"
            />
          </Field>
        </div>
      </div>
      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : mode === "new" ? "Create group" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
