/**
 * Owner-only Groups tab. A "group" is a layer between the instance and
 * a project where shared brand fields (display name, logo, accent color,
 * tagline) live, useful for an agency that runs many client projects
 * with the same template branding.
 *
 * CRUD against /api/admin/groups. Inheritance is project > group >
 * instance > Quillra default and is resolved server-side by
 * services/branding.ts, so this tab only needs to deal with raw fields.
 *
 * Inline form for new + edit (see GroupForm.tsx). We don't open a modal
 * because there are very few fields and we want owners to scan the list
 * at a glance without losing context.
 */

import { Button } from "@/components/atoms/Button";
import { apiJson } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type GroupDraft, GroupForm } from "./GroupForm";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type Group = {
  id: string;
  name: string;
  slug: string;
  brandLogoUrl: string | null;
  brandAccentColor: string | null;
  brandDisplayName: string | null;
  brandTagline: string | null;
  projectCount?: number;
};

type GroupsResponse = { groups: Group[] };

const EMPTY_DRAFT: GroupDraft = {
  name: "",
  slug: "",
  brandDisplayName: "",
  brandAccentColor: "",
  brandTagline: "",
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function draftFromGroup(g: Group): GroupDraft {
  return {
    name: g.name,
    slug: g.slug,
    brandDisplayName: g.brandDisplayName ?? "",
    brandAccentColor: g.brandAccentColor ?? "",
    brandTagline: g.brandTagline ?? "",
  };
}

function bodyFromDraft(d: GroupDraft): {
  name: string;
  slug: string;
  brandDisplayName: string | null;
  brandAccentColor: string | null;
  brandTagline: string | null;
} {
  return {
    name: d.name.trim(),
    slug: d.slug.trim(),
    brandDisplayName: d.brandDisplayName.trim() || null,
    brandAccentColor: d.brandAccentColor.trim() || null,
    brandTagline: d.brandTagline.trim() || null,
  };
}

export function GroupsTab() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<GroupDraft>(EMPTY_DRAFT);
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupsQ = useQuery({
    queryKey: ["admin-groups"],
    queryFn: () => apiJson<GroupsResponse>("/api/admin/groups"),
  });

  const createMut = useMutation({
    mutationFn: (body: ReturnType<typeof bodyFromDraft>) =>
      apiJson("/api/admin/groups", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-groups"] });
      cancelEdit();
    },
    onError: (e: Error) => setError(e.message),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReturnType<typeof bodyFromDraft> }) =>
      apiJson(`/api/admin/groups/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-groups"] });
      cancelEdit();
    },
    onError: (e: Error) => setError(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiJson(`/api/admin/groups/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-groups"] }),
    onError: (e: Error) => setError(e.message),
  });

  function cancelEdit() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setSlugTouched(false);
    setError(null);
  }

  function startNew() {
    setEditingId("new");
    setDraft(EMPTY_DRAFT);
    setSlugTouched(false);
    setError(null);
  }

  function startEdit(g: Group) {
    setEditingId(g.id);
    setDraft(draftFromGroup(g));
    setSlugTouched(true);
    setError(null);
  }

  function onNameChange(name: string) {
    setDraft((d) => ({
      ...d,
      name,
      slug: slugTouched ? d.slug : slugify(name),
    }));
  }

  function onSlugChange(slug: string) {
    setSlugTouched(true);
    setDraft((d) => ({ ...d, slug }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!draft.name.trim()) {
      setError("Name is required");
      return;
    }
    if (!draft.slug.trim()) {
      setError("Slug is required");
      return;
    }
    if (draft.brandAccentColor.trim() && !HEX_RE.test(draft.brandAccentColor.trim())) {
      setError("Accent color must be a hex like #C1121F");
      return;
    }
    const body = bodyFromDraft(draft);
    if (editingId === "new") createMut.mutate(body);
    else if (editingId) updateMut.mutate({ id: editingId, body });
  }

  function onDelete(g: Group) {
    if (
      !confirm(
        `Delete the group "${g.name}"? Projects in this group keep working but inherit instance defaults again.`,
      )
    ) {
      return;
    }
    deleteMut.mutate(g.id);
  }

  const submitting = createMut.isPending || updateMut.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">Groups</h2>
        <p className="mt-1.5 text-sm text-neutral-500">
          A group is a brand layer between this instance and a project. Useful when an agency runs
          many client projects under the same parent brand. Project-level fields override group
          fields, group fields override instance defaults.
        </p>
      </div>

      <div className="flex justify-end">
        {editingId === null && (
          <Button type="button" onClick={startNew}>
            New group
          </Button>
        )}
      </div>

      {editingId !== null && (
        <GroupForm
          mode={editingId === "new" ? "new" : "edit"}
          draft={draft}
          setDraft={setDraft}
          onNameChange={onNameChange}
          onSlugChange={onSlugChange}
          onSubmit={onSubmit}
          onCancel={cancelEdit}
          submitting={submitting}
          error={error}
        />
      )}

      <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        {(groupsQ.data?.groups ?? []).length === 0 ? (
          <p className="px-4 py-8 text-center text-[12px] text-neutral-400">
            No groups yet. Create one to share brand fields across multiple projects.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {(groupsQ.data?.groups ?? []).map((g) => (
              <li key={g.id} className="flex items-center gap-3 px-4 py-3">
                <span
                  aria-hidden
                  className="h-8 w-8 shrink-0 rounded-md border border-neutral-200"
                  style={{
                    backgroundColor:
                      g.brandAccentColor && HEX_RE.test(g.brandAccentColor)
                        ? g.brandAccentColor
                        : "#f5f5f5",
                  }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-neutral-900">{g.name}</p>
                  <p className="truncate text-[11px] text-neutral-500">
                    <span className="font-mono">{g.slug}</span>
                    <span className="px-1.5 text-neutral-300">·</span>
                    {(g.projectCount ?? 0) === 1 ? "1 project" : `${g.projectCount ?? 0} projects`}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-[12px]"
                  onClick={() => startEdit(g)}
                  disabled={editingId !== null}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-[12px] text-red-600"
                  onClick={() => onDelete(g)}
                  disabled={deleteMut.isPending}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
