import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Spinner } from "@/components/atoms/Spinner";
import { authClient } from "@/lib/auth-client";
import { apiJson } from "@/lib/api";

/**
 * Gate for every protected route in the app. Three session types are
 * valid, and historically this component only knew about two of them
 * which produced an infinite redirect loop for the third:
 *
 *  1. Better Auth session — the GitHub OAuth owner flow. Detected via
 *     the authClient.useSession() hook.
 *  2. Team session — email-code login for admins / editors / owners
 *     who don't use GitHub. Lives in its own cookie, validated by the
 *     server middleware, surfaces through GET /api/session.
 *  3. Client session — branded email-code login scoped to one project.
 *     Exposed via GET /api/clients/me because we need the projectId to
 *     route clients away from other projects' URLs.
 *
 * The unified /api/session endpoint covers 1 and 2 (and 3, but without
 * the project scope). /api/clients/me is kept as a secondary probe
 * only to discover the client's projectId when they're authed that
 * way. Hitting both in parallel keeps the component fast — the
 * branded-portal path adds no extra latency for team users.
 */

type SessionUser = { id: string; email?: string | null };

type UnifiedAuth =
  | { status: "pending" }
  | { status: "unauth" }
  | { status: "authed"; clientProjectId: string | null };

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: betterAuth, isPending: betterAuthPending } = authClient.useSession();
  const params = useParams<{ projectId?: string }>();
  const [unified, setUnified] = useState<UnifiedAuth>({ status: "pending" });

  useEffect(() => {
    if (betterAuthPending) return;
    // Better Auth already says we're in. No extra probing needed.
    if (betterAuth?.user) {
      setUnified({ status: "authed", clientProjectId: null });
      return;
    }
    // Neither Better Auth session nor loading — probe the unified
    // session endpoint AND the client-scope endpoint in parallel.
    let cancelled = false;
    void (async () => {
      const [sessionRes, clientRes] = await Promise.all([
        apiJson<{ user: SessionUser | null }>("/api/session").catch(
          () => ({ user: null }) as { user: SessionUser | null },
        ),
        apiJson<{ user: SessionUser | null; projectId?: string }>(
          "/api/clients/me",
        ).catch(() => ({ user: null }) as { user: SessionUser | null; projectId?: string }),
      ]);
      if (cancelled) return;
      // Any signal of a valid user → authed. The client endpoint is
      // the only one that knows the project scope; if it didn't come
      // back, clientProjectId stays null and the user gets whatever
      // route they asked for.
      if (sessionRes.user || clientRes.user) {
        setUnified({
          status: "authed",
          clientProjectId: clientRes.user && clientRes.projectId ? clientRes.projectId : null,
        });
      } else {
        setUnified({ status: "unauth" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [betterAuthPending, betterAuth?.user]);

  if (betterAuthPending || unified.status === "pending") {
    return <AuthLoading />;
  }

  if (unified.status === "unauth") {
    return <Navigate to="/login" replace />;
  }

  // Client on the wrong project's URL — bounce them back to their own.
  if (
    unified.clientProjectId &&
    params.projectId &&
    params.projectId !== unified.clientProjectId
  ) {
    return <Navigate to={`/p/${unified.clientProjectId}`} replace />;
  }

  return <>{children}</>;
}

function AuthLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      <Spinner className="size-6" />
    </div>
  );
}
