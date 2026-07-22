import { clearSetupGateCache } from "@/components/templates/SetupGate";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { useEffect, useState } from "react";

const RESEND_COOLDOWN_SECONDS = 30;

export type TeamLoginStage = "email" | "recovery" | "code";

type Options = {
  initialEmail?: string;
  onVerified?: () => void;
};

/** Shared passwordless team-login state machine for setup and repeat sign-in. */
export function useTeamLoginCode({ initialEmail = "", onVerified }: Options = {}) {
  const { t } = useT();
  const [stage, setStage] = useState<TeamLoginStage>("email");
  const [email, setEmail] = useState(() => initialEmail.trim().toLowerCase());
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setTimeout(() => {
      setResendSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  async function requestCode(accessToken?: string): Promise<"recovery" | "code" | null> {
    if (working) return null;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return null;

    setWorking(true);
    setError(null);
    setDevCode(null);
    try {
      const response = await apiJson<{
        ok: boolean;
        devCode?: string;
        recoveryRequired?: boolean;
      }>("/api/team-login/request-code", {
        method: "POST",
        body: JSON.stringify({
          email: normalizedEmail,
          ...(accessToken?.trim() ? { accessToken: accessToken.trim() } : {}),
        }),
      });
      setEmail(normalizedEmail);
      setCode("");
      if (response.recoveryRequired) {
        setStage("recovery");
        return "recovery";
      }
      setDevCode(response.devCode ?? null);
      setStage("code");
      setResendSeconds(RESEND_COOLDOWN_SECONDS);
      return "code";
    } catch {
      setError(t("login.requestFailed"));
      return null;
    } finally {
      setWorking(false);
    }
  }

  async function verifyCode(): Promise<boolean> {
    if (working || code.length !== 6) return false;
    setWorking(true);
    setError(null);
    try {
      await apiJson("/api/team-login/verify-code", {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase(), code }),
      });
      clearSetupGateCache();
      onVerified?.();
      return true;
    } catch {
      setError(t("login.verifyFailed"));
      return false;
    } finally {
      setWorking(false);
    }
  }

  function resetToEmail() {
    setStage("email");
    setCode("");
    setDevCode(null);
    setError(null);
    setResendSeconds(0);
  }

  return {
    stage,
    email,
    setEmail,
    code,
    setCode,
    devCode,
    working,
    error,
    resendSeconds,
    requestCode,
    verifyCode,
    resetToEmail,
  };
}
