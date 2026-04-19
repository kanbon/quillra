import { Button } from "@/components/atoms/Button";
import { SecretField, type SecretStatus } from "@/components/molecules/SecretField";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
/**
 * Runtime credentials Quillra itself uses: Anthropic API key for the
 * chat editor. GitHub credentials live under Integrations as a GitHub
 * App — not here — because the App is the only supported auth path
 * for repo operations.
 */
import { useState } from "react";
import { type StatusResponse, getStatus } from "./types";

type Props = {
  status: StatusResponse | null;
  onSaved: () => void;
};

export function ApiKeysTab({ status, onSaved }: Props) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const anthropic = getStatus(status, "ANTHROPIC_API_KEY") as SecretStatus;
  const canSave = editing && draft.trim().length > 0;

  async function save() {
    setSaving(true);
    setFlash(null);
    try {
      await apiJson("/api/setup/save", {
        method: "POST",
        body: JSON.stringify({
          values: { ANTHROPIC_API_KEY: draft.trim() },
        }),
      });
      setEditing(false);
      setDraft("");
      setFlash(t("instanceSettings.savedFlash"));
      onSaved();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
        {t("instanceSettings.tabApiKeys")}
      </h2>

      <SecretField
        label={t("instanceSettings.keyAnthropic")}
        name="ANTHROPIC_API_KEY"
        status={anthropic}
        draft={draft}
        onDraftChange={setDraft}
        editing={editing}
        onStartEdit={() => setEditing(true)}
        onCancelEdit={() => {
          setEditing(false);
          setDraft("");
        }}
        placeholder="sk-ant-api03-…"
        helpText={t("instanceSettings.keyAnthropicHelp")}
        docsHref="https://console.anthropic.com/settings/keys"
        docsLabel={t("instanceSettings.getAnthropicKey")}
      />

      <div className="flex items-center justify-between border-t border-neutral-100 pt-4">
        <Button type="button" onClick={save} disabled={!canSave || saving}>
          {saving ? t("instanceSettings.saving") : t("instanceSettings.saveChanges")}
        </Button>
        {flash && <p className="text-sm text-neutral-500">{flash}</p>}
      </div>
    </div>
  );
}
