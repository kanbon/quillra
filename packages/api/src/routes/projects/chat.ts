import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { user } from "../../db/auth-schema.js";
import { db, rawSqlite } from "../../db/index.js";
import { conversations, messages } from "../../db/schema.js";
import { type Variables, memberForProject, requireUser } from "./shared.js";

export const chatRouter = new Hono<{ Variables: Variables }>()
  .get("/:id/conversations", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);

    // Visibility rules:
    //   - clients only see their own conversations
    //   - admins / editors / translators see every conversation in the
    //     project, with an optional ?userId=... filter for the UI's
    //     "show only this person" dropdown
    const filterUserId = c.req.query("userId");
    const whereExpr =
      m.role === "client"
        ? and(eq(conversations.projectId, projectId), eq(conversations.createdByUserId, r.user.id))
        : filterUserId
          ? and(
              eq(conversations.projectId, projectId),
              eq(conversations.createdByUserId, filterUserId),
            )
          : eq(conversations.projectId, projectId);

    const rows = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
        createdByUserId: conversations.createdByUserId,
      })
      .from(conversations)
      .where(whereExpr)
      .orderBy(desc(conversations.updatedAt))
      .limit(100);

    // Enrich with the creator's name/email so the UI can show who wrote
    // each chat without a second round-trip. Only do the join for non-
    // client roles, clients already know it's all themselves.
    type Author = { id: string; name: string; email: string; image: string | null };
    const authors = new Map<string, Author>();
    if (m.role !== "client") {
      const uniqueUserIds = Array.from(
        new Set(rows.map((r) => r.createdByUserId).filter((v): v is string => !!v)),
      );
      if (uniqueUserIds.length > 0) {
        const users = await db
          .select({ id: user.id, name: user.name, email: user.email, image: user.image })
          .from(user);
        for (const u of users) {
          if (uniqueUserIds.includes(u.id)) authors.set(u.id, u);
        }
      }
    }

    return c.json({
      viewerRole: m.role,
      canSeeAll: m.role !== "client",
      conversations: rows.map((x) => ({
        id: x.id,
        title: x.title,
        updatedAt: x.updatedAt.getTime(),
        createdByUserId: x.createdByUserId,
        author: x.createdByUserId ? (authors.get(x.createdByUserId) ?? null) : null,
      })),
    });
  })
  .get("/:id/messages", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const conversationId = c.req.query("conversationId");
    const where = conversationId
      ? and(eq(messages.projectId, projectId), eq(messages.conversationId, conversationId))
      : eq(messages.projectId, projectId);
    const rows = await db
      .select()
      .from(messages)
      .where(where)
      .orderBy(desc(messages.id))
      .limit(100);
    return c.json({
      messages: rows.reverse().map((x) => {
        let attachments: { path: string; originalName: string }[] | undefined;
        if (x.attachments) {
          try {
            attachments = JSON.parse(x.attachments);
          } catch {
            /* ignore */
          }
        }
        return {
          id: x.id,
          role: x.role,
          content: x.content,
          conversationId: x.conversationId,
          createdAt: x.createdAt.getTime(),
          attachments,
        };
      }),
    });
  })
  /**
   * Running cost total for a single conversation. Used to seed the
   * "this chat" counter on the cost checkpoint card so reloads don't
   * reset it to zero. Sums the `cost_usd` column of agent_runs for the
   * given conversation only, same CAST pattern as the Usage tab
   * aggregation.
   */
  .get("/:id/conversations/:convId/cost-total", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const convId = c.req.param("convId");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    // Client-role members only see their own conversation totals, but
    // the agent_runs rows are always tied to the conversation that
    // produced them, so scoping by convId is sufficient as long as
    // the conversation itself belongs to the project.
    const [conv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, convId), eq(conversations.projectId, projectId)))
      .limit(1);
    if (!conv) return c.json({ error: "Not found" }, 404);
    const row = rawSqlite
      .prepare(
        `SELECT COALESCE(SUM(CAST(cost_usd AS REAL)), 0) as total
           FROM agent_runs
           WHERE conversation_id = ? AND project_id = ?`,
      )
      .get(convId, projectId) as { total: number } | undefined;
    return c.json({ totalCostUsd: row?.total ?? 0 });
  });
