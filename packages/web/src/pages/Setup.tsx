/**
 * First-run instance setup wizard.
 *
 * Walks a fresh install through the values Quillra needs to actually
 * function: Anthropic key, GitHub App, and optional email delivery.
 *
 * Routes-level guard: any time /api/setup/status says needsSetup is
 * true, the rest of the app bounces users here (see App.tsx).
 */

import { LogoMark } from "@/components/atoms/LogoMark";
import { AnthropicStep } from "@/components/organisms/setup/AnthropicStep";
import { EmailStep } from "@/components/organisms/setup/EmailStep";
import { GithubAppStep } from "@/components/organisms/setup/GithubAppStep";
import { OrganizationStep } from "@/components/organisms/setup/OrganizationStep";
import { SigninStep } from "@/components/organisms/setup/SigninStep";
import { StepIndicator } from "@/components/organisms/setup/StepIndicator";
import { WelcomeStep } from "@/components/organisms/setup/WelcomeStep";
import type { Step } from "@/components/organisms/setup/types";
import { apiJson } from "@/lib/api";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

type StatusResponse = {
  needsSetup: boolean;
  needsOwner: boolean;
  missing: string[];
  values: Record<string, { set: boolean; source: "db" | "env" | "none"; value?: string }>;
};

export function SetupPage() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<Step>("welcome");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [emailProvider, setEmailProvider] = useState<"none" | "resend" | "smtp">("none");
  const [emailFrom, setEmailFrom] = useState("Quillra <hello@quillra.com>");
  const [resendKey, setResendKey] = useState("");
  const [smtp, setSmtp] = useState({
    host: "",
    port: "587",
    user: "",
    password: "",
    secure: "false",
  });
  const [org, setOrg] = useState({
    instanceName: "Quillra",
    operatorName: "",
    company: "",
    email: "",
    address: "",
    website: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Honor deep links from the GitHub App manifest callback. When the
  // backend persists the credentials it redirects to
  //   /setup?step=githubApp&created=1&installUrl=...
  // and the installation page on github.com redirects back here with
  //   /setup?step=githubApp&installed=1&installation_id=...
  // In both cases we jump straight to the GitHub App step instead of
  // starting over at "welcome".
  useEffect(() => {
    const deepStep = searchParams.get("step");
    if (deepStep === "githubApp") setStep("githubApp");
  }, [searchParams]);

  // Load status on mount
  useEffect(() => {
    (async () => {
      try {
        const s = await apiJson<StatusResponse>("/api/setup/status");
        setStatus(s);
        if (!s.needsSetup) {
          // Already configured, nothing to do here
          nav("/dashboard", { replace: true });
        }
      } catch {
        /* ignore */
      }
    })();
  }, [nav]);

  async function saveValues(values: Record<string, string | null>) {
    setSaving(true);
    setError(null);
    try {
      await apiJson("/api/setup/save", {
        method: "POST",
        body: JSON.stringify({ values }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      throw e;
    } finally {
      setSaving(false);
    }
  }

  async function handleAnthropicNext() {
    if (!anthropicKey.trim()) return;
    try {
      await saveValues({ ANTHROPIC_API_KEY: anthropicKey.trim() });
      setStep("githubApp");
    } catch {
      /* stay on step */
    }
  }

  // The GitHub App step has no "next" handler that saves fields, the
  // creation flow hands off to GitHub and back, persisting credentials
  // server-side. This button just advances past the step.
  function handleGithubAppNext() {
    setStep("email");
  }

  async function handleEmailNext() {
    const values: Record<string, string | null> = {
      EMAIL_PROVIDER: emailProvider,
      EMAIL_FROM: emailFrom.trim() || null,
    };
    if (emailProvider === "resend") {
      values.RESEND_API_KEY = resendKey.trim() || null;
    } else if (emailProvider === "smtp") {
      values.SMTP_HOST = smtp.host.trim() || null;
      values.SMTP_PORT = smtp.port.trim() || null;
      values.SMTP_USER = smtp.user.trim() || null;
      values.SMTP_PASSWORD = smtp.password.trim() || null;
      values.SMTP_SECURE = smtp.secure;
    } else {
      values.RESEND_API_KEY = null;
      values.SMTP_HOST = null;
    }
    try {
      await saveValues(values);
      setStep("organization");
    } catch {
      /* stay on step */
    }
  }

  async function handleOrganizationNext() {
    const values: Record<string, string | null> = {
      INSTANCE_NAME: org.instanceName.trim() || null,
      INSTANCE_OPERATOR_NAME: org.operatorName.trim() || null,
      INSTANCE_OPERATOR_COMPANY: org.company.trim() || null,
      INSTANCE_OPERATOR_EMAIL: org.email.trim() || null,
      INSTANCE_OPERATOR_ADDRESS: org.address.trim() || null,
      INSTANCE_OPERATOR_WEBSITE: org.website.trim() || null,
    };
    try {
      await saveValues(values);
      setStep("signin");
    } catch {
      /* stay on step */
    }
  }

  if (!status) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-neutral-50 to-neutral-100">
      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-14">
        <div className="mb-10 flex items-center gap-3">
          <LogoMark size={28} />
          <span className="font-brand text-xl font-bold tracking-tight">Quillra</span>
          <span className="ml-auto text-[11px] font-medium uppercase tracking-wider text-neutral-400">
            Setup
          </span>
        </div>

        <StepIndicator step={step} />

        <div className="overflow-hidden rounded-3xl border border-neutral-200/80 bg-white shadow-sm">
          {step === "welcome" && <WelcomeStep onNext={() => setStep("anthropic")} />}

          {step === "anthropic" && (
            <AnthropicStep
              value={anthropicKey}
              onChange={setAnthropicKey}
              onBack={() => setStep("welcome")}
              onNext={handleAnthropicNext}
              saving={saving}
              error={error}
              keyFromEnv={
                status.values.ANTHROPIC_API_KEY.set &&
                status.values.ANTHROPIC_API_KEY.source === "env"
              }
            />
          )}

          {step === "githubApp" && (
            <GithubAppStep
              appConfigured={Boolean(
                status.values.GITHUB_APP_ID?.set && status.values.GITHUB_APP_PRIVATE_KEY?.set,
              )}
              appName={status.values.GITHUB_APP_NAME?.value}
              onBack={() => setStep("anthropic")}
              onNext={handleGithubAppNext}
            />
          )}

          {step === "email" && (
            <EmailStep
              provider={emailProvider}
              onProviderChange={setEmailProvider}
              from={emailFrom}
              onFromChange={setEmailFrom}
              resendKey={resendKey}
              onResendKeyChange={setResendKey}
              smtp={smtp}
              onSmtpChange={setSmtp}
              onBack={() => setStep("githubApp")}
              onNext={handleEmailNext}
              saving={saving}
              error={error}
            />
          )}

          {step === "organization" && (
            <OrganizationStep
              org={org}
              onOrgChange={setOrg}
              onBack={() => setStep("email")}
              onNext={handleOrganizationNext}
              saving={saving}
              error={error}
            />
          )}

          {step === "signin" && <SigninStep />}
        </div>
      </main>
    </div>
  );
}
