/**
 * Hook that reports which other users are currently viewing {projectId}.
 *
 * Internally beats the presence endpoint every ~10 seconds, which both
 * (a) marks the current user as alive in the server's in-memory presence
 * map and (b) returns every other fresh viewer. The server excludes the
 * caller so the hook's output is guaranteed "everyone *else* who's here".
 *
 * Idle tabs stop beating (refetchIntervalInBackground: false) — no need
 * to hammer the API for a tab nobody is looking at.
 */
import { useQuery } from "@tanstack/react-query";
import { apiJson } from "@/lib/api";

export type PresenceUser = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  kind: "team" | "client";
  lastSeenAt: number;
};

type BeatResponse = { others: PresenceUser[] };

export function useProjectPresence(projectId: string | undefined): PresenceUser[] {
  const q = useQuery({
    queryKey: ["presence", projectId],
    queryFn: () =>
      apiJson<BeatResponse>(`/api/projects/${projectId}/presence/beat`, {
        method: "POST",
      }),
    enabled: Boolean(projectId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
    // Don't retry aggressively — a transient failure just means no presence
    // this tick; the next tick is 10s away.
    retry: false,
  });
  return q.data?.others ?? [];
}
