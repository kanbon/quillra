/**
 * Integrations tab, two separate GitHub configurations stacked in one view:
 *
 *   1. GitHub App (top, primary): the one that commits to repos. Its
 *      credentials are set through the setup-wizard manifest flow, or
 *      via GITHUB_APP_* env vars. Shown here as read-only status with
 *      buttons to re-create, install on more repos, and rotate.
 *
 *   2. GitHub OAuth App (bottom, optional): lets users link their
 *      GitHub account for wizard sign-in. Owner-editable here because
 *      it's the one thing the wizard can't self-bootstrap.
 */

import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { SecretField, type SecretStatus } from "@/components/molecules/SecretField";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { useEffect, useState } from "react";
import { type StatusResponse, getStatus } from "./types";

type Props = {
  status: StatusResponse | null;
  onSaved: () => void;
};

type Installation = {
  id: number;
  account: { login: string; type: string; avatar_url?: string | null };
  repository_selection: "all" | "selected";
};

export function IntegrationsTab({ status, onSaved }: Props) {
  const { t } = useT();

  const appId = status?.values.GITHUB_APP_ID?.value ?? "";
  const appName = status?.values.GITHUB_APP_NAME?.value ?? "";
  const appSlug = status?.values.GITHUB_APP_SLUG?.value ?? "";
  const appConfigured = Boolean(
    status?.values.GITHUB_APP_ID?.set && status?.values.GITHUB_APP_PRIVATE_KEY?.set,
  );

  const [installations, setInstallations] = useState<Installation[] | null>(null);
  const [installationsError, setInstallationsError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!appConfigured) {
      setInstallations(null);
      setInstallationsError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await apiJson<{
          installations: Installation[];
          cleared?: "app-deleted";
          error?: string;
        }>("/api/admin/github-app/installations");
        if (cancelled) return;
        // Backend auto-wiped orphaned credentials, refresh the parent
        // status so the tab re-renders into the "Create App" state.
        if (r.cleared === "app-deleted") {
          onSaved();
          return;
        }
        setInstallations(r.installations);
      } catch (e) {
        if (!cancelled) setInstallationsError(e instanceof Error ? e.message : "Failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appConfigured, status, onSaved]);

  async function resetGithubApp() {
    if (!confirm(t("instanceSettings.ghAppResetConfirm"))) return;
    setResetting(true);
    try {
      await apiJson("/api/admin/github-app", { method: "DELETE" });
      onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setResetting(false);
    }
  }

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
    clientId.trim() !== prevClientId || (secretEditing && secretDraft.trim().length > 0);

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
      <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
        {t("instanceSettings.tabIntegrations")}
      </h2>

      {/* GitHub App, the one that commits */}
      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-neutral-900">
              {t("instanceSettings.ghAppTitle")}
            </h3>
            <p className="mt-0.5 text-[12px] leading-snug text-neutral-500">
              {t("instanceSettings.ghAppIntro")}
            </p>
          </div>
          {appConfigured ? (
            <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700">
              {t("instanceSettings.ghAppActive")}
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
              {t("instanceSettings.ghAppNotSet")}
            </span>
          )}
        </div>

        {appConfigured ? (
          <div className="space-y-3">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              {appName && (
                <>
                  <span className="text-neutral-500">{t("instanceSettings.ghAppName")}</span>
                  <span className="font-mono text-neutral-900">{appName}</span>
                </>
              )}
              <span className="text-neutral-500">{t("instanceSettings.ghAppId")}</span>
              <span className="font-mono text-neutral-900">{appId}</span>
              {appSlug && (
                <>
                  <span className="text-neutral-500">{t("instanceSettings.ghAppSlug")}</span>
                  <a
                    href={`https://github.com/apps/${appSlug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-brand hover:underline"
                  >
                    {appSlug}
                  </a>
                </>
              )}
              <span className="text-neutral-500">{t("instanceSettings.ghAppInstallations")}</span>
              <span className="text-neutral-900">
                {installations === null && !installationsError && "…"}
                {installationsError && <span className="text-red-600">{installationsError}</span>}
                {installations &&
                  (installations.length === 0
                    ? t("instanceSettings.ghAppNoInstalls")
                    : installations.map((i) => i.account.login).join(", "))}
              </span>
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              {appSlug && (
                <a
                  href={`https://github.com/apps/${appSlug}/installations/new`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
                >
                  {t("instanceSettings.ghAppInstallMore")} →
                </a>
              )}
              {appSlug && (
                <a
                  href={`https://github.com/apps/${appSlug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
                >
                  {t("instanceSettings.ghAppManage")} →
                </a>
              )}
              <button
                type="button"
                onClick={resetGithubApp}
                disabled={resetting}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1.5 text-[12px] font-medium text-red-600 shadow-sm hover:bg-red-50 disabled:opacity-50"
              >
                {resetting ? t("instanceSettings.saving") : t("instanceSettings.ghAppReset")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-4 text-[12px] leading-snug text-neutral-600">
              {t("instanceSettings.ghAppCreateHelp")}
            </p>
            <a
              href="/api/setup/github-app/start"
              className="flex h-10 w-full items-center justify-center gap-2.5 rounded-md bg-[#24292F] px-4 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-[#32383F]"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.575.105.785-.25.785-.555 0-.275-.01-1-.015-1.965-3.2.695-3.875-1.54-3.875-1.54-.525-1.33-1.28-1.685-1.28-1.685-1.045-.715.08-.7.08-.7 1.155.08 1.765 1.185 1.765 1.185 1.03 1.765 2.7 1.255 3.36.96.105-.745.4-1.255.73-1.545-2.555-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.185-3.095-.12-.29-.515-1.465.11-3.055 0 0 .965-.31 3.165 1.18a10.98 10.98 0 0 1 2.88-.385c.98.005 1.97.13 2.88.385 2.195-1.49 3.16-1.18 3.16-1.18.625 1.59.23 2.765.115 3.055.735.805 1.18 1.835 1.18 3.095 0 4.43-2.69 5.405-5.255 5.69.41.355.78 1.055.78 2.125 0 1.535-.015 2.77-.015 3.15 0 .31.205.665.79.555A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
              </svg>
              {t("instanceSettings.ghAppCreate")}
            </a>
            <p className="mt-2 text-[11px] leading-snug text-neutral-400">
              {t("instanceSettings.ghAppEnvHint")}
            </p>
          </>
        )}
      </div>

      {/* GitHub OAuth app, for user sign-in, lower priority */}
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
            <p className="mt-1 text-[11px] text-neutral-500">
              {t("instanceSettings.ghOauthCallbackHelp")}
            </p>
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
