import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { ProjectRole } from "../db/app-schema.js";
import { user } from "../db/auth-schema.js";
import { db } from "../db/index.js";
import { projectInvites, projectMembers, projects } from "../db/schema.js";
import type { SessionUser } from "../lib/auth.js";
import { emailEquals, normalizeEmail } from "../lib/email.js";
import { acceptProjectInviteToken } from "../lib/project-invites.js";
import { getProjectBrand, projectBrandForEmail } from "../services/branding.js";
import { renderInviteEmail } from "../services/email-templates.js";
import { isMailerEnabled, sendEmail } from "../services/mailer.js";
import { revokePreviewCapability } from "../services/preview-capability.js";

type Variables = {
  user: SessionUser | null;
  clientSession: { projectId: string } | null;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function requireUser(c: Context<{ Variables: Variables }>) {
  const user = c.get("user");
  if (!user) return { error: c.json({ error: "Unauthorized" }, 401) };
  if (c.get("clientSession")) return { error: c.json({ error: "Forbidden" }, 403) };
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
    if (any.role === "client") return c.json({ error: "Forbidden" }, 403);

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
      email: z.string().trim().email(),
      role: z.enum(["admin", "editor", "client"]).default("editor"),
      name: z.string().trim().min(1).max(120).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const inviteEmail = normalizeEmail(parsed.data.email);
    const role = parsed.data.role as ProjectRole;

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const token = randomBytes(24).toString("hex");
    const now = new Date();
    const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14);

    // An invitation is not authorization. The recipient gets a user, role,
    // and project membership only after proving control of the invited email
    // through the team or client OTP flow.
    const base = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const matchingUsers = await db.select().from(user).where(emailEquals(user.email, inviteEmail));
    for (const existingUser of matchingUsers) {
      const [memberRow] = await db
        .select()
        .from(projectMembers)
        .where(
          and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, existingUser.id)),
        )
        .limit(1);
      if (memberRow) {
        return c.json({ error: `User is already a ${memberRow.role} on this project` }, 409);
      }
    }

    const matchingInvites = await db
      .select()
      .from(projectInvites)
      .where(
        and(
          eq(projectInvites.projectId, projectId),
          emailEquals(projectInvites.email, inviteEmail),
          isNull(projectInvites.acceptedAt),
        ),
      );
    const existingInvite = matchingInvites[0];
    if (existingInvite) {
      await db
        .update(projectInvites)
        .set({
          email: inviteEmail,
          name: parsed.data.name ?? null,
          role,
          tokenHash: hashToken(token),
          invitedByUserId: r.user.id,
          expiresAt: expires,
        })
        .where(eq(projectInvites.id, existingInvite.id));
      for (const duplicate of matchingInvites.slice(1)) {
        await db.delete(projectInvites).where(eq(projectInvites.id, duplicate.id));
      }
    } else {
      await db.insert(projectInvites).values({
        id: nanoid(),
        projectId,
        email: inviteEmail,
        name: parsed.data.name ?? null,
        role,
        tokenHash: hashToken(token),
        invitedByUserId: r.user.id,
        expiresAt: expires,
      });
    }
    const acceptUrl =
      role === "client"
        ? `${base}/c/${projectId}?email=${encodeURIComponent(inviteEmail)}`
        : `${base}/login?email=${encodeURIComponent(inviteEmail)}`;

    // Try to send the email; gracefully fall back to copy-link mode
    const emailConfigured = isMailerEnabled();
    let emailSent = false;
    let emailError: string | null = null;
    if (emailConfigured) {
      const resolvedBrand = await getProjectBrand(projectId, new URL(c.req.url).host || null);
      const brand = projectBrandForEmail(resolvedBrand, projectId, base);
      const email = renderInviteEmail({
        brand,
        inviterName: r.user.name ?? r.user.email ?? null,
        role,
        acceptUrl,
      });
      // Replies go straight to the admin who invited the recipient.
      const replyTo = r.user.email ?? undefined;

      const result = await sendEmail({
        to: inviteEmail,
        subject: `${r.user.name ?? "Someone"} invited you to ${brand.displayName}`,
        html: email.html,
        text: email.text,
        replyTo,
      });
      emailSent = result.sent;
      if (!result.sent) emailError = result.reason;
    }

    return c.json({
      inviteLink: acceptUrl,
      token: role === "client" ? null : token,
      emailConfigured,
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

    const email = normalizeEmail(r.user.email ?? "");
    if (!email) return c.json({ error: "Your GitHub account has no verified email" }, 400);

    const tokenHash = hashToken(parsed.data.token);
    const [inv] = await db
      .select()
      .from(projectInvites)
      .where(eq(projectInvites.tokenHash, tokenHash))
      .limit(1);
    if (!inv || inv.acceptedAt) return c.json({ error: "Invalid or used invite" }, 400);
    if (inv.expiresAt.getTime() < Date.now()) return c.json({ error: "Invite expired" }, 400);
    if (normalizeEmail(inv.email) !== email) {
      return c.json({ error: "Signed-in email does not match invite" }, 403);
    }

    const accepted = acceptProjectInviteToken(tokenHash, email, r.user.id);
    if (!accepted) return c.json({ error: "Invalid, used, or expired invite" }, 400);
    return c.json(accepted);
  })
  .patch("/projects/:projectId/members/:memberId", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("projectId");
    const memberId = c.req.param("memberId");
    const admin = await requireProjectAdmin(r.user.id, projectId);
    if (!admin) return c.json({ error: "Forbidden" }, 403);

    const body = await c.req.json().catch(() => null);
    const schema = z.object({ role: z.enum(["admin", "editor", "client"]) });
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

    const deleted = await db
      .delete(projectMembers)
      .where(eq(projectMembers.id, memberId))
      .returning({ id: projectMembers.id });
    if (deleted.length > 0) revokePreviewCapability(projectId);
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
      .where(
        and(
          eq(projectInvites.projectId, projectId),
          isNull(projectInvites.acceptedAt),
          gt(projectInvites.expiresAt, new Date()),
        ),
      );
    const pending = rows.map((r) => ({
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
