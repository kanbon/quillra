import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { projectMembers } from "../../db/schema.js";
import type { SessionUser } from "../../lib/auth.js";

export type Variables = {
  user: SessionUser | null;
  /** Populated when the request was authenticated via the client session cookie. */
  clientSession: { projectId: string } | null;
};

export async function requireUser(c: {
  get: (k: "user") => SessionUser | null;
  json: (b: unknown, s: number) => Response;
}) {
  const user = c.get("user");
  if (!user) return { error: c.json({ error: "Unauthorized" }, 401) };
  return { user };
}

export async function memberForProject(userId: string, projectId: string) {
  const [row] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}
