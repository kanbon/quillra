/**
 * Branded client login page (/c/:projectId).
 *
 * Shown to passwordless invitees who got an invite email. The page renders
 * the project's own name and logo — NOT Quillra's branding — so the
 * experience feels like a small dedicated portal.
 *
 * Two-step flow:
 *   1. Enter email → POST /api/clients/request-code (sends a 6-digit code via Resend)
 *   2. Enter code  → POST /api/clients/verify-code  (sets quillra_client_session cookie)
 *
 * On success the user is redirected to /p/{projectId} with their session.
 */

import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

type Branding = {
  id: string;
  name: string;
  logoUrl: string | null;
};

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "·"
  );
}

export function ClientLoginPage() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const nav = useNavigate();

  const [branding, setBranding] = useState<Branding | null>(null);
  const [brandingErr, setBrandingErr] = useState<string | null>(null);
  const [step, setStep] = useState<"email" | "code">("email");
  // Prefill email from ?email= query param so recipients clicking through
  // from the invite email don't have to re-type it.
  const [email, setEmail] = useState(() => {
    const raw = searchParams.get("email") ?? "";
    return raw.trim().toLowerCase();
  });
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);

  // Load the project's branding (name + logo)
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      try {
        const b = await apiJson<Branding>(`/api/clients/branding/${projectId}`);
        setBranding(b);
      } catch (e) {
        setBrandingErr(e instanceof Error ? e.message : "Project not found");
      }
    })();
  }, [projectId]);

  // If they already have a client session for this project, skip the form
  useEffect(() => {
    (async () => {
      try {
        const me = await apiJson<{ user: unknown; projectId: string }>("/api/clients/me");
        if (me.projectId === projectId) nav(`/p/${projectId}`, { replace: true });
      } catch {
        /* not signed in — stay on this page */
      }
    })();
  }, [projectId, nav]);

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiJson<{ ok: boolean; devCode?: string }>("/api/clients/request-code", {
        method: "POST",
        body: JSON.stringify({ projectId, email: email.trim().toLowerCase() }),
      });
      if (res.devCode) setDevCode(res.devCode);
      setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send code");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiJson("/api/clients/verify-code", {
        method: "POST",
        body: JSON.stringify({ projectId, email: email.trim().toLowerCase(), code: code.trim() }),
      });
      nav(`/p/${projectId}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setSubmitting(false);
    }
  }

  if (brandingErr) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
        <div className="max-w-sm text-center">
          <p className="text-sm text-neutral-500">This page isn't available.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-neutral-50 to-neutral-100 px-4">
      <div className="w-full max-w-md">
        <div className="overflow-hidden rounded-3xl border border-neutral-200/80 bg-white shadow-xl shadow-neutral-200/50">
          <div className="flex flex-col items-center px-8 pb-2 pt-10">
            {branding?.logoUrl ? (
              <img
                src={branding.logoUrl}
                alt={branding.name}
                className="mb-5 h-16 w-16 rounded-2xl object-cover ring-1 ring-neutral-200"
              />
            ) : branding ? (
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-neutral-900 to-neutral-700 text-xl font-semibold text-white">
                {initialsOf(branding.name)}
              </div>
            ) : (
              <div className="mb-5 h-16 w-16 animate-pulse rounded-2xl bg-neutral-200" />
            )}
            <h1 className="text-center text-[22px] font-semibold tracking-tight text-neutral-900">
              {branding?.name ?? "…"}
            </h1>
            <p className="mt-1 text-center text-sm text-neutral-500">
              {step === "email" ? "Sign in to edit your site" : "Enter the code we just sent you"}
            </p>
          </div>

          <div className="px-8 pb-8 pt-6">
            {step === "email" && (
              <form className="flex flex-col gap-3" onSubmit={handleRequestCode}>
                <label className="text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  Email
                </label>
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-12 rounded-xl border border-neutral-200 bg-white px-4 text-[15px] text-neutral-900 placeholder:text-neutral-400 transition-colors focus:border-neutral-900 focus:outline-none focus:ring-0"
                  disabled={submitting}
                />
                <button
                  type="submit"
                  disabled={submitting || !email.trim()}
                  className={cn(
                    "mt-2 inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-neutral-900 text-[15px] font-semibold text-white shadow-sm transition-all",
                    submitting || !email.trim()
                      ? "cursor-not-allowed opacity-50"
                      : "hover:bg-neutral-800 hover:shadow",
                  )}
                >
                  {submitting ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      Sending…
                    </>
                  ) : (
                    "Continue"
                  )}
                </button>
                {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
                <p className="mt-3 text-center text-[11px] text-neutral-400">
                  We'll email you a 6-digit code. No password needed.
                </p>
              </form>
            )}

            {step === "code" && (
              <form className="flex flex-col gap-3" onSubmit={handleVerify}>
                <p className="rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
                  We sent a code to{" "}
                  <strong className="font-medium text-neutral-900">{email}</strong>.
                </p>
                <label className="text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  6-digit code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  required
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="h-14 rounded-xl border border-neutral-200 bg-white px-4 text-center font-mono text-[24px] tracking-[0.4em] text-neutral-900 placeholder:text-neutral-300 transition-colors focus:border-neutral-900 focus:outline-none focus:ring-0"
                  disabled={submitting}
                />
                {devCode && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    Email is not configured on this server. Dev code:{" "}
                    <code className="font-mono font-semibold">{devCode}</code>
                  </p>
                )}
                <button
                  type="submit"
                  disabled={submitting || code.length !== 6}
                  className={cn(
                    "mt-2 inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-neutral-900 text-[15px] font-semibold text-white shadow-sm transition-all",
                    submitting || code.length !== 6
                      ? "cursor-not-allowed opacity-50"
                      : "hover:bg-neutral-800 hover:shadow",
                  )}
                >
                  {submitting ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      Verifying…
                    </>
                  ) : (
                    "Sign in"
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setError(null);
                    setDevCode(null);
                  }}
                  className="mt-1 text-center text-[12px] text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline"
                  disabled={submitting}
                >
                  Use a different email
                </button>
                {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
              </form>
            )}
          </div>
        </div>
        <p className="mt-6 text-center text-[10px] uppercase tracking-[0.18em] text-neutral-400">
          Powered by Quillra
        </p>
      </div>
    </div>
  );
}
