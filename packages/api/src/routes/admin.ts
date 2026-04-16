import { eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db, rawSqlite } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { instanceInvites, projectMembers, projects } from "../db/app-schema.js";
import type { SessionUser } from "../lib/auth.js";
import { sendEmail, isMailerEnabled } from "../services/mailer.js";
import { inviteEmailHtml } from "../services/email-templates.js";
import { getOrganizationInfo } from "../services/instance-settings.js";
import {
  listInstallations as listGithubAppInstallations,
  clearGithubAppCredentials,
} from "../services/github-app.js";

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
   * configured yet. If the App was deleted on github.com, auto-clears
   * the stored credentials and signals the frontend via `cleared`.
   */
  .get("/github-app/installations", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    try {
      const result = await listGithubAppInstallations();
      return c.json(result);
    } catch (e) {
      return c.json(
        { installations: [], error: e instanceof Error ? e.message : "Failed" },
        500,
      );
    }
  })
  /**
   * Owner-only: explicitly reset the GitHub App credentials. Used by
   * the "Reset" button in the Integrations tab when the owner deleted
   * the App on github.com and wants to start over, or just wants to
   * switch to a different App.
   */
  .delete("/github-app", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    clearGithubAppCredentials();
    return c.json({ ok: true });
  })
  /**
   * Owner-only: cost + token breakdown for the Organization Settings →
   * Usage tab. Aggregates the `agent_runs` table (one row per
   * successful agent invocation) across a configurable date range:
   *
   *   ?range=7d  | 30d | 90d | all   (default 30d)
   *
   * Returns totals + grouped arrays:
   *   - totals: overall cost, tokens, run count
   *   - perProject: one row per project with its slice of the above
   *   - perUser: one row per user (name/email) with their slice
   *   - perModel: one row per distinct model pulled from model_usage_json
   *
   * Uses raw SQL because the per-model aggregation needs sqlite's
   * json_each to flatten the JSON blob — drizzle doesn't have a
   * clean ergonomic wrapper for that.
   */
  .get("/usage", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;

    const range = (c.req.query("range") ?? "30d").toLowerCase();
    const cutoffMs = (() => {
      if (range === "7d") return Date.now() - 7 * 24 * 60 * 60 * 1000;
      if (range === "90d") return Date.now() - 90 * 24 * 60 * 60 * 1000;
      if (range === "all") return 0;
      return Date.now() - 30 * 24 * 60 * 60 * 1000; // default 30d
    })();

    type Row = Record<string, number | string | null>;
    try {
      const totals = rawSqlite
        .prepare(
          `SELECT
             COUNT(*) as runs,
             COALESCE(SUM(CAST(cost_usd AS REAL)), 0) as cost_usd,
             COALESCE(SUM(input_tokens), 0) as input_tokens,
             COALESCE(SUM(output_tokens), 0) as output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens
           FROM agent_runs
           WHERE created_at >= ?`,
        )
        .get(cutoffMs) as Row;

      const perProject = rawSqlite
        .prepare(
          `SELECT
             ar.project_id as project_id,
             COALESCE(p.name, '(deleted project)') as project_name,
             COUNT(*) as runs,
             COALESCE(SUM(CAST(ar.cost_usd AS REAL)), 0) as cost_usd,
             COALESCE(SUM(ar.input_tokens + ar.output_tokens + ar.cache_read_tokens + ar.cache_creation_tokens), 0) as total_tokens
           FROM agent_runs ar
           LEFT JOIN projects p ON p.id = ar.project_id
           WHERE ar.created_at >= ?
           GROUP BY ar.project_id
           ORDER BY cost_usd DESC`,
        )
        .all(cutoffMs) as Row[];

      const perUser = rawSqlite
        .prepare(
          `SELECT
             ar.user_id as user_id,
             COALESCE(u.name, u.email, '(unknown)') as display_name,
             COALESCE(u.email, '') as email,
             COUNT(*) as runs,
             COALESCE(SUM(CAST(ar.cost_usd AS REAL)), 0) as cost_usd,
             COALESCE(SUM(ar.input_tokens + ar.output_tokens + ar.cache_read_tokens + ar.cache_creation_tokens), 0) as total_tokens
           FROM agent_runs ar
           LEFT JOIN user u ON u.id = ar.user_id
           WHERE ar.created_at >= ?
           GROUP BY ar.user_id
           ORDER BY cost_usd DESC`,
        )
        .all(cutoffMs) as Row[];

      const perModel = rawSqlite
        .prepare(
          `SELECT
             je.key as model,
             COUNT(*) as runs,
             COALESCE(SUM(CAST(json_extract(je.value, '$.costUSD') AS REAL)), 0) as cost_usd,
             COALESCE(SUM(COALESCE(json_extract(je.value, '$.inputTokens'), 0)), 0) as input_tokens,
             COALESCE(SUM(COALESCE(json_extract(je.value, '$.outputTokens'), 0)), 0) as output_tokens,
             COALESCE(SUM(COALESCE(json_extract(je.value, '$.cacheReadInputTokens'), 0)), 0) as cache_read_tokens,
             COALESCE(SUM(COALESCE(json_extract(je.value, '$.cacheCreationInputTokens'), 0)), 0) as cache_creation_tokens
           FROM agent_runs ar,
                json_each(ar.model_usage_json) je
           WHERE ar.created_at >= ?
             AND ar.model_usage_json IS NOT NULL
           GROUP BY je.key
           ORDER BY cost_usd DESC`,
        )
        .all(cutoffMs) as Row[];

      return c.json({
        range,
        since: cutoffMs,
        totals,
        perProject,
        perUser,
        perModel,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Usage query failed" }, 500);
    }
  });
