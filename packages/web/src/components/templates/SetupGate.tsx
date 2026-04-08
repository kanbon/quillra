/**
 * First-run setup gate. Checks /api/setup/status on mount and, if the
 * instance isn't fully configured, redirects the user to the /setup
 * wizard. The wizard itself is exempt.
 *
 * Keeps a module-level cache of the result so we don't refetch on every
 * navigation — the status only changes after a successful save, and the
 * wizard handles that via its own navigate().
 */
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, Navigate } from "react-router-dom";
import { apiJson } from "@/lib/api";
import { Spinner } from "@/components/atoms/Spinner";

type Status = { needsSetup: boolean };

let cachedStatus: Status | null = null;

export function SetupGate({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const [status, setStatus] = useState<Status | null>(cachedStatus);
  const [loading, setLoading] = useState(cachedStatus === null);

  useEffect(() => {
    if (cachedStatus !== null) return;
    (async () => {
      try {
        const s = await apiJson<Status>("/api/setup/status");
        cachedStatus = s;
        setStatus(s);
      } catch {
        // Status endpoint failed — assume configured so we don't trap users
        cachedStatus = { needsSetup: false };
        setStatus(cachedStatus);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (status?.needsSetup && loc.pathname !== "/setup") {
    return <Navigate to="/setup" replace />;
  }
  if (!status?.needsSetup && loc.pathname === "/setup") {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
