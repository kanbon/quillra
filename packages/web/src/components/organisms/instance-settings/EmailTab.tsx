/**
 * Email delivery configuration, provider radio (none / Resend / SMTP)
 * plus either a Resend API key or a full SMTP form, depending on the
 * selected provider.
 *
 * Draft preservation: Resend and SMTP field state live in parallel React
 * state regardless of the currently-selected provider. Switching back
 * and forth does NOT wipe what you typed. The save-delta logic reads
 * from the currently-selected provider only, so you can't accidentally
 * save SMTP fields as Resend.
 *
 * Departure from Setup.tsx: picking "none" does NOT clear Resend/SMTP
 * credentials. The owner may be temporarily disabling delivery. Only
 * switching from one real provider to the other clears the opposite-
 * provider secrets.
 *
 * Test-email button sends to the signed-in owner only, never a body-
 * supplied address, so it can't be used as a spam relay.
 */

import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { SecretField, type SecretStatus } from "@/components/molecules/SecretField";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useEffect, useRef, useState } from "react";
import { type StatusResponse, getStatus } from "./types";

type Provider = "none" | "resend" | "smtp";

type Props = {
  status: StatusResponse | null;
  onSaved: () => void;
};

export function EmailTab({ status, onSaved }: Props) {
  const { t } = useT();

  const previous = {
    provider: (status?.values.EMAIL_PROVIDER?.value as Provider | undefined) ?? "none",
    emailFrom: status?.values.EMAIL_FROM?.value ?? "",
    smtpHost: status?.values.SMTP_HOST?.value ?? "",
    smtpPort: status?.values.SMTP_PORT?.value ?? "587",
    smtpUser: status?.values.SMTP_USER?.value ?? "",
    smtpSecure: (status?.values.SMTP_SECURE?.value as "true" | "false" | undefined) ?? "false",
  };

  const [provider, setProvider] = useState<Provider>(previous.provider);
  const [emailFrom, setEmailFrom] = useState(previous.emailFrom);

  // Resend
  const [resendEditing, setResendEditing] = useState(false);
  const [resendDraft, setResendDraft] = useState("");

  // SMTP
  const [smtpHost, setSmtpHost] = useState(previous.smtpHost);
  const [smtpPort, setSmtpPort] = useState(previous.smtpPort);
  const [smtpUser, setSmtpUser] = useState(previous.smtpUser);
  const [smtpSecure, setSmtpSecure] = useState<"true" | "false">(previous.smtpSecure);
  const [smtpPwdEditing, setSmtpPwdEditing] = useState(false);
  const [smtpPwdDraft, setSmtpPwdDraft] = useState("");

  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testFlash, setTestFlash] = useState<string | null>(null);
  const testCooldown = useRef<number>(0);

  const resendStatus = getStatus(status, "RESEND_API_KEY") as SecretStatus;
  const smtpPwdStatus = getStatus(status, "SMTP_PASSWORD") as SecretStatus;

  // Resync when the parent refetches (e.g. after save)
  const initialStatus = useRef(status);
  useEffect(() => {
    if (!status || initialStatus.current === status) return;
    initialStatus.current = status;
    setProvider((status.values.EMAIL_PROVIDER?.value as Provider | undefined) ?? "none");
    setEmailFrom(status.values.EMAIL_FROM?.value ?? "");
    setSmtpHost(status.values.SMTP_HOST?.value ?? "");
    setSmtpPort(status.values.SMTP_PORT?.value ?? "587");
    setSmtpUser(status.values.SMTP_USER?.value ?? "");
    setSmtpSecure((status.values.SMTP_SECURE?.value as "true" | "false" | undefined) ?? "false");
    setResendEditing(false);
    setResendDraft("");
    setSmtpPwdEditing(false);
    setSmtpPwdDraft("");
  }, [status]);

  // Detect dirty state so we can gate the test-email button.
  const isDirty =
    provider !== previous.provider ||
    emailFrom !== previous.emailFrom ||
    (provider === "resend" && resendEditing && resendDraft.length > 0) ||
    (provider === "smtp" &&
      (smtpHost !== previous.smtpHost ||
        smtpPort !== previous.smtpPort ||
        smtpUser !== previous.smtpUser ||
        smtpSecure !== previous.smtpSecure ||
        (smtpPwdEditing && smtpPwdDraft.length > 0)));

  function buildPayload(): Record<string, string | null> {
    const v: Record<string, string | null> = {};
    if (provider !== previous.provider) v.EMAIL_PROVIDER = provider;
    if (emailFrom.trim() !== previous.emailFrom) v.EMAIL_FROM = emailFrom.trim() || null;

    if (provider === "resend") {
      if (resendEditing && resendDraft.trim()) v.RESEND_API_KEY = resendDraft.trim();
      if (previous.provider === "smtp") {
        v.SMTP_HOST = null;
        v.SMTP_PORT = null;
        v.SMTP_USER = null;
        v.SMTP_PASSWORD = null;
        v.SMTP_SECURE = null;
      }
    } else if (provider === "smtp") {
      if (smtpHost !== previous.smtpHost) v.SMTP_HOST = smtpHost.trim() || null;
      if (smtpPort !== previous.smtpPort) v.SMTP_PORT = smtpPort.trim() || null;
      if (smtpUser !== previous.smtpUser) v.SMTP_USER = smtpUser.trim() || null;
      if (smtpSecure !== previous.smtpSecure) v.SMTP_SECURE = smtpSecure;
      if (smtpPwdEditing && smtpPwdDraft) v.SMTP_PASSWORD = smtpPwdDraft;
      if (previous.provider === "resend") {
        v.RESEND_API_KEY = null;
      }
    }
    // provider === "none", deliberately do NOT wipe credentials.
    return v;
  }

  async function save() {
    setSaving(true);
    setFlash(null);
    try {
      await apiJson("/api/setup/save", {
        method: "POST",
        body: JSON.stringify({ values: buildPayload() }),
      });
      setResendEditing(false);
      setResendDraft("");
      setSmtpPwdEditing(false);
      setSmtpPwdDraft("");
      setFlash(t("instanceSettings.savedFlash"));
      onSaved();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    const now = Date.now();
    if (now < testCooldown.current) return;
    testCooldown.current = now + 10_000;
    setTesting(true);
    setTestFlash(null);
    try {
      const res = await apiJson<{ ok: boolean; backend?: string; reason?: string }>(
        "/api/admin/test-email",
        { method: "POST", body: "{}" },
      );
      setTestFlash(
        res.ok
          ? t("instanceSettings.testEmailSent")
          : `${t("instanceSettings.testEmailFailed")}: ${res.reason ?? "unknown"}`,
      );
    } catch (e) {
      setTestFlash(
        `${t("instanceSettings.testEmailFailed")}: ${e instanceof Error ? e.message : "error"}`,
      );
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
        {t("instanceSettings.tabEmail")}
      </h2>

      <div className="space-y-2">
        <label className="text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
          {t("instanceSettings.emailProvider")}
        </label>
        <div className="grid gap-2">
          {(["none", "resend", "smtp"] as const).map((p) => (
            <label
              key={p}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
                provider === p
                  ? "border-neutral-900 bg-neutral-50"
                  : "border-neutral-200 bg-white hover:bg-neutral-50",
              )}
            >
              <input
                type="radio"
                checked={provider === p}
                onChange={() => setProvider(p)}
                className="mt-1 accent-neutral-900"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-neutral-900">
                  {p === "none"
                    ? t("instanceSettings.emailProviderNone")
                    : p === "resend"
                      ? t("instanceSettings.emailProviderResend")
                      : t("instanceSettings.emailProviderSmtp")}
                </p>
                <p className="mt-0.5 text-[12px] leading-snug text-neutral-500">
                  {p === "none"
                    ? t("instanceSettings.emailProviderNoneHelp")
                    : p === "resend"
                      ? t("instanceSettings.emailProviderResendHelp")
                      : t("instanceSettings.emailProviderSmtpHelp")}
                </p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {provider !== "none" && (
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
              {t("instanceSettings.emailFromLabel")}
            </label>
            <Input
              value={emailFrom}
              onChange={(e) => setEmailFrom(e.target.value)}
              placeholder="Your Name <you@example.com>"
            />
          </div>

          {provider === "resend" && (
            <SecretField
              label={t("instanceSettings.resendApiKey")}
              name="RESEND_API_KEY"
              status={resendStatus}
              draft={resendDraft}
              onDraftChange={setResendDraft}
              editing={resendEditing}
              onStartEdit={() => setResendEditing(true)}
              onCancelEdit={() => {
                setResendEditing(false);
                setResendDraft("");
              }}
              placeholder="re_…"
              docsHref="https://resend.com/api-keys"
              docsLabel={t("instanceSettings.getResendKey")}
            />
          )}

          {provider === "smtp" && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
                    {t("instanceSettings.smtpHost")}
                  </label>
                  <Input
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.example.com"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
                    {t("instanceSettings.smtpPort")}
                  </label>
                  <Input
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                    placeholder="587"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
                    {t("instanceSettings.smtpSecure")}
                  </label>
                  <select
                    className="block h-[42px] w-full rounded-md border border-neutral-300 bg-white px-3 text-sm"
                    value={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.target.value as "true" | "false")}
                  >
                    <option value="false">STARTTLS (587)</option>
                    <option value="true">SSL/TLS (465)</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
                    {t("instanceSettings.smtpUser")}
                  </label>
                  <Input
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                    placeholder="apikey or username"
                  />
                </div>
              </div>

              <SecretField
                label={t("instanceSettings.smtpPassword")}
                name="SMTP_PASSWORD"
                status={smtpPwdStatus}
                draft={smtpPwdDraft}
                onDraftChange={setSmtpPwdDraft}
                editing={smtpPwdEditing}
                onStartEdit={() => setSmtpPwdEditing(true)}
                onCancelEdit={() => {
                  setSmtpPwdEditing(false);
                  setSmtpPwdDraft("");
                }}
                placeholder="••••••••"
              />
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-neutral-100 pt-4">
        <div className="flex items-center gap-2">
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? t("instanceSettings.saving") : t("instanceSettings.saveChanges")}
          </Button>
          {provider !== "none" && (
            <Button
              type="button"
              variant="ghost"
              onClick={sendTest}
              disabled={testing || isDirty}
              title={isDirty ? t("instanceSettings.saveBeforeTest") : undefined}
            >
              {testing
                ? t("instanceSettings.sendingTestEmail")
                : t("instanceSettings.sendTestEmail")}
            </Button>
          )}
        </div>
        <div className="text-right">
          {flash && <p className="text-sm text-neutral-500">{flash}</p>}
          {testFlash && <p className="text-xs text-neutral-500">{testFlash}</p>}
        </div>
      </div>
    </div>
  );
}
