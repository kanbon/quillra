/**
 * Unified session hook recognizing every way a user can be signed in:
 *
 *  - "github", Better Auth session (GitHub OAuth). Used by the instance
 *                owner and anyone who voluntarily linked GitHub.
 *  - "team", email-code session for admins/editors/translators who
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
import { useEffect, useState } from "react";

export type CurrentUser =
  | { kind: "loading" }
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
  user: null | {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
    instanceRole?: string | null;
  };
};

type ClientMeResponse = {
  user: { id: string; email: string } | null;
  projectId?: string;
};

export function useCurrentUser(): CurrentUser {
  const { data, isPending } = authClient.useSession();
  const [team, setTeam] = useState<SessionResponse["user"] | "none" | "pending">("pending");
  const [client, setClient] = useState<ClientMeResponse | "none" | "pending">("pending");

  useEffect(() => {
    if (isPending) return;
    if (data?.user) {
      // Better Auth already resolved a GitHub session; skip the fallbacks.
      setTeam("none");
      setClient("none");
      return;
    }
    let cancelled = false;
    (async () => {
      // Try team session (also resolves github sessions as a side effect,
      // but that's fine, if Better Auth said no, /api/session says no too).
      try {
        const r = await apiJson<SessionResponse>("/api/session");
        if (cancelled) return;
        if (r.user) {
          setTeam(r.user);
          setClient("none");
          return;
        }
      } catch {
        /* fall through */
      }
      if (cancelled) return;
      setTeam("none");
      // Still nothing? Try client session.
      try {
        const r = await apiJson<ClientMeResponse>("/api/clients/me");
        if (cancelled) return;
        setClient(r.user && r.projectId ? r : "none");
      } catch {
        if (!cancelled) setClient("none");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPending, data?.user]);

  if (isPending || team === "pending" || client === "pending") return { kind: "loading" };
  if (data?.user) {
    return {
      kind: "github",
      user: data.user as {
        id: string;
        email?: string | null;
        name?: string | null;
        image?: string | null;
      },
    };
  }
  if (team !== "none" && team) {
    return { kind: "team", user: team };
  }
  if (client !== "none" && client.user && client.projectId) {
    return { kind: "client", user: client.user, projectId: client.projectId };
  }
  return { kind: "none" };
}

/** True for any sign-in that sees the dashboard (i.e. not a client). */
export function isTeamSide(me: CurrentUser): boolean {
  return me.kind === "github" || me.kind === "team";
}

export async function signOutUnified(kind: "github" | "team" | "client") {
  if (kind === "client") {
    try {
      await fetch("/api/clients/logout", { method: "POST", credentials: "include" });
    } catch {
      /* best effort */
    }
  } else if (kind === "team") {
    try {
      await fetch("/api/team-login/logout", { method: "POST", credentials: "include" });
    } catch {
      /* best effort */
    }
  } else {
    try {
      await authClient.signOut({ fetchOptions: { credentials: "include" } });
    } catch {
      /* best effort */
    }
  }
  window.location.href = "/login";
}
