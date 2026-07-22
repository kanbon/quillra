/**
 * Unified session hook recognizing every way a user can be signed in:
 *
 *  - "github", Better Auth session (GitHub OAuth). Used by the instance
 *                owner and anyone who voluntarily linked GitHub.
 *  - "team", email-code session for admins and editors who
 *                don't want a GitHub account. Full dashboard access via
 *                projectMembers rows. From the UI's perspective this is
 *                equivalent to "github", the only difference is the
 *                sign-out endpoint.
 *  - "client", passwordless email-code session scoped to ONE project.
 *                These users never see the dashboard.
 *
 * Callers typically only need `kind === "client"` vs everything else.
 * The helper `isTeamSide(me)` bundles github+team for that exact check.
 */

import { apiJson } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useQuery } from "@tanstack/react-query";

export type CurrentUser =
  | { kind: "loading" }
  | { kind: "error"; retry: () => void; retrying: boolean }
  | { kind: "none" }
  | {
      kind: "github";
      user: { id: string; email?: string | null; name?: string | null; image?: string | null };
    }
  | {
      kind: "team";
      user: {
        id: string;
        email: string;
        name?: string | null;
        image?: string | null;
        instanceRole?: string | null;
      };
    }
  | { kind: "client"; user: { id: string; email: string }; projectId: string };

type SessionResponse = {
  kind: "none" | "github" | "team" | "client";
  projectId: string | null;
  user: null | {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
    instanceRole?: string | null;
  };
};

export function useCurrentUser(): CurrentUser {
  const { data, isPending, isError, isFetching, refetch } = useQuery({
    queryKey: ["session"],
    queryFn: () => apiJson<SessionResponse>("/api/session"),
  });

  if (isPending) return { kind: "loading" };
  if (isError) {
    return {
      kind: "error",
      retry: () => void refetch(),
      retrying: isFetching,
    };
  }
  if (!data?.user) return { kind: "none" };

  if (data.kind === "client" && data.projectId) {
    return { kind: "client", user: data.user, projectId: data.projectId };
  }
  if (data.kind === "github") {
    return { kind: "github", user: data.user };
  }
  if (data.kind === "team") {
    return { kind: "team", user: data.user };
  }

  return { kind: "none" };
}

/** True for any sign-in that sees the dashboard (i.e. not a client). */
export function isTeamSide(me: CurrentUser): boolean {
  return me.kind === "github" || me.kind === "team";
}

export async function signOutUnified(_kind: "github" | "team" | "client") {
  // Always clear every session mechanism. A browser can carry a stale custom
  // cookie alongside its visible session, and leaving it behind would sign the
  // user straight back in through the middleware's next fallback.
  await Promise.allSettled([
    fetch("/api/team-login/logout", { method: "POST", credentials: "include" }),
    fetch("/api/clients/logout", { method: "POST", credentials: "include" }),
    authClient.signOut({ fetchOptions: { credentials: "include" } }),
  ]);
  window.location.href = "/login";
}
