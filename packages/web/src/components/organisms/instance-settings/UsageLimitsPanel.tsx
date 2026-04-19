import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
/**
 * Spend-controls panel rendered beneath the Usage tables. Edits three
 * scopes of usage_limits rows (global, role, user) plus the alert
 * recipient email. Saves the whole shape in one POST so the UI can stay
 * a simple form — no per-row save buttons, no optimistic merges.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

type LimitRow = {
  scope: "global" | "role" | "user";
  target: string;
  warn_usd: number | null;
  hard_usd: number | null;
};

type LimitsResponse = {
  rows: LimitRow[];
  alertEmail: string;
  fallbackEmail: string;
};

type UserOption = { id: string; name: string; email: string };

const ROLES: Array<{ id: string; label: string }> = [
  { id: "admin", label: "Admins" },
  { id: "editor", label: "Editors" },
  { id: "client", label: "Clients" },
];

type DraftRow = {
  scope: "global" | "role" | "user";
  target: string;
  /** Empty string = inherit (the server interprets as null). */
  warnStr: string;
  hardStr: string;
};

function toDraft(row: LimitRow | undefined, scope: DraftRow["scope"], target: string): DraftRow {
  return {
    scope,
    target,
    warnStr: row?.warn_usd != null ? String(row.warn_usd) : "",
    hardStr: row?.hard_usd != null ? String(row.hard_usd) : "",
  };
}

function parseNullableNumber(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function UsageLimitsPanel({ users }: { users: UserOption[] }) {
  const { t } = useT();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [alertEmail, setAlertEmail] = useState("");
  const [alertEmailPlaceholder, setAlertEmailPlaceholder] = useState("");
  const [drafts, setDrafts] = useState<DraftRow[]>([]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiJson<LimitsResponse>("/api/admin/usage/limits");
      setAlertEmail(res.alertEmail ?? "");
      setAlertEmailPlaceholder(res.fallbackEmail ?? "");
      const byKey = new Map<string, LimitRow>();
      for (const r of res.rows) byKey.set(`${r.scope}::${r.target}`, r);
      const next: DraftRow[] = [];
      next.push(toDraft(byKey.get("global::"), "global", ""));
      for (const role of ROLES) {
        next.push(toDraft(byKey.get(`role::${role.id}`), "role", role.id));
      }
      for (const r of res.rows) {
        if (r.scope === "user") next.push(toDraft(r, "user", r.target));
      }
      setDrafts(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateDraft = (scope: DraftRow["scope"], target: string, patch: Partial<DraftRow>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.scope === scope && d.target === target ? { ...d, ...patch } : d)),
    );
  };

  const addUserOverride = (userId: string) => {
    setDrafts((prev) => {
      if (prev.some((d) => d.scope === "user" && d.target === userId)) return prev;
      return [...prev, { scope: "user", target: userId, warnStr: "", hardStr: "" }];
    });
  };

  const removeUserOverride = (userId: string) => {
    setDrafts((prev) => prev.filter((d) => !(d.scope === "user" && d.target === userId)));
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        alertEmail: alertEmail.trim(),
        rows: drafts.map((d) => ({
          scope: d.scope,
          target: d.target,
          warnUsd: parseNullableNumber(d.warnStr),
          hardUsd: parseNullableNumber(d.hardStr),
        })),
      };
      await apiJson("/api/admin/usage/limits", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setSavedAt(Date.now());
      await load();
    } finally {
      setSaving(false);
    }
  };

  const userDrafts = useMemo(() => drafts.filter((d) => d.scope === "user"), [drafts]);
  const globalDraft = drafts.find((d) => d.scope === "global") ?? {
    scope: "global" as const,
    target: "",
    warnStr: "",
    hardStr: "",
  };
  const roleDrafts = useMemo(
    () =>
      ROLES.map((role) => ({
        role,
        draft: drafts.find((d) => d.scope === "role" && d.target === role.id) ?? {
          scope: "role" as const,
          target: role.id,
          warnStr: "",
          hardStr: "",
        },
      })),
    [drafts],
  );

  const availableToAdd = users.filter((u) => !userDrafts.some((d) => d.target === u.id));
  const userNameById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  if (loading) return null;

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="mb-4">
        <h3 className="text-[14px] font-semibold text-neutral-900">{t("usage.limitsTitle")}</h3>
        <p className="mt-1 text-[12px] text-neutral-500">{t("usage.limitsSubtitle")}</p>
      </div>

      <div className="mb-5">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          {t("usage.limitsAlertEmail")}
        </label>
        <Input
          type="email"
          value={alertEmail}
          onChange={(e) => setAlertEmail(e.target.value)}
          placeholder={alertEmailPlaceholder || "owner@example.com"}
        />
        <p className="mt-1 text-[11px] text-neutral-400">{t("usage.limitsAlertEmailHelp")}</p>
      </div>

      <ScopeBlock title={t("usage.limitsScopeGlobal")}>
        <LimitRowFields
          label={t("usage.limitsScopeGlobal")}
          draft={globalDraft}
          onChange={(patch) => updateDraft("global", "", patch)}
        />
      </ScopeBlock>

      <ScopeBlock title={t("usage.limitsScopeRole")}>
        <div className="space-y-2">
          {roleDrafts.map(({ role, draft }) => (
            <LimitRowFields
              key={role.id}
              label={role.label}
              draft={draft}
              onChange={(patch) => updateDraft("role", role.id, patch)}
            />
          ))}
        </div>
      </ScopeBlock>

      <ScopeBlock title={t("usage.limitsScopeUser")}>
        <div className="space-y-2">
          {userDrafts.map((draft) => {
            const u = userNameById.get(draft.target);
            return (
              <LimitRowFields
                key={draft.target}
                label={u ? `${u.name} · ${u.email}` : draft.target}
                draft={draft}
                onChange={(patch) => updateDraft("user", draft.target, patch)}
                onRemove={() => removeUserOverride(draft.target)}
                removeLabel={t("usage.limitsRemove")}
              />
            );
          })}
          {availableToAdd.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <select
                className="flex-1 rounded-md border border-neutral-200 bg-white px-3 py-2 text-[13px] text-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-400"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    addUserOverride(e.target.value);
                    e.currentTarget.value = "";
                  }
                }}
              >
                <option value="">{t("usage.limitsAddUser")}</option>
                {availableToAdd.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.email}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </ScopeBlock>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-neutral-100 pt-4">
        {savedAt && <span className="text-[11px] text-emerald-600">{t("usage.limitsSaved")}</span>}
        <Button variant="primary" onClick={save} disabled={saving} className="ml-auto">
          {t("usage.limitsSave")}
        </Button>
      </div>
    </section>
  );
}

function ScopeBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </p>
      {children}
    </div>
  );
}

function LimitRowFields({
  label,
  draft,
  onChange,
  onRemove,
  removeLabel,
}: {
  label: string;
  draft: DraftRow;
  onChange: (patch: Partial<DraftRow>) => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-700">{label}</span>
      <LabeledInput
        label={t("usage.limitsWarn")}
        value={draft.warnStr}
        onChange={(v) => onChange({ warnStr: v })}
      />
      <LabeledInput
        label={t("usage.limitsHard")}
        value={draft.hardStr}
        onChange={(v) => onChange({ hardStr: v })}
      />
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800"
        >
          {removeLabel}
        </button>
      )}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-neutral-400">{label}</span>
      <input
        type="number"
        min={0}
        step={0.01}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
        className="w-20 rounded-md border border-neutral-200 bg-white px-2 py-1 text-right text-[13px] tabular-nums text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-400"
      />
    </label>
  );
}
