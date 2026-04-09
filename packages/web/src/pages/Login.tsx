/**
 * Dual-path sign-in page.
 *
 * Historical: the only way to sign into Quillra was "Continue with GitHub"
 * (Better Auth OAuth). That worked for the instance owner but forced every
 * invited team member to own and link a GitHub account even if all they
 * needed to do was fix a typo on a client site.
 *
 * Now: the page offers two paths side-by-side —
 *
 *   1. Continue with GitHub — for the owner (who needs to push commits)
 *      and for anyone who voluntarily wants their changes attributed to
 *      their GitHub identity.
 *
 *   2. Sign in with email — passwordless 6-digit code, similar to the
 *      client-login flow. Works for anyone with a pending instanceInvites
 *      row or an existing team account. GitHub is NEVER required.
 *
 * After sign-in both paths land on /dashboard.
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { Input } from "@/components/atoms/Input";
import { LogoMark } from "@/components/atoms/LogoMark";
import { authClient } from "@/lib/auth-client";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Stage = "email" | "code";

export function LoginPage() {
  const { t } = useT();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const { data, isPending } = authClient.useSession();

  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState(() => searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Redirect on existing session. We check both Better Auth (github) and
  // the custom /api/session endpoint (which covers team sessions too).
  useEffect(() => {
    if (data?.user) {
      nav("/dashboard", { replace: true });
      return;
    }
    if (isPending) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiJson<{ user: unknown }>("/api/session");
        if (!cancelled && r.user) nav("/dashboard", { replace: true });
      } catch { /* not logged in */ }
    })();
    return () => {
      cancelled = true;
    };
  }, [data?.user, isPending, nav]);

  async function requestCode() {
    if (!email.trim()) return;
    setWorking(true);
    setError(null);
    setInfo(null);
    try {
      const r = await apiJson<{ ok: boolean; devCode?: string }>(
        "/api/team-login/request-code",
        { method: "POST", body: JSON.stringify({ email: email.trim() }) },
      );
      setStage("code");
      if (r.devCode) {
        setInfo(`${t("login.devCodePrefix")} ${r.devCode}`);
      } else {
        setInfo(t("login.codeSent"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setWorking(false);
    }
  }

  async function verifyCode() {
    if (!code.trim()) return;
    setWorking(true);
    setError(null);
    try {
      await apiJson("/api/team-login/verify-code", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      // Team session cookie is now set — navigate and let the dashboard
      // load via /api/session.
      window.location.href = "/dashboard";
    } catch (e) {
      setError(e instanceof Error ? e.message : t("login.invalidCode"));
      setWorking(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200/80 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <LogoMark size={32} />
          <Heading as="h1" className="font-brand text-2xl font-bold">
            {t("login.appName")}
          </Heading>
        </div>
        <p className="mb-6 text-sm leading-relaxed text-neutral-600">{t("login.intro")}</p>

        {stage === "email" ? (
          <>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
              {t("login.emailLabel")}
            </label>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void requestCode();
              }}
            >
              <Input
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={working}
                className="mb-3"
              />
              <Button
                className="w-full"
                type="submit"
                disabled={working || !email.trim()}
              >
                {working ? t("login.sendingCode") : t("login.sendCode")}
              </Button>
            </form>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-neutral-200" />
              <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                {t("login.or")}
              </span>
              <div className="h-px flex-1 bg-neutral-200" />
            </div>

            {/*
              GitHub brand-compliant sign-in button. Follows GitHub's
              published guidance for "Sign in with GitHub":
                - Solid #24292F background, white text
                - Official octocat mark (16px, white fill)
                - Label reads "Sign in with GitHub" (EN) / "Mit GitHub anmelden" (DE)
                - Button height 44px for comfortable tap targets
              Do not restyle or localize the mark itself.
            */}
            <button
              type="button"
              disabled={isPending || working}
              onClick={() =>
                authClient.signIn.social({
                  provider: "github",
                  callbackURL: `${window.location.origin}/dashboard`,
                })
              }
              className={cn(
                "flex h-11 w-full items-center justify-center gap-2.5 rounded-md bg-[#24292F] px-4 text-[14px] font-semibold text-white shadow-sm transition-colors",
                (isPending || working)
                  ? "cursor-not-allowed opacity-60"
                  : "hover:bg-[#32383F]",
              )}
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="currentColor"
              >
                {/* Official GitHub mark (Octocat) */}
                <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.575.105.785-.25.785-.555 0-.275-.01-1-.015-1.965-3.2.695-3.875-1.54-3.875-1.54-.525-1.33-1.28-1.685-1.28-1.685-1.045-.715.08-.7.08-.7 1.155.08 1.765 1.185 1.765 1.185 1.03 1.765 2.7 1.255 3.36.96.105-.745.4-1.255.73-1.545-2.555-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.185-3.095-.12-.29-.515-1.465.11-3.055 0 0 .965-.31 3.165 1.18a10.98 10.98 0 0 1 2.88-.385c.98.005 1.97.13 2.88.385 2.195-1.49 3.16-1.18 3.16-1.18.625 1.59.23 2.765.115 3.055.735.805 1.18 1.835 1.18 3.095 0 4.43-2.69 5.405-5.255 5.69.41.355.78 1.055.78 2.125 0 1.535-.015 2.77-.015 3.15 0 .31.205.665.79.555A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
              </svg>
              {t("login.continueWithGithub")}
            </button>
          </>
        ) : (
          <>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
              {t("login.codeLabel")}
            </label>
            <p className="mb-3 text-[12px] leading-snug text-neutral-500">
              {t("login.codeHelp", { email })}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void verifyCode();
              }}
            >
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                maxLength={6}
                disabled={working}
                className={cn("mb-3 text-center text-lg font-mono tracking-[0.3em]")}
              />
              <Button
                className="w-full"
                type="submit"
                disabled={working || code.length !== 6}
              >
                {working ? t("login.verifying") : t("login.verifyCode")}
              </Button>
            </form>
            {info && <p className="mt-3 text-sm text-neutral-500">{info}</p>}
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <button
              type="button"
              className="mt-4 text-[12px] font-medium text-neutral-500 hover:text-neutral-900"
              onClick={() => {
                setStage("email");
                setCode("");
                setError(null);
                setInfo(null);
              }}
            >
              ← {t("login.useDifferentEmail")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
