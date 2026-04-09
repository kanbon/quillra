/**
 * OAuth application configuration for user sign-in (currently just
 * GitHub). Distinct from `GITHUB_TOKEN` in the API Keys tab — that's
 * Quillra's server-side PAT for repo ops; this is the OAuth app that
 * lets end-users log in with their own GitHub accounts.
 */
import { useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { SecretField, type SecretStatus } from "@/components/molecules/SecretField";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { getStatus, type StatusResponse } from "./types";

type Props = {
  status: StatusResponse | null;
  onSaved: () => void;
};

export function IntegrationsTab({ status, onSaved }: Props) {
  const { t } = useT();

  const prevClientId = status?.values.GITHUB_CLIENT_ID?.value ?? "";
  const [clientId, setClientId] = useState(prevClientId);

  const clientSecretStatus = getStatus(status, "GITHUB_CLIENT_SECRET") as SecretStatus;
  const [secretEditing, setSecretEditing] = useState(false);
  const [secretDraft, setSecretDraft] = useState("");

  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const callbackUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/auth/callback/github`
      : "/api/auth/callback/github";

  const canSave =
    clientId.trim() !== prevClientId ||
    (secretEditing && secretDraft.trim().length > 0);

  async function save() {
    setSaving(true);
    setFlash(null);
    const values: Record<string, string | null> = {};
    if (clientId.trim() !== prevClientId) {
      values.GITHUB_CLIENT_ID = clientId.trim() || null;
    }
    if (secretEditing && secretDraft.trim()) {
      values.GITHUB_CLIENT_SECRET = secretDraft.trim();
    }
    try {
      await apiJson("/api/setup/save", {
        method: "POST",
        body: JSON.stringify({ values }),
      });
      setSecretEditing(false);
      setSecretDraft("");
      setFlash(t("instanceSettings.savedFlash"));
      onSaved();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* fall through */
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          {t("instanceSettings.tabIntegrations")}
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          {t("instanceSettings.integrationsDescription")}
        </p>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <h3 className="mb-1 text-sm font-semibold text-neutral-900">
          {t("instanceSettings.ghOauthTitle")}
        </h3>
        <p className="mb-4 text-[12px] text-neutral-500">
          {t("instanceSettings.ghOauthIntro")}{" "}
          <a
            href="https://github.com/settings/developers"
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand underline-offset-2 hover:underline"
          >
            github.com/settings/developers
          </a>
        </p>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
              {t("instanceSettings.ghOauthCallback")}
            </label>
            <div className="flex items-center gap-2">
              <Input value={callbackUrl} readOnly className="flex-1 font-mono text-[12px]" />
              <button
                type="button"
                onClick={copyCallback}
                className="shrink-0 rounded-md border border-neutral-300 bg-white px-3 py-2 text-[13px] font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
              >
                {copied ? t("instanceSettings.copied") : t("instanceSettings.copyCallback")}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-neutral-500">{t("instanceSettings.ghOauthCallbackHelp")}</p>
          </div>

          <div>
            <label
              htmlFor="gh-client-id"
              className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600"
            >
              {t("instanceSettings.ghOauthClientId")}
            </label>
            <Input
              id="gh-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Iv1.abcdef0123456789"
              autoComplete="off"
            />
          </div>

          <SecretField
            label={t("instanceSettings.ghOauthClientSecret")}
            name="GITHUB_CLIENT_SECRET"
            status={clientSecretStatus}
            draft={secretDraft}
            onDraftChange={setSecretDraft}
            editing={secretEditing}
            onStartEdit={() => setSecretEditing(true)}
            onCancelEdit={() => {
              setSecretEditing(false);
              setSecretDraft("");
            }}
            placeholder="••••••••"
          />
        </div>
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
