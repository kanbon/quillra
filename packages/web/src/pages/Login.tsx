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

            <Button
              className="w-full"
              variant="outline"
              disabled={isPending || working}
              type="button"
              onClick={() =>
                authClient.signIn.social({
                  provider: "github",
                  callbackURL: `${window.location.origin}/dashboard`,
                })
              }
            >
              {t("login.continueWithGithub")}
            </Button>
            <p className="mt-3 text-[11px] leading-snug text-neutral-500">
              {t("login.githubHint")}
            </p>
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
