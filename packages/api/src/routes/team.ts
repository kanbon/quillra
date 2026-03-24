import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../db/index.js";
import { projectInvites, projectMembers, projects } from "../db/schema.js";
import type { SessionUser } from "../lib/auth.js";
import type { ProjectRole } from "../db/app-schema.js";

type Variables = { user: SessionUser | null };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function requireUser(c: { get: (k: "user") => SessionUser | null; json: (b: unknown, s: number) => Response }) {
  const user = c.get("user");
  if (!user) return { error: c.json({ error: "Unauthorized" }, 401) };
  return { user };
}

async function requireProjectAdmin(userId: string, projectId: string) {
  const [m] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  if (!m || m.role !== "admin") return null;
  return m;
}

export const teamRouter = new Hono<{ Variables: Variables }>()
  .get("/projects/:projectId/members", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("projectId");
    const [any] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, r.user.id)))
      .limit(1);
    if (!any) return c.json({ error: "Not found" }, 404);

    const rows = await db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId));
    return c.json({ members: rows });
  })
  .post("/projects/:projectId/invites", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("projectId");
    const admin = await requireProjectAdmin(r.user.id, projectId);
    if (!admin) return c.json({ error: "Forbidden" }, 403);

    const body = await c.req.json().catch(() => null);
    const schema = z.object({
      email: z.string().email(),
      role: z.enum(["admin", "editor", "translator"]).default("editor"),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const token = randomBytes(24).toString("hex");
    const now = new Date();
    const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14);

    await db.insert(projectInvites).values({
      id: nanoid(),
      projectId,
      email: parsed.data.email.toLowerCase(),
      role: parsed.data.role as ProjectRole,
      tokenHash: hashToken(token),
      invitedByUserId: r.user.id,
      expiresAt: expires,
    });

    const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const acceptPath = `/accept-invite?token=${token}`;
    return c.json({
      inviteLink: `${base.replace(/\/$/, "")}${acceptPath}`,
      token,
      message:
        "Share this link with the invitee (email delivery not configured). Token is only shown once in dev.",
    });
  })
  .post("/invites/accept", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null);
    const schema = z.object({ token: z.string().min(10) });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid token" }, 400);

    const email = (r.user.email ?? "").toLowerCase();
    if (!email) return c.json({ error: "Your GitHub account has no verified email" }, 400);

    const tokenHash = hashToken(parsed.data.token);
    const [inv] = await db
      .select()
      .from(projectInvites)
      .where(eq(projectInvites.tokenHash, tokenHash))
      .limit(1);
    if (!inv || inv.acceptedAt) return c.json({ error: "Invalid or used invite" }, 400);
    if (inv.expiresAt.getTime() < Date.now()) return c.json({ error: "Invite expired" }, 400);
    if (inv.email !== email) return c.json({ error: "Signed-in email does not match invite" }, 403);

    const [existing] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, inv.projectId), eq(projectMembers.userId, r.user.id)))
      .limit(1);
    if (!existing) {
      await db.insert(projectMembers).values({
        id: nanoid(),
        projectId: inv.projectId,
        userId: r.user.id,
        role: inv.role,
        invitedByUserId: inv.invitedByUserId,
        createdAt: new Date(),
      });
    }
    await db
      .update(projectInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(projectInvites.id, inv.id));

    return c.json({ projectId: inv.projectId });
  })
  .patch("/projects/:projectId/members/:memberId", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("projectId");
    const memberId = c.req.param("memberId");
    const admin = await requireProjectAdmin(r.user.id, projectId);
    if (!admin) return c.json({ error: "Forbidden" }, 403);

    const body = await c.req.json().catch(() => null);
    const schema = z.object({ role: z.enum(["admin", "editor", "translator"]) });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    await db
      .update(projectMembers)
      .set({ role: parsed.data.role as ProjectRole })
      .where(and(eq(projectMembers.id, memberId), eq(projectMembers.projectId, projectId)));

    return c.json({ ok: true });
  })
  .delete("/projects/:projectId/members/:memberId", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("projectId");
    const memberId = c.req.param("memberId");
    const admin = await requireProjectAdmin(r.user.id, projectId);
    if (!admin) return c.json({ error: "Forbidden" }, 403);

    const [target] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.id, memberId), eq(projectMembers.projectId, projectId)))
      .limit(1);
    if (!target) return c.json({ error: "Not found" }, 404);
    if (target.userId === r.user.id) return c.json({ error: "Cannot remove yourself" }, 400);

    await db.delete(projectMembers).where(eq(projectMembers.id, memberId));
    return c.newResponse(null, 204);
  });
