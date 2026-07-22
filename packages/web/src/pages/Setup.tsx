/**
 * First-run instance setup wizard.
 *
 * Walks a fresh install through the values Quillra needs to actually
 * function: Anthropic key, GitHub App, optional email delivery, and the
 * first owner account.
 *
 * Routes-level guard: any time /api/setup/status says needsSetup is
 * true, the rest of the app bounces users here (see App.tsx).
 */

import { LogoMark } from "@/components/atoms/LogoMark";
import { AnthropicStep } from "@/components/organisms/setup/AnthropicStep";
import { EmailStep } from "@/components/organisms/setup/EmailStep";
import { GithubAppStep } from "@/components/organisms/setup/GithubAppStep";
import { OrganizationStep } from "@/components/organisms/setup/OrganizationStep";
import { SetupAccessScreen } from "@/components/organisms/setup/SetupAccessScreen";
import { SetupStatusScreen } from "@/components/organisms/setup/SetupStatusScreen";
import { SigninStep } from "@/components/organisms/setup/SigninStep";
import { StepIndicator } from "@/components/organisms/setup/StepIndicator";
import { WelcomeStep } from "@/components/organisms/setup/WelcomeStep";
import type { Step } from "@/components/organisms/setup/types";
import { clearSetupGateCache } from "@/components/templates/SetupGate";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

type GrantedStatus = {
  access: "granted";
  needsSetup: boolean;
  needsOwner: boolean;
  missing: string[];
  values: Record<string, { set: boolean; source: "db" | "env" | "none"; value?: string }>;
};

type StatusResponse =
  | GrantedStatus
  | {
      access: "token-required" | "owner-required" | "complete";
      needsSetup: boolean;
      needsOwner: boolean;
    };

