import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { SecretField, type SecretStatus } from "@/components/molecules/SecretField";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { useState } from "react";
import { type StatusResponse, getStatus } from "./types";

type Props = {
  status: StatusResponse | null;
  onSaved: () => void;
};

export function E2bIntegrationCard({ status, onSaved }: Props) {
  const { t } = useT();
  const keyStatus = getStatus(status, "E2B_API_KEY") as SecretStatus;
  const enabled = status?.values.E2B_ENABLED?.value === "true" && keyStatus.set;
  const configuredTemplate = status?.values.E2B_TEMPLATE_ID?.value ?? "";
  const verifiedAt = status?.values.E2B_VERIFIED_AT?.value;
  const verifiedDate =
    verifiedAt && !Number.isNaN(Date.parse(verifiedAt))
      ? new Date(verifiedAt).toLocaleString()
      : null;

  const [keyEditing, setKeyEditing] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [templateDraft, setTemplateDraft] = useState<string | null>(null);
  const templateId = templateDraft ?? configuredTemplate;
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  async function verifyAndSave() {
    if (working) return;
    const apiKey = keyDraft.trim();
    if (!keyStatus.set && !apiKey) {
      setFeedback({ kind: "error", message: t("instanceSettings.e2bKeyRequired") });
      return;
    }
    setWorking(true);
    setFeedback(null);
    try {
      await apiJson("/api/admin/e2b", {
        method: "PUT",
        body: JSON.stringify({
          ...(apiKey ? { apiKey } : {}),
          templateId: templateId.trim() || null,
        }),
      });
      setKeyDraft("");
      setKeyEditing(false);
      setTemplateDraft(templateId.trim());
      setFeedback({ kind: "success", message: t("instanceSettings.e2bVerified") });
      onSaved();
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : t("instanceSettings.e2bVerificationFailed"),
      });
    } finally {
      setWorking(false);
    }
  }

  async function reset() {
    if (!confirm(t("instanceSettings.e2bResetConfirm"))) return;
    setWorking(true);
    setFeedback(null);
    try {
      await apiJson("/api/admin/e2b", { method: "DELETE" });
      setKeyDraft("");
      setKeyEditing(false);
      setTemplateDraft("");
      setFeedback({ kind: "success", message: t("instanceSettings.e2bResetDone") });
      onSaved();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : t("instanceSettings.e2bResetFailed"),
      });
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="rounded-xl border border-sky-200 bg-sky-50/30 p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-700">
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3 4.5 6v5.4c0 4.6 3.1 8 7.5 9.6 4.4-1.6 7.5-5 7.5-9.6V6L12 3Z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" d="m9.5 12 1.7 1.7 3.5-4" />
            </svg>
          </span>
          <div>
            <h3 className="text-sm font-semibold text-neutral-900">
              {t("instanceSettings.e2bTitle")}
            </h3>
            <p className="mt-0.5 max-w-xl text-[12px] leading-snug text-neutral-500">
              {t("instanceSettings.e2bIntro")}
            </p>
          </div>
        </div>
        <span
          className={
            enabled
              ? "shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700"
              : "shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500"
          }
        >
          {enabled ? t("instanceSettings.e2bActive") : t("instanceSettings.e2bDisabled")}
        </span>
      </div>

      <div className="space-y-4 rounded-lg border border-sky-100 bg-white p-4">
        <SecretField
          label={t("instanceSettings.e2bApiKey")}
          name="E2B_API_KEY"
          status={keyStatus}
          draft={keyDraft}
          onDraftChange={setKeyDraft}
          editing={keyEditing}
          onStartEdit={() => setKeyEditing(true)}
          onCancelEdit={() => {
            setKeyEditing(false);
            setKeyDraft("");
          }}
          placeholder={keyStatus.set ? "••••••••" : "e2b_…"}
          helpText={t("instanceSettings.e2bApiKeyHelp")}
          docsHref="https://e2b.dev/dashboard"
          docsLabel={t("instanceSettings.e2bOpenDashboard")}
        />

        <div>
          <label
            htmlFor="e2b-template-id"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600"
          >
            {t("instanceSettings.e2bTemplate")}
          </label>
          <Input
            id="e2b-template-id"
            value={templateId}
            onChange={(event) => setTemplateDraft(event.target.value)}
            placeholder="base"
            autoComplete="off"
            disabled={working}
          />
          <p className="mt-1 text-[11px] text-neutral-500">
            {t("instanceSettings.e2bTemplateHelp")}
          </p>
        </div>
      </div>

      {enabled && (
        <p className="mt-3 text-[11px] text-neutral-500">
          {verifiedDate
            ? t("instanceSettings.e2bVerifiedAt", {
                date: verifiedDate,
              })
            : t("instanceSettings.e2bEnabledUnverified")}
        </p>
      )}
      {!enabled && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
          {t("instanceSettings.e2bDisabledWarning")}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" onClick={verifyAndSave} disabled={working}>
          {working ? t("instanceSettings.e2bVerifying") : t("instanceSettings.e2bVerifyAndSave")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={reset}
          disabled={working || (!keyStatus.set && !enabled)}
          className="border-red-200 text-red-700 hover:bg-red-50"
        >
          {t("instanceSettings.e2bReset")}
        </Button>
        {feedback && (
          <p
            className={
              feedback.kind === "error" ? "text-sm text-red-600" : "text-sm text-emerald-700"
            }
            role={feedback.kind === "error" ? "alert" : "status"}
          >
            {feedback.message}
          </p>
        )}
      </div>
    </section>
  );
}
