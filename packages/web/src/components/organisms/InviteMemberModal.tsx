/**
 * Project invite modal. Replaces the inline invite form that used to
 * live on the Project Settings page. Two steps:
 *
 *   1. Pick a role — card-style picker with a clear description of
 *      what each role can do.
 *   2. Enter email + name — send, get feedback inline.
 *
 * On success shows a "Sent!" state with a copy-link fallback if the
 * mailer isn't configured.
 */
import { useEffect, useState, useMemo } from "react";
import { Modal } from "@/components/atoms/Modal";
import { Input } from "@/components/atoms/Input";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Role = "client" | "editor" | "admin";

type Props = {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onInvited?: () => void;
};

const ROLE_COLORS: Record<Role, string> = {
  client: "#A855F7",
  editor: "#3B82F6",
  admin: "#EF4444",
};
const ROLE_ORDER: Role[] = ["client", "editor", "admin"];

type Step = "role" | "details" | "sent";

export function InviteMemberModal({ open, onClose, projectId, onInvited }: Props) {
  const { t } = useT();
  const [step, setStep] = useState<Step>("role");
  const [role, setRole] = useState<Role>("client");

  // Roles pulled from i18n so both titles and long descriptions are
  // localised and future languages don't need code changes.
  const ROLES = useMemo(
    () =>
      ROLE_ORDER.map((value) => {
        const key = value === "editor" ? "Editor" : value === "admin" ? "Admin" : "Client";
        return {
          value,
          title: t(`invite.role${key}Title`),
          shortDesc: t(`invite.role${key}Desc`),
          longDesc: t(`invite.role${key}Long`),
          color: ROLE_COLORS[value],
        };
      }),
    [t],
  );
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    inviteLink: string;
    emailSent: boolean;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep("role");
    setRole("client");
    setEmail("");
    setName("");
    setSubmitting(false);
    setError(null);
    setResult(null);
  }, [open]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiJson<{ inviteLink: string; emailSent: boolean }>(
        `/api/team/projects/${projectId}/invites`,
        {
          method: "POST",
          body: JSON.stringify({ email: email.trim().toLowerCase(), role, name: name.trim() || undefined }),
        },
      );
      setResult({ inviteLink: res.inviteLink, emailSent: res.emailSent });
      setStep("sent");
      onInvited?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={() => !submitting && onClose()} className="max-w-xl">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
            {step === "sent" ? t("invite.sent") : t("invite.title")}
          </h2>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            {step === "role" && t("invite.stepRoleSubtitle")}
            {step === "details" && t("invite.stepDetailsSubtitle")}
            {step === "sent" && t("invite.stepSentSubtitle")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => !submitting && onClose()}
          className="-mr-2 -mt-1 flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          aria-label={t("invite.close")}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {step === "role" && (
        <div className="space-y-2">
          {ROLES.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => setRole(r.value)}
              className={cn(
                "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                role === r.value
                  ? "border-neutral-900 bg-neutral-50"
                  : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50/60",
              )}
            >
              <div
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white"
                style={{ backgroundColor: r.color }}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  {r.value === "client" && (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  )}
                  {r.value === "editor" && (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  )}
                  {r.value === "admin" && (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  )}
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[14px] font-semibold text-neutral-900">{r.title}</p>
                  {role === r.value && (
                    <svg className="h-4 w-4 text-neutral-900" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <p className="text-[12px] text-neutral-500">{r.shortDesc}</p>
                {role === r.value && (
                  <p className="mt-2 text-[12px] leading-relaxed text-neutral-600">{r.longDesc}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {step === "details" && (
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
              {t("invite.emailLabel")}
            </label>
            <Input
              type="email"
              placeholder={t("projectSettings.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
              {t("invite.nameLabel")}
            </label>
            <Input
              placeholder={t("invite.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="rounded-lg bg-neutral-50 px-3 py-2 text-[12px] text-neutral-600"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{
              __html: t("invite.addAs", {
                role: `<strong>${ROLES.find((r) => r.value === role)?.title ?? ""}</strong>`,
              }),
            }}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {step === "sent" && result && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-2xl border border-green-200 bg-green-50/50 p-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-green-100 text-green-700">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-green-900">
                {result.emailSent ? t("invite.emailDelivered") : t("invite.inviteCreated")}
              </p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-green-800/80">
                {result.emailSent
                  ? t("invite.deliveredDescription", {
                      email,
                      linkType:
                        role === "client" ? t("invite.brandedSignInLink") : t("invite.githubSignInLink"),
                    })
                  : t("invite.copyFallback")}
              </p>
            </div>
          </div>
          {!result.emailSent && (
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-[11px] text-neutral-700">
                {result.inviteLink}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(result.inviteLink)}
                className="rounded-md bg-neutral-900 px-3 py-2 text-[11px] font-medium text-white hover:bg-neutral-700"
              >
                {t("invite.copy")}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            if (step === "details") setStep("role");
            else if (!submitting) onClose();
          }}
          disabled={submitting}
          className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50"
        >
          {step === "details" ? t("invite.back") : step === "sent" ? t("invite.close") : t("invite.cancel")}
        </button>

        {step === "role" && (
          <button
            type="button"
            onClick={() => setStep("details")}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-neutral-900 px-5 text-[13px] font-semibold text-white shadow-sm hover:bg-neutral-800"
          >
            {t("invite.continueBtn")}
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        {step === "details" && (
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !email.trim()}
            className={cn(
              "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm",
              submitting || !email.trim() ? "cursor-not-allowed opacity-50" : "hover:bg-brand/90",
            )}
          >
            {submitting ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                {t("invite.sending")}
              </>
            ) : (
              t("invite.sendInvite")
            )}
          </button>
        )}

        {step === "sent" && (
          <button
            type="button"
            onClick={() => {
              setStep("role");
              setEmail("");
              setName("");
              setResult(null);
            }}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-4 text-[13px] font-semibold text-neutral-700 hover:bg-neutral-50"
          >
            {t("invite.inviteAnother")}
          </button>
        )}
      </div>
    </Modal>
  );
}
