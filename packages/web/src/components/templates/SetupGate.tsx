/**
 * First-run setup gate. Checks /api/setup/status on mount and, if the
 * instance isn't fully configured, redirects the user to the /setup
 * wizard. The wizard itself is exempt.
 *
 * Keeps a module-level cache of the result so we don't refetch on every
 * navigation, the status only changes after a successful save, and the
 * wizard handles that via its own navigate().
 */

import { SetupStatusScreen } from "@/components/organisms/setup/SetupStatusScreen";
import { apiJson } from "@/lib/api";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";

type Status = {
  needsSetup: boolean;
  access: "granted" | "token-required" | "owner-required" | "complete";
};

let cachedStatus: Status | null = null;

/** Invalidate the module-level cache so the next mount refetches /api/setup/status.
 *  Called by the Setup wizard right before the OAuth hand-off, when the user
 *  returns from GitHub the dashboard will recheck status and see the new owner
 *  without an extra redirect through /setup. */
export function clearSetupGateCache() {
  cachedStatus = null;
}

export function SetupGate({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const [status, setStatus] = useState<Status | null>(cachedStatus);
  const [loading, setLoading] = useState(cachedStatus === null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const checkStatus = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const nextStatus = await apiJson<Status>("/api/setup/status");
      if (requestId !== requestIdRef.current) return;
      cachedStatus = nextStatus;
      setStatus(nextStatus);
    } catch (statusError) {
      if (requestId !== requestIdRef.current) return;
      // Fail closed: routing into the app without knowing the setup state
      // produces misleading login and empty-dashboard screens.
      cachedStatus = null;
      setError(
        statusError instanceof Error ? statusError.message : "The setup status request failed.",
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cachedStatus !== null) return;
    void checkStatus();
    return () => {
      requestIdRef.current += 1;
    };
  }, [checkStatus]);

  if (loading) {
    return <SetupStatusScreen state="loading" />;
  }

  if (error) {
    return <SetupStatusScreen state="error" detail={error} onRetry={() => void checkStatus()} />;
  }

  const ownerCanReachLogin = status?.access === "owner-required" && loc.pathname === "/login";
  if (status?.needsSetup && loc.pathname !== "/setup" && !ownerCanReachLogin) {
    return <Navigate to="/setup" replace />;
  }
  if (!status?.needsSetup && loc.pathname === "/setup") {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
