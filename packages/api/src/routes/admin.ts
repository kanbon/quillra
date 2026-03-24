import { eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { instanceInvites } from "../db/app-schema.js";
import type { SessionUser } from "../lib/auth.js";

type Variables = { user: SessionUser | null };

async function requireOwner(c: {
  get: (k: "user") => SessionUser | null;
  json: (b: unknown, s: number) => Response;
}) {
  const u = c.get("user");
  if (!u) return { error: c.json({ error: "Unauthorized" }, 401) };
  const [row] = await db.select().from(user).where(eq(user.id, u.id)).limit(1);
  if (!row || row.instanceRole !== "owner") {
    return { error: c.json({ error: "Owner access required" }, 403) };
  }
  return { user: u };
}

export const adminRouter = new Hono<{ Variables: Variables }>()
  .get("/members", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const members = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        instanceRole: user.instanceRole,
        createdAt: user.createdAt,
      })
      .from(user);
    return c.json({ members });
  })
  .post("/invites", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ email: z.string().email() }).safeParse(body);
    if (!parsed.success) return c.json({ error: "Valid email required" }, 400);

    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    await db.insert(instanceInvites).values({
      id: nanoid(),
      email: parsed.data.email,
      tokenHash,
      invitedByUserId: r.user.id,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });

    return c.json({ ok: true, email: parsed.data.email });
  })
  .get("/invites", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const invites = await db
      .select()
      .from(instanceInvites)
      .where(isNull(instanceInvites.acceptedAt));
    return c.json({
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        expiresAt: i.expiresAt.getTime(),
      })),
    });
  })
  .delete("/members/:userId", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const userId = c.req.param("userId");
    if (userId === r.user.id) {
      return c.json({ error: "Cannot remove yourself" }, 400);
    }
    await db.delete(user).where(eq(user.id, userId));
    return c.newResponse(null, 204);
  })
  .delete("/invites/:inviteId", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const inviteId = c.req.param("inviteId");
    await db.delete(instanceInvites).where(eq(instanceInvites.id, inviteId));
    return c.newResponse(null, 204);
  });
