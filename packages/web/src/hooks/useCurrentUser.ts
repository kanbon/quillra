/**
 * Unified session hook that recognizes BOTH Better Auth sessions
 * (collaborators signed in via GitHub) and Quillra client sessions
 * (passwordless email-code, scoped to one project).
 *
 * Returns a single shape with `kind: "github" | "client"` so callers can
 * branch on it for things like sign-out behavior or hiding Dashboard nav.
 */
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { apiJson } from "@/lib/api";

export type CurrentUser =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "github"; user: { id: string; email?: string | null; name?: string | null; image?: string | null } }
  | { kind: "client"; user: { id: string; email: string }; projectId: string };

export function useCurrentUser(): CurrentUser {
  const { data, isPending } = authClient.useSession();
  const [client, setClient] = useState<{ user: { id: string; email: string } | null; projectId?: string } | "none" | "pending">("pending");

  useEffect(() => {
    if (isPending) return;
    if (data?.user) {
      setClient("none");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await apiJson<{ user: { id: string; email: string } | null; projectId?: string }>("/api/clients/me");
        if (cancelled) return;
        setClient(r.user && r.projectId ? r : "none");
      } catch {
        if (!cancelled) setClient("none");
      }
    })();
    return () => { cancelled = true; };
  }, [isPending, data?.user]);

  if (isPending || client === "pending") return { kind: "loading" };
  if (data?.user) {
    return { kind: "github", user: data.user as { id: string; email?: string | null; name?: string | null; image?: string | null } };
  }
  if (client !== "none" && client.user && client.projectId) {
    return { kind: "client", user: client.user, projectId: client.projectId };
  }
  return { kind: "none" };
}

export async function signOutUnified(kind: "github" | "client") {
  if (kind === "client") {
    try {
      await fetch("/api/clients/logout", { method: "POST", credentials: "include" });
    } catch { /* best effort */ }
  } else {
    try {
      await authClient.signOut({ fetchOptions: { credentials: "include" } });
    } catch { /* best effort */ }
  }
  window.location.href = "/login";
}
