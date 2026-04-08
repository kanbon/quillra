import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Spinner } from "@/components/atoms/Spinner";
import { authClient } from "@/lib/auth-client";
import { apiJson } from "@/lib/api";

type ClientSession = { user: { id: string; email: string } | null; projectId?: string };

/**
 * Allows two kinds of authenticated users in:
 *  - Better Auth sessions (collaborators signed in with GitHub)
 *  - Quillra client sessions (passwordless email-code, scoped to one project)
 *
 * If the user is a client and the URL targets a project that isn't theirs,
 * they're redirected to their assigned project's branded login page.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isPending } = authClient.useSession();
  const params = useParams<{ projectId?: string }>();
  const [clientCheck, setClientCheck] = useState<"pending" | "none" | ClientSession>("pending");

  // Probe for a client session whenever the Better Auth session is missing
  useEffect(() => {
    if (isPending) return;
    if (data?.user) {
      setClientCheck("none");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await apiJson<ClientSession>("/api/clients/me");
        if (!cancelled) setClientCheck(r);
      } catch {
        if (!cancelled) setClientCheck("none");
      }
    })();
    return () => { cancelled = true; };
  }, [isPending, data?.user]);

  if (isPending || clientCheck === "pending") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (data?.user) {
    return <>{children}</>;
  }

  if (clientCheck !== "none" && clientCheck.user && clientCheck.projectId) {
    // If the route is for a project they're NOT a client of, push them
    // to the branded login of their actual project.
    if (params.projectId && params.projectId !== clientCheck.projectId) {
      return <Navigate to={`/p/${clientCheck.projectId}`} replace />;
    }
    return <>{children}</>;
  }

  return <Navigate to="/login" replace />;
}
