/**
 * Runtime credentials Quillra itself uses: Anthropic API key for the
 * chat editor, GitHub PAT for cloning/pushing. Rotating either is safe
 * — in-flight requests finish with the old value; the next request
 * picks up the new one via getInstanceSetting().
 */
import { useState } from "react";
import { Button } from "@/components/atoms/Button";
import { SecretField, type SecretStatus } from "@/components/molecules/SecretField";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { getStatus, type StatusResponse } from "./types";

type Props = {
  status: StatusResponse | null;
  onSaved: () => void;
};

type EditState = {
  ANTHROPIC_API_KEY: boolean;
  GITHUB_TOKEN: boolean;
};

type DraftState = {
  ANTHROPIC_API_KEY: string;
  GITHUB_TOKEN: string;
};

export function ApiKeysTab({ status, onSaved }: Props) {
  const { t } = useT();
  const [editing, setEditing] = useState<EditState>({
    ANTHROPIC_API_KEY: false,
    GITHUB_TOKEN: false,
  });
  const [draft, setDraft] = useState<DraftState>({
    ANTHROPIC_API_KEY: "",
    GITHUB_TOKEN: "",
  });
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const anthropic = getStatus(status, "ANTHROPIC_API_KEY") as SecretStatus;
  const github = getStatus(status, "GITHUB_TOKEN") as SecretStatus;

  const canSave =
    (editing.ANTHROPIC_API_KEY && draft.ANTHROPIC_API_KEY.trim().length > 0) ||
    (editing.GITHUB_TOKEN && draft.GITHUB_TOKEN.trim().length > 0);

  async function save() {
    setSaving(true);
    setFlash(null);
    const values: Record<string, string | null> = {};
    if (editing.ANTHROPIC_API_KEY && draft.ANTHROPIC_API_KEY.trim()) {
      values.ANTHROPIC_API_KEY = draft.ANTHROPIC_API_KEY.trim();
    }
    if (editing.GITHUB_TOKEN && draft.GITHUB_TOKEN.trim()) {
      values.GITHUB_TOKEN = draft.GITHUB_TOKEN.trim();
    }
    try {
      await apiJson("/api/setup/save", {
        method: "POST",
        body: JSON.stringify({ values }),
      });
      // Collapse all editing states and clear drafts so the component
      // drops all plaintext from memory.
      setEditing({ ANTHROPIC_API_KEY: false, GITHUB_TOKEN: false });
      setDraft({ ANTHROPIC_API_KEY: "", GITHUB_TOKEN: "" });
      setFlash(t("instanceSettings.savedFlash"));
      onSaved();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit(key: keyof EditState) {
    setEditing((s) => ({ ...s, [key]: false }));
    setDraft((d) => ({ ...d, [key]: "" }));
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          {t("instanceSettings.tabApiKeys")}
        </h2>
        <p className="mt-1 text-sm text-neutral-500">{t("instanceSettings.apiKeysDescription")}</p>
      </div>

      <div className="space-y-6">
        <SecretField
          label={t("instanceSettings.keyAnthropic")}
          name="ANTHROPIC_API_KEY"
          status={anthropic}
          draft={draft.ANTHROPIC_API_KEY}
          onDraftChange={(v) => setDraft((d) => ({ ...d, ANTHROPIC_API_KEY: v }))}
          editing={editing.ANTHROPIC_API_KEY}
          onStartEdit={() => setEditing((s) => ({ ...s, ANTHROPIC_API_KEY: true }))}
          onCancelEdit={() => cancelEdit("ANTHROPIC_API_KEY")}
          placeholder="sk-ant-api03-…"
          helpText={t("instanceSettings.keyAnthropicHelp")}
          docsHref="https://console.anthropic.com/settings/keys"
          docsLabel={t("instanceSettings.getAnthropicKey")}
        />

        <SecretField
          label={t("instanceSettings.keyGithubToken")}
          name="GITHUB_TOKEN"
          status={github}
          draft={draft.GITHUB_TOKEN}
          onDraftChange={(v) => setDraft((d) => ({ ...d, GITHUB_TOKEN: v }))}
          editing={editing.GITHUB_TOKEN}
          onStartEdit={() => setEditing((s) => ({ ...s, GITHUB_TOKEN: true }))}
          onCancelEdit={() => cancelEdit("GITHUB_TOKEN")}
          placeholder="ghp_…"
          helpText={t("instanceSettings.keyGithubTokenHelp")}
          docsHref="https://github.com/settings/tokens/new?scopes=repo&description=Quillra"
          docsLabel={t("instanceSettings.getGithubToken")}
        />
      </div>

      <div className="flex items-center justify-between border-t border-neutral-100 pt-4">
        <Button type="button" onClick={save} disabled={!canSave || saving}>
          {saving ? t("instanceSettings.saving") : t("instanceSettings.saveChanges")}
        </Button>
        {flash && <p className="text-sm text-neutral-500">{flash}</p>}
      </div>
    </div>
  );
}
