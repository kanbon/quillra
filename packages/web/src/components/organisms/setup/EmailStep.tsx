import { Input } from "@/components/atoms/Input";
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
  onResendKeyChange: (v: string) => void;
  smtp: SmtpFields;
  onSmtpChange: (s: SmtpFields) => void;
  onBack: () => void;
  onNext: () => void;
  saving: boolean;
  error: string | null;
}) {
  return (
    <div className="p-8">
      <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900">Email delivery</h2>
      <p className="mt-2 text-sm text-neutral-500">
        Real emails for invites and client logins. You can change this later in settings.
      </p>
      <div className="mt-5 grid gap-2">
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
              checked={provider === p}
              onChange={() => onProviderChange(p)}
              className="mt-1 accent-brand"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-neutral-900">
                {p === "none" ? "Disabled" : p === "resend" ? "Resend" : "SMTP"}
              </p>
              <p className="mt-0.5 text-[12px] leading-snug text-neutral-500">
                {p === "none"
                  ? "Skip for now. Invites become shareable links you copy and send yourself."
                  : p === "resend"
                    ? "Cloud email via Resend. Paste an API key from resend.com."
                    : "Universal SMTP. Works with Gmail, Postfix, SendGrid SMTP, AWS SES, Postmark, etc."}
              </p>
            </div>
          </label>
        ))}
      </div>

      {provider !== "none" && (
        <div className="mt-5 space-y-3">
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
              From address
            </label>
            <Input
              value={from}
              onChange={(e) => onFromChange(e.target.value)}
              placeholder="Your Name <you@example.com>"
            />
          </div>
          {provider === "resend" && (
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                Resend API key
              </label>
              <Input
                type="password"
                value={resendKey}
                onChange={(e) => onResendKeyChange(e.target.value)}
                placeholder="re_…"
              />
            </div>
          )}
          {provider === "smtp" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  Host
                </label>
                <Input
                  value={smtp.host}
                  onChange={(e) => onSmtpChange({ ...smtp, host: e.target.value })}
                  placeholder="smtp.example.com"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  Port
                </label>
                <Input
                  value={smtp.port}
                  onChange={(e) => onSmtpChange({ ...smtp, port: e.target.value })}
                  placeholder="587"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  Secure (TLS)
                </label>
                <select
                  className="block h-[42px] w-full rounded-md border border-neutral-300 bg-white px-3 text-sm"
                  value={smtp.secure}
                  onChange={(e) => onSmtpChange({ ...smtp, secure: e.target.value })}
                >
                  <option value="false">STARTTLS (587)</option>
                  <option value="true">SSL/TLS (465)</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  User
                </label>
                <Input
                  value={smtp.user}
                  onChange={(e) => onSmtpChange({ ...smtp, user: e.target.value })}
                  placeholder="apikey or username"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  Password
                </label>
                <Input
                  type="password"
                  value={smtp.password}
                  onChange={(e) => onSmtpChange({ ...smtp, password: e.target.value })}
                  placeholder="••••••••"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={saving}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm",
            saving ? "cursor-not-allowed opacity-50" : "hover:bg-brand/90",
          )}
        >
          {saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </div>
  );
}
