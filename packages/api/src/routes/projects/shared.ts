import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../../db/index.js";
import { projectMembers } from "../../db/schema.js";
import type { SessionUser } from "../../lib/auth.js";

export type ClientSession = { projectId: string };

export type Variables = {
  user: SessionUser | null;
  /** Populated when the request was authenticated via the client session cookie. */
  clientSession: ClientSession | null;
};

/** Keep project scope identical across REST and WebSocket authentication. */
export function clientSessionCanAccessProject(
  clientSession: ClientSession | null | undefined,
  projectId: string,
): boolean {
  return !clientSession || clientSession.projectId === projectId;
}

export async function requireUser(c: Context<{ Variables: Variables }>) {
  const user = c.get("user");
  if (!user) return { error: c.json({ error: "Unauthorized" }, 401) };

  const clientSession = c.get("clientSession") ?? null;
  const requestedProjectId = c.req.param("id");
  if (requestedProjectId && !clientSessionCanAccessProject(clientSession, requestedProjectId)) {
    // Do not disclose whether a project outside the client session scope exists.
    return { error: c.json({ error: "Not found" }, 404) };
  }

  return { user, clientSession };
}

export async function memberForProject(userId: string, projectId: string) {
  const [row] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}
