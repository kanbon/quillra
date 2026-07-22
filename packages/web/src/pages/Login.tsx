import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { Input } from "@/components/atoms/Input";
import { LogoMark } from "@/components/atoms/LogoMark";
import { useTeamLoginCode } from "@/hooks/useTeamLoginCode";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

/** Passwordless owner and team-member sign-in. */
export function LoginPage() {
  const { t } = useT();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [accessToken, setAccessToken] = useState("");
  const login = useTeamLoginCode({
    initialEmail: searchParams.get("email") ?? "",
    onVerified: () => {
      window.location.href = "/dashboard";
    },
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiJson<{ user: unknown }>("/api/session");
        if (!cancelled && response.user) nav("/dashboard", { replace: true });
      } catch {
        /* not logged in */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nav]);

  function reset() {
    setAccessToken("");
    login.resetToEmail();
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-8">
      <div className="w-full max-w-sm rounded-2xl border border-rule bg-paper p-6 shadow-sm sm:p-8">
        <div className="mb-6 flex items-center gap-2">
          <LogoMark size={32} />
          <Heading as="h1" className="font-brand text-2xl font-bold">
            {t("login.appName")}
          </Heading>
        </div>
        <p className="mb-6 text-sm leading-relaxed text-neutral-600">
          {login.stage === "recovery" ? t("login.serverAccessHelp") : t("login.intro")}
        </p>

        {login.stage === "email" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void login.requestCode();
            }}
          >
            <label
              htmlFor="login-email"
              className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600"
            >
              {t("login.emailLabel")}
            </label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={login.email}
              onChange={(event) => login.setEmail(event.target.value)}
              placeholder="you@example.com"
              disabled={login.working}
              className="mb-3"
            />
            <Button
              className="w-full"
              type="submit"
              disabled={login.working || !login.email.trim()}
            >
              {login.working ? t("login.sendingCode") : t("login.sendCode")}
            </Button>
          </form>
        )}

        {login.stage === "recovery" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void login.requestCode(accessToken).then((nextStage) => {
                if (nextStage === "code") setAccessToken("");
              });
            }}
          >
            <label
              htmlFor="login-server-access"
              className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600"
            >
              {t("login.serverAccessLabel")}
            </label>
            <Input
              id="login-server-access"
              type="password"
              autoComplete="off"
              autoFocus
              required
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              placeholder={t("login.serverAccessPlaceholder")}
              disabled={login.working}
              className="mb-2"
            />
            <p className="mb-3 text-xs leading-relaxed text-neutral-500">
              {t("login.serverAccessHint")}
            </p>
            <Button
              variant="brand"
              className="w-full"
              type="submit"
              disabled={login.working || !accessToken.trim()}
            >
              {login.working ? t("login.checkingAccess") : t("login.showCode")}
            </Button>
          </form>
        )}

        {login.stage === "code" && (
          <>
            <label
              htmlFor="login-code"
              className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600"
            >
              {t("login.codeLabel")}
            </label>
            <p className="mb-3 text-[12px] leading-snug text-neutral-500">
              {t("login.codeHelp", { email: login.email })}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void login.verifyCode();
              }}
            >
              <Input
                id="login-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                pattern="[0-9]{6}"
                value={login.code}
                onChange={(event) =>
                  login.setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="123456"
                maxLength={6}
                disabled={login.working}
                className="mb-3 text-center font-mono text-lg tracking-[0.3em]"
              />
              <Button
                className="w-full"
                type="submit"
                disabled={login.working || login.code.length !== 6}
              >
                {login.working ? t("login.verifying") : t("login.verifyCode")}
              </Button>
            </form>
            <output className="mt-3 block text-sm text-neutral-500" aria-live="polite">
              {login.devCode ? `${t("login.devCodePrefix")} ${login.devCode}` : t("login.codeSent")}
            </output>
            <div className="mt-4 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                disabled={login.working}
                className="text-xs font-medium text-graphite hover:text-ink disabled:cursor-wait disabled:opacity-50"
                onClick={reset}
              >
                ← {t("login.useDifferentEmail")}
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
          </>
        )}

        {login.error && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {login.error}
          </p>
        )}

        {login.stage === "recovery" && (
          <button
            type="button"
            disabled={login.working}
            onClick={reset}
            className="mt-4 text-xs font-medium text-graphite hover:text-ink disabled:opacity-50"
          >
            ← {t("login.useDifferentEmail")}
          </button>
        )}
      </div>
    </div>
  );
}
