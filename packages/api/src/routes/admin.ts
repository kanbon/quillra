import { createHash, randomBytes } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { instanceInvites, projectGroups, projectMembers, projects } from "../db/app-schema.js";
import { user } from "../db/auth-schema.js";
import { db, rawSqlite } from "../db/index.js";
import type { SessionUser } from "../lib/auth.js";
import { inviteEmailHtml } from "../services/email-templates.js";
import {
  clearGithubAppCredentials,
  listInstallations as listGithubAppInstallations,
} from "../services/github-app.js";
import {
  getInstanceSetting,
  getOrganizationInfo,
  setInstanceSetting,
} from "../services/instance-settings.js";
import { isMailerEnabled, sendEmail } from "../services/mailer.js";
import { reconcileMonthlyReports } from "../services/report-scheduler.js";
import {
  ROLE_NAMES,
  type RoleName,
  listRolePrompts,
  resetRolePrompt,
  setRolePrompt,
} from "../services/role-prompts.js";
import { getOwnerEmail, listUsageLimitRows, upsertUsageLimit } from "../services/usage-limits.js";

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
    // token to accept, the email-code login flow looks up the email
    // against instanceInvites automatically. Email is purely a nudge.
    let emailed = false;
    if (isMailerEnabled()) {
      try {
        const org = getOrganizationInfo();
        const base =
          (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "") || "https://cms.kanbon.at";
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
          text: `${r.user.name ?? r.user.email ?? "Someone"} invited you to ${org.instanceName}. Sign in at ${loginUrl} with your email, no GitHub account required.`,
          headers: {
            "List-Unsubscribe": `<${base}/login>, <mailto:noreply@quillra.com?subject=Unsubscribe>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
        emailed = result.sent;
      } catch {
        /* best-effort */
      }
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
   * address. The recipient is taken from the session, never from the
   * request body, so this can't be used as an open spam relay.
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
        '<p style="color:#888;font-size:12px;">Sent from the Organization Settings → Email tab.</p>',
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
      return c.json({ installations: [], error: e instanceof Error ? e.message : "Failed" }, 500);
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
   * json_each to flatten the JSON blob, drizzle doesn't have a
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
             COALESCE(u.monthly_usage_reports_enabled, 0) as reports_enabled,
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
  })

  /**
   * Per-user drill-down for the Usage tab. Returns a 12-month (or
   * custom-length) breakdown + per-project + per-model splits for a
   * single user. All aggregation is client-agnostic: the same SQL shape
   * works whether the caller wants a chart or a CSV export.
   */
  .get("/usage/users/:userId", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const userId = c.req.param("userId");
    const monthsRaw = Number(c.req.query("months") ?? 12);
    const months = Number.isFinite(monthsRaw)
      ? Math.max(1, Math.min(36, Math.floor(monthsRaw)))
      : 12;
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1).getTime();

    const [u] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
    if (!u) return c.json({ error: "User not found" }, 404);

    type AggRow = Record<string, number | string | null>;

    const monthly = rawSqlite
      .prepare(
        `SELECT
           strftime('%Y-%m', created_at / 1000, 'unixepoch') AS month,
           COUNT(*) AS runs,
           COALESCE(SUM(CAST(cost_usd AS REAL)), 0) AS cost_usd,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM agent_runs
         WHERE user_id = ? AND created_at >= ?
         GROUP BY month
         ORDER BY month ASC`,
      )
      .all(userId, from) as AggRow[];

    const perProject = rawSqlite
      .prepare(
        `SELECT
           ar.project_id AS project_id,
           COALESCE(p.name, '(deleted project)') AS project_name,
           COUNT(*) AS runs,
           COALESCE(SUM(CAST(ar.cost_usd AS REAL)), 0) AS cost_usd
         FROM agent_runs ar
         LEFT JOIN projects p ON p.id = ar.project_id
         WHERE ar.user_id = ? AND ar.created_at >= ?
         GROUP BY ar.project_id
         ORDER BY cost_usd DESC`,
      )
      .all(userId, from) as AggRow[];

    const perModel = rawSqlite
      .prepare(
        `SELECT
           je.key AS model,
           COALESCE(SUM(CAST(json_extract(je.value, '$.costUSD') AS REAL)), 0) AS cost_usd,
           COUNT(DISTINCT ar.id) AS runs,
           COALESCE(SUM(CAST(json_extract(je.value, '$.inputTokens') AS INTEGER)), 0) AS input_tokens,
           COALESCE(SUM(CAST(json_extract(je.value, '$.outputTokens') AS INTEGER)), 0) AS output_tokens
         FROM agent_runs ar,
              json_each(COALESCE(ar.model_usage_json, '{}')) AS je
         WHERE ar.user_id = ? AND ar.created_at >= ?
         GROUP BY je.key
         ORDER BY cost_usd DESC`,
      )
      .all(userId, from) as AggRow[];

    const totals = rawSqlite
      .prepare(
        `SELECT
           COUNT(*) AS runs,
           COALESCE(SUM(CAST(cost_usd AS REAL)), 0) AS cost_usd,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM agent_runs
         WHERE user_id = ? AND created_at >= ?`,
      )
      .get(userId, from) as AggRow;

    return c.json({
      user: { id: u.id, displayName: u.name || u.email, email: u.email },
      since: from,
      months,
      monthly,
      perProject,
      perModel,
      totals,
    });
  })

  /**
   * Read the current usage-limit configuration: raw rows from
   * usage_limits plus the effective alert recipient email (falls back
   * to the org owner's address).
   */
  .get("/usage/limits", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const rows = await listUsageLimitRows();
    const alertEmail = getInstanceSetting("USAGE_ALERT_EMAIL") ?? "";
    const fallbackEmail = (await getOwnerEmail()) ?? "";
    return c.json({ rows, alertEmail, fallbackEmail });
  })

  /**
   * Bulk-replace the usage-limit configuration. Accepts a flat list of
   * rows and upserts them one by one, a row with both warn and hard
   * null is treated as a delete. Also updates the alert-email instance
   * setting in the same call so the UI can save everything with a
   * single request.
   */
  .post("/usage/limits", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null);
    const schema = z.object({
      alertEmail: z.string().email().or(z.literal("")).optional(),
      rows: z
        .array(
          z.object({
            scope: z.enum(["global", "role", "user"]),
            target: z.string().default(""),
            warnUsd: z.number().nonnegative().nullable(),
            hardUsd: z.number().nonnegative().nullable(),
          }),
        )
        .default([]),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    for (const row of parsed.data.rows) {
      await upsertUsageLimit(row.scope, row.target, row.warnUsd, row.hardUsd);
    }
    if (parsed.data.alertEmail !== undefined) {
      setInstanceSetting("USAGE_ALERT_EMAIL", parsed.data.alertEmail);
    }
    return c.json({ ok: true });
  })

  /**
   * Per-user preferences, currently just the "send me a monthly usage
   * report" opt-in, but the endpoint is shaped so additional user-level
   * toggles can land here without another route.
   */
  .patch("/users/:userId/preferences", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const userId = c.req.param("userId");
    const body = await c.req.json().catch(() => null);
    const schema = z.object({
      monthlyUsageReportsEnabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const patch: Record<string, unknown> = {};
    if (parsed.data.monthlyUsageReportsEnabled !== undefined) {
      patch.monthlyUsageReportsEnabled = parsed.data.monthlyUsageReportsEnabled;
    }
    if (Object.keys(patch).length === 0) return c.json({ ok: true });
    await db.update(user).set(patch).where(eq(user.id, userId));
    return c.json({ ok: true });
  })

  /**
   * Manual trigger for the monthly-report reconciler. Same entry point
   * the cron uses; useful for dev testing and a one-click "send it now"
   * button if the operator is debugging their report flow.
   */
  .post("/reports/reconcile", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const result = await reconcileMonthlyReports();
    return c.json(result);
  })

  /**
   * List every role's effective permission prompt. Used by the Instance
   * Settings "Permissions" tab. Returns the built-in default alongside
   * the current value so the UI can render a "Reset to default" control.
   */
  .get("/role-prompts", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const rows = await listRolePrompts();
    return c.json({ roles: rows });
  })

  /**
   * Replace the stored prompt for one role. Empty values are rejected;
   * reset-to-default goes through DELETE instead.
   */
  .put("/role-prompts/:role", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const role = c.req.param("role") as RoleName;
    if (!(ROLE_NAMES as readonly string[]).includes(role)) {
      return c.json({ error: "Unknown role" }, 400);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ prompt: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await setRolePrompt(role, parsed.data.prompt);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Save failed" }, 400);
    }
  })

  /**
   * Drop the stored row for one role so the built-in default takes over
   * on the next chat turn. Idempotent: returns the default either way.
   */
  .delete("/role-prompts/:role", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const role = c.req.param("role") as RoleName;
    if (!(ROLE_NAMES as readonly string[]).includes(role)) {
      return c.json({ error: "Unknown role" }, 400);
    }
    const defaultPrompt = await resetRolePrompt(role);
    return c.json({ ok: true, prompt: defaultPrompt });
  })

  /**
   * Project groups (white-label container). The same Quillra instance
   * can host multiple agencies, each with its own brand and project
   * subset. Owner-only because misuse here would let anyone rename or
   * detach a peer agency's projects.
   */
  .get("/groups", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const rows = await db.select().from(projectGroups).orderBy(projectGroups.name);
    // For each group, count how many projects reference it. Cheap with
    // the small project counts we expect on a single instance.
    const projectCountByGroup = new Map<string, number>();
    const all = await db.select({ id: projects.id, groupId: projects.groupId }).from(projects);
    for (const p of all) {
      if (!p.groupId) continue;
      projectCountByGroup.set(p.groupId, (projectCountByGroup.get(p.groupId) ?? 0) + 1);
    }
    return c.json({
      groups: rows.map((g) => ({
        ...g,
        projectCount: projectCountByGroup.get(g.id) ?? 0,
      })),
    });
  })

  .post("/groups", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null);
    const schema = z.object({
      name: z.string().min(1).max(120),
      slug: z
        .string()
        .min(2)
        .max(40)
        .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, digits, and hyphens"),
      brandLogoUrl: z.string().url().optional().nullable(),
      brandAccentColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Hex color like #C1121F")
        .optional()
        .nullable(),
      brandDisplayName: z.string().max(120).optional().nullable(),
      brandTagline: z.string().max(200).optional().nullable(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const id = nanoid();
      await db.insert(projectGroups).values({
        id,
        name: parsed.data.name.trim(),
        slug: parsed.data.slug.trim(),
        brandLogoUrl: parsed.data.brandLogoUrl?.trim() || null,
        brandAccentColor: parsed.data.brandAccentColor?.trim() || null,
        brandDisplayName: parsed.data.brandDisplayName?.trim() || null,
        brandTagline: parsed.data.brandTagline?.trim() || null,
      });
      return c.json({ id, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Create failed";
      // SQLite UNIQUE on slug => surface a friendly error.
      if (msg.toLowerCase().includes("unique")) {
        return c.json({ error: "A group with that slug already exists." }, 409);
      }
      return c.json({ error: msg }, 500);
    }
  })

  .put("/groups/:id", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const schema = z
      .object({
        name: z.string().min(1).max(120).optional(),
        slug: z
          .string()
          .min(2)
          .max(40)
          .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
          .optional(),
        brandLogoUrl: z.string().url().nullable().optional(),
        brandAccentColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable()
          .optional(),
        brandDisplayName: z.string().max(120).nullable().optional(),
        brandTagline: z.string().max(200).nullable().optional(),
      })
      .strict();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      // Trim strings; pass through nulls so the operator can clear a field.
      if (typeof v === "string") patch[k] = v.trim();
      else patch[k] = v;
    }
    if (Object.keys(patch).length === 0) return c.json({ ok: true });
    try {
      await db.update(projectGroups).set(patch).where(eq(projectGroups.id, id));
      return c.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      if (msg.toLowerCase().includes("unique")) {
        return c.json({ error: "A group with that slug already exists." }, 409);
      }
      return c.json({ error: msg }, 500);
    }
  })

  .delete("/groups/:id", async (c) => {
    const r = await requireOwner(c);
    if ("error" in r) return r.error;
    const id = c.req.param("id");
    // The FK on projects.groupId is ON DELETE SET NULL, so projects
    // detach automatically and inherit instance defaults.
    await db.delete(projectGroups).where(eq(projectGroups.id, id));
    return c.json({ ok: true });
  });
