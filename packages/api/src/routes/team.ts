import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../db/index.js";
import { projectInvites, projectMembers, projects } from "../db/schema.js";
import { user } from "../db/auth-schema.js";
import type { SessionUser } from "../lib/auth.js";
import type { ProjectRole } from "../db/app-schema.js";
import { sendEmail, isMailerEnabled } from "../services/mailer.js";
import { inviteEmailHtml } from "../services/email-templates.js";

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

    const rows = await db
      .select({
        id: projectMembers.id,
        userId: projectMembers.userId,
        role: projectMembers.role,
        createdAt: projectMembers.createdAt,
        email: user.email,
        name: user.name,
        image: user.image,
      })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId));

    return c.json({
      members: rows.map((m) => ({
        ...m,
        createdAt: m.createdAt.getTime(),
      })),
    });
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
      role: z.enum(["admin", "editor", "translator", "client"]).default("editor"),
      name: z.string().min(1).max(120).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const inviteEmail = parsed.data.email.toLowerCase();
    const role = parsed.data.role as ProjectRole;

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const token = randomBytes(24).toString("hex");
    const now = new Date();
    const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14);

    // For client invites: pre-create the user + membership now so the
    // recipient can log in via the branded code flow without needing a
    // separate "accept" step. For admin/editor/translator we keep the
    // existing GitHub-sign-in-then-accept flow.
    let acceptUrl: string;
    const base = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
    if (role === "client") {
      let [existingUser] = await db.select().from(user).where(eq(user.email, inviteEmail)).limit(1);
      if (!existingUser) {
        const newId = nanoid();
        await db.insert(user).values({
          id: newId,
          email: inviteEmail,
          name: parsed.data.name ?? inviteEmail,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        });
        [existingUser] = await db.select().from(user).where(eq(user.id, newId)).limit(1);
      }
      if (existingUser) {
        const [memberRow] = await db
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, existingUser.id)))
          .limit(1);
        if (!memberRow) {
          await db.insert(projectMembers).values({
            id: nanoid(),
            projectId,
            userId: existingUser.id,
            role,
            invitedByUserId: r.user.id,
            createdAt: now,
          });
        } else if (memberRow.role !== "client") {
          // already a non-client member of this project — refuse to overwrite
          return c.json({ error: "User already has a non-client role on this project" }, 409);
        }
      }
      acceptUrl = `${base}/c/${projectId}`;
    } else {
      // Collaborator-style invites still use the token-based accept flow
      await db.insert(projectInvites).values({
        id: nanoid(),
        projectId,
        email: inviteEmail,
        role,
        tokenHash: hashToken(token),
        invitedByUserId: r.user.id,
        expiresAt: expires,
      });
      acceptUrl = `${base}/accept-invite?token=${token}`;
    }

    // Try to send the email; gracefully fall back to copy-link mode
    let emailSent = false;
    let emailError: string | null = null;
    if (isMailerEnabled()) {
      const html = inviteEmailHtml({
        projectName: project.name,
        projectLogoUrl: project.logoUrl,
        inviterName: r.user.name ?? r.user.email ?? null,
        role,
        acceptUrl,
      });
      const result = await sendEmail({
        to: inviteEmail,
        subject: `You're invited to ${project.name}`,
        html,
        text: `${r.user.name ?? "Someone"} invited you to ${project.name}. Open this link to accept: ${acceptUrl}`,
      });
      emailSent = result.sent;
      if (!result.sent) emailError = result.reason;
    }

    return c.json({
      inviteLink: acceptUrl,
      token: role === "client" ? null : token,
      emailSent,
      emailError,
      role,
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
    const schema = z.object({ role: z.enum(["admin", "editor", "translator", "client"]) });
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
  })
  /** List pending (not-yet-accepted) invites for a project */
  .get("/projects/:projectId/invites", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("projectId");
    const admin = await requireProjectAdmin(r.user.id, projectId);
    if (!admin) return c.json({ error: "Forbidden" }, 403);
    const rows = await db
      .select()
      .from(projectInvites)
      .where(eq(projectInvites.projectId, projectId));
    const pending = rows
      .filter((r) => r.acceptedAt === null)
      .map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        expiresAt: r.expiresAt.getTime(),
      }));
    return c.json({ invites: pending });
  })
  /** Revoke a pending invite */
  .delete("/projects/:projectId/invites/:inviteId", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("projectId");
    const inviteId = c.req.param("inviteId");
    const admin = await requireProjectAdmin(r.user.id, projectId);
    if (!admin) return c.json({ error: "Forbidden" }, 403);
    await db
      .delete(projectInvites)
      .where(and(eq(projectInvites.id, inviteId), eq(projectInvites.projectId, projectId)));
    return c.newResponse(null, 204);
  });
