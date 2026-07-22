import { Input } from "@/components/atoms/Input";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

/**
 * Email step: picks a transport (none / Resend / SMTP) plus its
 * associated credentials and From address. All fields are controlled
 * from the parent so SetupPage can POST them to /api/setup/save in a
 * single shot.
 */

export type EmailProvider = "none" | "resend" | "smtp";

export type SmtpFields = {
  host: string;
  port: string;
  user: string;
  password: string;
  secure: string;
};

export function EmailStep({
  provider,
  onProviderChange,
  from,
  onFromChange,
  resendKey,
  resendKeyConfigured,
  smtpPasswordConfigured,
  onResendKeyChange,
  smtp,
  onSmtpChange,
  onBack,
  onNext,
  saving,
  error,
}: {
  provider: EmailProvider;
  onProviderChange: (p: EmailProvider) => void;
  from: string;
  onFromChange: (v: string) => void;
  resendKey: string;
  resendKeyConfigured: boolean;
  smtpPasswordConfigured: boolean;
  onResendKeyChange: (v: string) => void;
  smtp: SmtpFields;
  onSmtpChange: (s: SmtpFields) => void;
  onBack: () => void;
  onNext: () => void;
  saving: boolean;
  error: string | null;
}) {
  const { t } = useT();

  return (
    <form
      className="p-5 sm:p-8"
      onSubmit={(event) => {
        event.preventDefault();
        onNext();
      }}
    >
      <h2
        id="setup-step-heading-email"
        tabIndex={-1}
        className="text-[20px] font-semibold tracking-tight text-neutral-900 outline-none"
      >
        {t("setup.email.title")}
      </h2>
      <p className="mt-2 text-sm text-neutral-500">{t("setup.email.intro")}</p>
      <fieldset className="mt-5 grid gap-2">
        <legend className="sr-only">{t("instanceSettings.emailProvider")}</legend>
        {(["none", "resend", "smtp"] as const).map((p) => (
          <label
            key={p}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
              provider === p
                ? "border-brand bg-brand/5"
                : "border-neutral-200 bg-white hover:bg-neutral-50",
            )}
          >
            <input
              type="radio"
              name="setup-email-provider"
              checked={provider === p}
              onChange={() => onProviderChange(p)}
              disabled={saving}
              className="mt-1 accent-brand"
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
      </fieldset>

      {provider !== "none" && (
        <div className="mt-5 space-y-3">
          <div>
            <label
              htmlFor="setup-email-from"
              className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
            >
              {t("instanceSettings.emailFromLabel")}
            </label>
            <Input
              id="setup-email-from"
              required
              value={from}
              onChange={(e) => onFromChange(e.target.value)}
              placeholder={t("setup.email.fromPlaceholder")}
              disabled={saving}
            />
          </div>
          {provider === "resend" && (
            <div>
              <label
                htmlFor="setup-resend-key"
                className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
              >
                {t("instanceSettings.resendApiKey")}
              </label>
              <Input
                id="setup-resend-key"
                type="password"
                required={!resendKeyConfigured}
                value={resendKey}
                onChange={(e) => onResendKeyChange(e.target.value)}
                placeholder={resendKeyConfigured ? t("setup.email.configuredPlaceholder") : "re_…"}
                disabled={saving}
              />
              {resendKeyConfigured && !resendKey && (
                <p className="mt-1.5 text-xs text-graphite">{t("setup.email.keyConfigured")}</p>
              )}
            </div>
          )}
          {provider === "smtp" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label
                  htmlFor="setup-smtp-host"
                  className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
                >
                  {t("instanceSettings.smtpHost")}
                </label>
                <Input
                  id="setup-smtp-host"
                  required
                  value={smtp.host}
                  onChange={(e) => onSmtpChange({ ...smtp, host: e.target.value })}
                  placeholder="smtp.example.com"
                  disabled={saving}
                />
              </div>
              <div>
                <label
                  htmlFor="setup-smtp-port"
                  className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
                >
                  {t("instanceSettings.smtpPort")}
                </label>
                <Input
                  id="setup-smtp-port"
                  type="number"
                  min="1"
                  max="65535"
                  required
                  value={smtp.port}
                  onChange={(e) => onSmtpChange({ ...smtp, port: e.target.value })}
                  placeholder="587"
                  disabled={saving}
                />
              </div>
              <div>
                <label
                  htmlFor="setup-smtp-secure"
                  className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
                >
                  {t("instanceSettings.smtpSecure")}
                </label>
                <select
                  id="setup-smtp-secure"
                  className="block h-[42px] w-full rounded-md border border-neutral-300 bg-white px-3 text-sm"
                  value={smtp.secure}
                  onChange={(e) => onSmtpChange({ ...smtp, secure: e.target.value })}
                  disabled={saving}
                >
                  <option value="false">STARTTLS (587)</option>
                  <option value="true">SSL/TLS (465)</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="setup-smtp-user"
                  className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
                >
                  {t("instanceSettings.smtpUser")}
                </label>
                <Input
                  id="setup-smtp-user"
                  value={smtp.user}
                  onChange={(e) => onSmtpChange({ ...smtp, user: e.target.value })}
                  placeholder={t("setup.email.userPlaceholder")}
                  disabled={saving}
                />
              </div>
              <div>
                <label
                  htmlFor="setup-smtp-password"
                  className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
                >
                  {t("instanceSettings.smtpPassword")}
                </label>
                <Input
                  id="setup-smtp-password"
                  type="password"
                  value={smtp.password}
                  onChange={(e) => onSmtpChange({ ...smtp, password: e.target.value })}
                  placeholder={
                    smtpPasswordConfigured ? t("setup.email.configuredPlaceholder") : "••••••••"
                  }
                  disabled={saving}
                />
                {smtpPasswordConfigured && !smtp.password && (
                  <p className="mt-1.5 text-xs text-graphite">
                    {t("setup.email.passwordConfigured")}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={saving}
          className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900 disabled:cursor-wait disabled:opacity-50"
        >
          {t("common.back")}
        </button>
        <button
          type="submit"
          disabled={saving}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm",
            saving ? "cursor-not-allowed opacity-50" : "hover:bg-brand/90",
          )}
        >
          {saving ? t("common.saving") : t("common.continue")}
        </button>
      </div>
    </form>
  );
}
