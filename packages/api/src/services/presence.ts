/**
 * In-memory project presence tracking. Stores "who's currently looking at
 * project X" with a short TTL. Intentionally not persisted, on restart the
 * list rebuilds itself within one heartbeat interval (clients beat every 10s).
 *
 * This module lives entirely in the API process memory. Lost on crash, not
 * shared across multiple API instances. For a single-server self-hosted
 * Quillra install that's fine. If we ever shard the API we'd move this to
 * Redis, but the same interface would apply.
 */

export type PresenceKind = "team" | "client";

export type PresenceEntry = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  kind: PresenceKind;
  lastSeenAt: number;
};

/** How long an entry survives without a beat before it disappears. */
const TTL_MS = 30_000;

/** projectId → userId → entry */
const state = new Map<string, Map<string, PresenceEntry>>();

function bucket(projectId: string): Map<string, PresenceEntry> {
  let m = state.get(projectId);
  if (!m) {
    m = new Map();
    state.set(projectId, m);
  }
  return m;
}

function prune(m: Map<string, PresenceEntry>): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [userId, entry] of m) {
    if (entry.lastSeenAt < cutoff) m.delete(userId);
  }
}

/**
 * Record that {user} is currently viewing {projectId}. Overwrites any
 * previous entry for the same userId in the same project.
 */
export function beat(
  projectId: string,
  user: { id: string; name: string; email: string; image: string | null },
  kind: PresenceKind,
): void {
  const m = bucket(projectId);
  m.set(user.id, {
    userId: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    kind,
    lastSeenAt: Date.now(),
  });
}

/**
 * Return fresh entries in {projectId}, excluding the caller. Lazily prunes
 * stale entries on every call so we don't need a background timer.
 */
export function listOthers(projectId: string, selfUserId: string): PresenceEntry[] {
  const m = bucket(projectId);
  prune(m);
  const out: PresenceEntry[] = [];
  for (const [userId, entry] of m) {
    if (userId === selfUserId) continue;
    out.push(entry);
  }
  // Most-recently-seen first so the avatar stack feels live
  out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return out;
}
