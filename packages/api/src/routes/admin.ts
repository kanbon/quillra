import { eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { instanceInvites, projectMembers, projects } from "../db/app-schema.js";
import type { SessionUser } from "../lib/auth.js";
import { sendEmail, isMailerEnabled } from "../services/mailer.js";
import { inviteEmailHtml } from "../services/email-templates.js";
import { getOrganizationInfo } from "../services/instance-settings.js";
import { listInstallations as listGithubAppInstallations } from "../services/github-app.js";

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

    // 1) Fetch every user on the instance
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

    // 2) Fetch every project membership + project name in a single join
    //    so we can group by userId without N+1 queries.
    const memberships = await db
      .select({
        userId: projectMembers.userId,
        projectId: projects.id,
        projectName: projects.name,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId));

    // 3) Index by userId
    type ProjectBadge = { id: string; name: string; role: string };
    const byUser = new Map<string, ProjectBadge[]>();
    for (const m of memberships) {
      const arr = byUser.get(m.userId) ?? [];
      arr.push({ id: m.projectId, name: m.projectName, role: m.role });
      byUser.set(m.userId, arr);
    }

    return c.json({
      members: members.map((m) => ({
        ...m,
        projects: (byUser.get(m.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      })),
    });
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

    // Fire-and-forget invite email. The invited user doesn't need the
    // token to accept — the email-code login flow looks up the email
    // against instanceInvites automatically. Email is purely a nudge.
    let emailed = false;
    if (isMailerEnabled()) {
      try {
        const org = getOrganizationInfo();
        const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "") || "https://cms.kanbon.at";
        const loginUrl = `${base}/login?email=${encodeURIComponent(parsed.data.email)}`;
        const html = inviteEmailHtml({
          projectName: org.instanceName,
          projectLogoUrl: null,
          inviterName: r.user.name ?? r.user.email ?? null,
          role: "admin",
          acceptUrl: loginUrl,
        });
        const result = await sendEmail({
          to: parsed.data.email,
          subject: `You're invited to ${org.instanceName}`,
          html,
          text: `${r.user.name ?? r.user.email ?? "Someone"} invited you to ${org.instanceName}. Sign in at ${loginUrl} with your email — no GitHub account required.`,
          headers: {
            "List-Unsubscribe": `<${base}/login>, <mailto:noreply@quillra.com?subject=Unsubscribe>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
        emailed = result.sent;
      } catch { /* best-effort */ }
    }

    return c.json({ ok: true, email: parsed.data.email, emailed });
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
  })
  /**
   * Owner-only: send a test email to the SIGNED-IN owner's own email
   * address. The recipient is taken from the session — never from the
   * request body — so this can't be used as an open spam relay.
   * Useful for verifying SMTP / Resend config immediately after saving.
   */
  .post("/test-email", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const email = r.user.email;
    if (!email) {
      return c.json({ ok: false, reason: "No email on account" }, 400);
    }
    const result = await sendEmail({
      to: email,
      subject: "Quillra test email",
      text: "If you received this, your Quillra email configuration is working correctly.",
      html:
        "<p>If you received this, your Quillra email configuration is working correctly.</p>" +
        "<p style=\"color:#888;font-size:12px;\">Sent from the Organization Settings → Email tab.</p>",
    });
    if (result.sent) {
      return c.json({ ok: true, backend: result.backend });
    }
    return c.json({ ok: false, backend: result.backend, reason: result.reason });
  })
  /**
   * Owner-only: list the GitHub App's installations. Renders in the
   * Integrations tab as "which GitHub accounts/orgs have granted the App
   * access to which repos". Returns an empty array if the App isn't
   * configured yet.
   */
  .get("/github-app/installations", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    try {
      const installations = await listGithubAppInstallations();
      return c.json({ installations });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Failed" },
        500,
      );
    }
  });
