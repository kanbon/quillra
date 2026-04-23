/**
 * Permissions tab, owner-only.
 *
 * Each project role (admin, editor, client) has a plain-English prompt
 * fragment that shapes how the agent talks to users with that role. The
 * security boundary is still the per-role tool allow-list on the server;
 * this is behavior guidance, not access control.
 *
 * Shows one card per role with a textarea. "Save" sends PUT, "Reset to
 * default" sends DELETE. Unsaved edits show a subtle "unsaved" dot.
 */

import { apiJson } from "@/lib/api";
import { useCallback, useEffect, useState } from "react";

type RoleName = "admin" | "editor" | "client";

type RoleRow = {
  role: RoleName;
  prompt: string;
  isCustom: boolean;
  defaultPrompt: string;
  updatedAt: number | null;
};

type ListResponse = { roles: RoleRow[] };

const ROLE_LABELS: Record<RoleName, { name: string; blurb: string }> = {
  admin: {
    name: "Admin",
    blurb: "Full access. Team members who manage the project.",
  },
  editor: {
    name: "Editor",
    blurb: "Can edit content and layout. Asks before touching build config.",
  },
  client: {
    name: "Client",
    blurb: "The site owner. Non-technical. Plain language, no file paths.",
  },
};

export function PermissionsTab() {
  const [rows, setRows] = useState<RoleRow[]>([]);
  const [drafts, setDrafts] = useState<Record<RoleName, string>>({
    admin: "",
    editor: "",
    client: "",
  });
  const [saving, setSaving] = useState<RoleName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiJson<ListResponse>("/api/admin/role-prompts");
      setRows(r.roles);
      setDrafts({
        admin: r.roles.find((x) => x.role === "admin")?.prompt ?? "",
        editor: r.roles.find((x) => x.role === "editor")?.prompt ?? "",
        client: r.roles.find((x) => x.role === "client")?.prompt ?? "",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  async function save(role: RoleName) {
    const prompt = drafts[role].trim();
    if (!prompt) return;
    setSaving(role);
    setError(null);
    try {
      await apiJson(`/api/admin/role-prompts/${role}`, {
        method: "PUT",
        body: JSON.stringify({ prompt }),
      });
      setToast(`${ROLE_LABELS[role].name} prompt saved.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(null);
    }
  }

  async function reset(role: RoleName) {
    setSaving(role);
    setError(null);
    try {
      await apiJson(`/api/admin/role-prompts/${role}`, { method: "DELETE" });
      setToast(`${ROLE_LABELS[role].name} reset to default.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-neutral-900">
          Role permissions
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-600">
          A plain-English briefing the AI reads at the start of every chat. It shapes how the
          assistant talks to users of each role: tone, what to confirm, what to suggest escalating
          to a developer. The hard security boundary (which tools can be called) is set in code;
          this is the voice.
        </p>
      </div>

      {rows.map((row) => {
        const label = ROLE_LABELS[row.role];
        const draft = drafts[row.role];
        const dirty = draft.trim() !== row.prompt.trim();
        const canSave = !dirty ? false : draft.trim().length > 0;
        const isSaving = saving === row.role;
        return (
          <section key={row.role} className="rounded-xl border border-neutral-200 bg-white p-5">
            <header className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-[14px] font-semibold tracking-tight text-neutral-900">
                    {label.name}
                  </h3>
                  {row.isCustom ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                      Custom
                    </span>
                  ) : (
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                      Default
                    </span>
                  )}
                  {dirty && (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-neutral-400"
                      title="Unsaved changes"
                    />
                  )}
                </div>
                <p className="mt-0.5 text-[12px] text-neutral-500">{label.blurb}</p>
              </div>
            </header>
            <textarea
              value={draft}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [row.role]: e.target.value }))}
              rows={8}
              spellCheck={false}
              className="block w-full rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2.5 font-mono text-[12px] leading-[1.55] outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => reset(row.role)}
                disabled={isSaving || !row.isCustom}
                className="text-[12px] font-medium text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                title={
                  row.isCustom
                    ? "Drop the custom prompt and use the built-in default"
                    : "Already using the default"
                }
              >
                Reset to default
              </button>
              <button
                type="button"
                onClick={() => save(row.role)}
                disabled={isSaving || !canSave}
                className="inline-flex h-9 items-center rounded-lg bg-neutral-900 px-4 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? "Saving…" : dirty ? "Save changes" : "Saved"}
              </button>
            </div>
          </section>
        );
      })}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error}
        </div>
      )}
      {toast && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-[13px] text-green-700">
          {toast}
        </div>
      )}
    </div>
  );
}
