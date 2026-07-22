import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { useTeamLoginCode } from "@/hooks/useTeamLoginCode";
import { useT } from "@/i18n/i18n";
import { type FormEvent, useState } from "react";

/** Terminal setup step: verify the first operator and create the owner session. */
export function SigninStep({
  initialEmail,
  deliveryDisabled,
  onBack,
}: {
  initialEmail: string;
  deliveryDisabled: boolean;
  onBack: () => void;
}) {
  const { t } = useT();
  const login = useTeamLoginCode({
    initialEmail,
    onVerified: () => {
      window.location.href = "/dashboard";
    },
  });
  const [accessToken, setAccessToken] = useState("");

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void login.requestCode();
  }

  function submitAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void login.requestCode(accessToken).then((nextStage) => {
      if (nextStage === "code") setAccessToken("");
    });
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void login.verifyCode();
  }

  const intro =
    login.stage === "email"
      ? t("setup.signin.introEmail")
      : login.stage === "recovery"
        ? t("setup.signin.introRecovery")
        : t("setup.signin.introCode", { email: login.email });

  return (
    <div className="p-5 sm:p-8">
      <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand/10 text-brand">
        <svg
          className="h-8 w-8"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path strokeLinecap="round" strokeLinejoin="round" d="m3 7 9 6 9-6" />
        </svg>
      </div>
      <h2
        id="setup-step-heading-signin"
        tabIndex={-1}
        className="text-center text-[22px] font-semibold tracking-tight text-neutral-900 outline-none"
      >
        {t("setup.signin.title")}
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-neutral-500">
        {intro}
      </p>

      {login.stage === "email" && (
        <form className="mx-auto mt-7 max-w-sm" onSubmit={submitEmail}>
          {deliveryDisabled && (
            <p className="mb-4 rounded-xl border border-rule bg-canvas px-3 py-2 text-xs leading-relaxed text-graphite">
              {t("setup.signin.deliveryDisabled")}
            </p>
          )}
          <label
            htmlFor="setup-owner-email"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            {t("setup.signin.ownerEmail")}
          </label>
          <Input
            id="setup-owner-email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={login.email}
            onChange={(event) => login.setEmail(event.target.value)}
            placeholder={t("setup.signin.emailPlaceholder")}
            disabled={login.working}
          />
          <Button
            type="submit"
            disabled={login.working || !login.email.trim()}
            className="mt-4 h-11 w-full rounded-xl font-semibold"
          >
            {login.working ? t("setup.signin.sendingCode") : t("setup.signin.sendCode")}
          </Button>
        </form>
      )}

      {login.stage === "recovery" && (
        <form className="mx-auto mt-7 max-w-sm" onSubmit={submitAccess}>
          <label
            htmlFor="setup-owner-access-token"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            {t("login.serverAccessLabel")}
          </label>
          <Input
            id="setup-owner-access-token"
            type="password"
            autoComplete="off"
            autoFocus
            required
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            placeholder={t("login.serverAccessPlaceholder")}
            disabled={login.working}
          />
          <p className="mt-2 text-xs leading-relaxed text-graphite">
            {t("setup.signin.recoveryHintBefore")}{" "}
            <code className="rounded bg-canvas px-1 py-0.5">QUILLRA_SETUP_TOKEN</code>{" "}
            {t("setup.signin.recoveryHintBetween")}
          </p>
          <Button
            type="submit"
            variant="brand"
            disabled={login.working || !accessToken.trim()}
            className="mt-4 h-11 w-full rounded-xl font-semibold"
          >
            {login.working ? t("login.checkingAccess") : t("login.showCode")}
          </Button>
        </form>
      )}

      {login.stage === "code" && (
        <form className="mx-auto mt-7 max-w-sm" onSubmit={submitCode}>
          <label
            htmlFor="setup-owner-code"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            {t("setup.signin.codeLabel")}
          </label>
          <Input
            id="setup-owner-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            pattern="[0-9]{6}"
            value={login.code}
            onChange={(event) => login.setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            maxLength={6}
            disabled={login.working}
            className="text-center font-mono text-lg tracking-[0.3em]"
          />
          {login.devCode && (
            <output
              className="mt-3 block rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
              aria-live="polite"
            >
              {t("setup.signin.codePrefix")}{" "}
              <code className="font-mono font-semibold">{login.devCode}</code>
            </output>
          )}
          <Button
            type="submit"
            variant="brand"
            disabled={login.working || login.code.length !== 6}
            className="mt-4 h-11 w-full rounded-xl font-semibold"
          >
            {login.working ? t("setup.signin.creatingOwner") : t("setup.signin.createOwner")}
          </Button>
          <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
            <button
              type="button"
              disabled={login.working}
              onClick={login.resetToEmail}
              className="text-xs font-medium text-graphite hover:text-ink disabled:opacity-50"
            >
              {t("login.useDifferentEmail")}
            </button>
            <button
              type="button"
              disabled={login.working || login.resendSeconds > 0}
              onClick={() => void login.requestCode()}
              className="text-xs font-medium text-brand hover:text-[#a50e19] disabled:text-graphite disabled:opacity-60"
            >
              {login.resendSeconds > 0
                ? t("login.resendIn", { seconds: login.resendSeconds })
                : t("login.resendCode")}
            </button>
          </div>
        </form>
      )}

      {login.error && (
        <p className="mx-auto mt-4 max-w-sm text-sm text-red-600" role="alert">
          {login.error}
        </p>
      )}

      <button
        type="button"
        disabled={login.working}
        onClick={onBack}
        className="mx-auto mt-5 block text-xs font-medium text-graphite hover:text-ink disabled:opacity-50"
      >
        {t("common.back")}
      </button>
    </div>
  );
}