export function SetupPage() {
  const { t } = useT();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<Step>("welcome");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const grantedStatus = status?.access === "granted" ? status : null;
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [emailProvider, setEmailProvider] = useState<"none" | "resend" | "smtp">("none");
  const [emailFrom, setEmailFrom] = useState("");
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
  const statusRequestIdRef = useRef(0);
  const statusDefaultsAppliedRef = useRef(false);

  function moveToStep(nextStep: Step) {
    setError(null);
    setStep(nextStep);
  }

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

  useEffect(() => {
    if (!status || status.access !== "granted" || statusLoading || statusError) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`setup-step-heading-${step}`)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [step, status, statusLoading, statusError]);

  const loadStatus = useCallback(async () => {
    const requestId = ++statusRequestIdRef.current;
    setStatusLoading(true);
    setStatusError(null);
    setStatus(null);
    try {
      const nextStatus = await apiJson<StatusResponse>("/api/setup/status");
      if (requestId !== statusRequestIdRef.current) return;
      setStatus(nextStatus);
      if (nextStatus.access === "complete") {
        nav("/dashboard", { replace: true });
        return;
      }
      if (nextStatus.access !== "granted") return;
      if (!statusDefaultsAppliedRef.current) {
        statusDefaultsAppliedRef.current = true;
        const configuredProvider = nextStatus.values.EMAIL_PROVIDER?.value;
        if (
          configuredProvider === "none" ||
          configuredProvider === "resend" ||
          configuredProvider === "smtp"
        ) {
          setEmailProvider(configuredProvider);
        }
        if (nextStatus.values.EMAIL_FROM?.value) {
          setEmailFrom(nextStatus.values.EMAIL_FROM.value);
        }
        setSmtp((current) => ({
          ...current,
          host: nextStatus.values.SMTP_HOST?.value ?? current.host,
          port: nextStatus.values.SMTP_PORT?.value ?? current.port,
          user: nextStatus.values.SMTP_USER?.value ?? current.user,
          secure: nextStatus.values.SMTP_SECURE?.value ?? current.secure,
        }));
        setOrg((current) => ({
          ...current,
          instanceName: nextStatus.values.INSTANCE_NAME?.value ?? current.instanceName,
          operatorName: nextStatus.values.INSTANCE_OPERATOR_NAME?.value ?? current.operatorName,
          company: nextStatus.values.INSTANCE_OPERATOR_COMPANY?.value ?? current.company,
          email: nextStatus.values.INSTANCE_OPERATOR_EMAIL?.value ?? current.email,
          address: nextStatus.values.INSTANCE_OPERATOR_ADDRESS?.value ?? current.address,
          website: nextStatus.values.INSTANCE_OPERATOR_WEBSITE?.value ?? current.website,
        }));
      }
      if (!nextStatus.needsSetup) {
        nav("/dashboard", { replace: true });
      }
    } catch {
      if (requestId !== statusRequestIdRef.current) return;
      setStatusError(t("setup.statusRequestFailed"));
    } finally {
      if (requestId === statusRequestIdRef.current) setStatusLoading(false);
    }
  }, [nav, t]);

  useEffect(() => {
    void loadStatus();
    return () => {
      statusRequestIdRef.current += 1;
    };
  }, [loadStatus]);

  async function unlockSetup(token: string) {
    if (unlocking) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      await apiJson("/api/setup/unlock", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      await loadStatus();
    } catch {
      setUnlockError(t("setup.serverAccessFailed"));
    } finally {
      setUnlocking(false);
    }
  }

  async function saveValues(values: Record<string, string | null>): Promise<GrantedStatus> {
    setSaving(true);
    setError(null);
    try {
      const response = await apiJson<{ ok: true; status: GrantedStatus }>("/api/setup/save", {
        method: "POST",
        body: JSON.stringify({ values }),
      });
      setStatus(response.status);
      return response.status;
    } catch (saveFailure) {
      setError(t("setup.saveFailed"));
      throw saveFailure;
    } finally {
      setSaving(false);
    }
  }

  async function handleAnthropicNext() {
    if (saving) return;
    if (!anthropicKey.trim()) {
      // Configured secrets are intentionally masked instead of copied into
      // the browser. Let the operator keep either a DB- or env-managed key.
      if (grantedStatus?.values.ANTHROPIC_API_KEY.set) {
        moveToStep("githubApp");
      }
      return;
    }
    try {
      await saveValues({ ANTHROPIC_API_KEY: anthropicKey.trim() });
      moveToStep("githubApp");
    } catch {
      /* stay on step */
    }
  }

  // The GitHub App step has no "next" handler that saves fields, the
  // creation flow hands off to GitHub and back, persisting credentials
  // server-side. This button just advances past the step.
  function handleGithubAppNext() {
    moveToStep("email");
  }

  async function handleEmailNext() {
    if (saving) return;
    const values: Record<string, string | null> = {
      EMAIL_PROVIDER: emailProvider,
      EMAIL_FROM: emailProvider === "none" ? null : emailFrom.trim() || null,
    };
    if (emailProvider === "resend") {
      if (resendKey.trim()) {
        values.RESEND_API_KEY = resendKey.trim();
      } else if (!grantedStatus?.values.RESEND_API_KEY?.set) {
        setError(t("setup.resendKeyRequired"));
        return;
      }
    } else if (emailProvider === "smtp") {
      values.SMTP_HOST = smtp.host.trim() || null;
      values.SMTP_PORT = smtp.port.trim() || null;
      values.SMTP_USER = smtp.user.trim() || null;
      values.SMTP_SECURE = smtp.secure;
      if (smtp.password.trim()) {
        values.SMTP_PASSWORD = smtp.password.trim();
      }
    } else {
      values.RESEND_API_KEY = null;
      values.SMTP_HOST = null;
      values.SMTP_PORT = null;
      values.SMTP_USER = null;
      values.SMTP_PASSWORD = null;
      values.SMTP_SECURE = null;
    }
    try {
      await saveValues(values);
      moveToStep("organization");
    } catch {
      /* stay on step */
    }
  }

  async function handleOrganizationNext() {
    if (saving) return;
    if (!org.operatorName.trim()) {
      setError(t("setup.operatorNameRequired"));
      return;
    }
    const values: Record<string, string | null> = {
      INSTANCE_NAME: org.instanceName.trim() || null,
      INSTANCE_OPERATOR_NAME: org.operatorName.trim() || null,
      INSTANCE_OPERATOR_COMPANY: org.company.trim() || null,
      INSTANCE_OPERATOR_EMAIL: org.email.trim() || null,
      INSTANCE_OPERATOR_ADDRESS: org.address.trim() || null,
      INSTANCE_OPERATOR_WEBSITE: org.website.trim() || null,
    };
    try {
      const nextStatus = await saveValues(values);
      if (nextStatus.needsOwner) {
        moveToStep("signin");
        return;
      }
      if (nextStatus.needsSetup) {
        setError(t("setup.stillMissing", { items: nextStatus.missing.join(", ") }));
        return;
      }

      clearSetupGateCache();
      const email = org.email.trim();
      window.location.href = email ? `/login?email=${encodeURIComponent(email)}` : "/login";
    } catch {
      /* stay on step */
    }
  }

  if (statusLoading) {
    return <SetupStatusScreen state="loading" />;
  }

  if (statusError) {
    return <SetupStatusScreen state="error" detail={statusError} onRetry={loadStatus} />;
  }

  if (!status) {
    return <SetupStatusScreen state="error" onRetry={loadStatus} />;
  }

  if (status.access === "token-required") {
    return (
      <SetupAccessScreen
        mode="token"
        working={unlocking}
        error={unlockError}
        onUnlock={unlockSetup}
      />
    );
  }

  if (status.access === "owner-required") {
    return <SetupAccessScreen mode="owner" />;
  }

  if (status.access === "complete") {
    return <SetupStatusScreen state="loading" />;
  }

  if (!grantedStatus) {
    return <SetupStatusScreen state="error" onRetry={loadStatus} />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-8 sm:px-6 sm:py-14">
        <div className="mb-8 flex items-center gap-3 sm:mb-10">
          <LogoMark size={28} />
          <span className="font-brand text-xl font-bold tracking-tight text-ink">Quillra</span>
          <span className="ml-auto text-[11px] font-semibold uppercase tracking-wider text-graphite">
            {t("setup.badge")}
          </span>
        </div>

        <StepIndicator step={step} />

        <div className="overflow-hidden rounded-3xl border border-rule bg-paper shadow-sm">
          {step === "welcome" && <WelcomeStep onNext={() => moveToStep("anthropic")} />}

          {step === "anthropic" && (
            <AnthropicStep
              value={anthropicKey}
              onChange={setAnthropicKey}
              onBack={() => moveToStep("welcome")}
              onNext={handleAnthropicNext}
              saving={saving}
              error={error}
              keyConfigured={grantedStatus.values.ANTHROPIC_API_KEY.set}
            />
          )}

          {step === "githubApp" && (
            <GithubAppStep
              appConfigured={Boolean(
                grantedStatus.values.GITHUB_APP_ID?.set &&
                  grantedStatus.values.GITHUB_APP_PRIVATE_KEY?.set,
              )}
              appName={grantedStatus.values.GITHUB_APP_NAME?.value}
              onBack={() => moveToStep("anthropic")}
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
              resendKeyConfigured={Boolean(grantedStatus.values.RESEND_API_KEY?.set)}
              smtpPasswordConfigured={Boolean(grantedStatus.values.SMTP_PASSWORD?.set)}
              onResendKeyChange={setResendKey}
              smtp={smtp}
              onSmtpChange={setSmtp}
              onBack={() => moveToStep("githubApp")}
              onNext={handleEmailNext}
              saving={saving}
              error={error}
            />
          )}

          {step === "organization" && (
            <OrganizationStep
              org={org}
              onOrgChange={setOrg}
              onBack={() => moveToStep("email")}
              onNext={handleOrganizationNext}
              saving={saving}
              error={error}
            />
          )}

          {step === "signin" && (
            <SigninStep
              initialEmail={org.email}
              deliveryDisabled={emailProvider === "none"}
              onBack={() => moveToStep("organization")}
            />
          )}
        </div>
      </main>
    </div>
  );
}
