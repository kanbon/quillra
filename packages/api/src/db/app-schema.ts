import { relations, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema.js";

export const projectRoleValues = ["admin", "editor", "client"] as const;
export type ProjectRole = (typeof projectRoleValues)[number];

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  githubRepoFullName: text("github_repo_full_name").notNull(),
  githubInstallationId: text("github_installation_id"),
  defaultBranch: text("default_branch").notNull().default("main"),
  /** Shell command for dev preview; use `{port}` or `$PORT`. Empty = auto-detect from package.json */
  previewDevCommand: text("preview_dev_command"),
  /** Optional URL of a logo shown on the branded client login page */
  logoUrl: text("logo_url"),
  /**
   * Set to "astro" while the migration agent is actively rewriting
   * the project to Astro. Server clears this to NULL when the agent
   * emits `done`. While it's set, the Editor locks the composer and
   * hides the preview column; the server also gives the agent
   * unrestricted tool permissions.
   */
  migrationTarget: text("migration_target"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
});

/** Custom session for client-role users authenticated via email code (no GitHub) */
export const clientSessions = sqliteTable(
  "client_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    projectId: text("project_id").notNull(),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("client_sessions_token_idx").on(table.token)],
);

/** One-time email codes used by the branded client login flow */
export const clientLoginCodes = sqliteTable(
  "client_login_codes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("client_login_codes_project_email_idx").on(table.projectId, table.email)],
);

/**
 * Team sessions — email-code login for admins / editors / translators who
 * don't want (or don't have) a GitHub account. Unlike clientSessions these
 * are NOT project-scoped: a team member can access every project they're
 * a member of via projectMembers, identical to a Better Auth session.
 */
export const teamSessions = sqliteTable(
  "team_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("team_sessions_token_idx").on(table.token)],
);

/** One-time email codes used by the team email-code login flow */
export const teamLoginCodes = sqliteTable(
  "team_login_codes",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("team_login_codes_email_idx").on(table.email)],
);

export const projectMembers = sqliteTable(
  "project_members",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().$type<ProjectRole>(),
    invitedByUserId: text("invited_by_user_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("project_members_project_idx").on(table.projectId),
    index("project_members_user_idx").on(table.userId),
  ],
);

export const projectInvites = sqliteTable("project_invites", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().$type<ProjectRole>(),
  tokenHash: text("token_hash").notNull(),
  invitedByUserId: text("invited_by_user_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
});

export const instanceInvites = sqliteTable("instance_invites", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  invitedByUserId: text("invited_by_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
});

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * The user who started the conversation. Drives visibility rules:
     * clients see only their own conversations, admins/editors see every
     * member's conversations (with a user filter in the UI).
     */
    createdByUserId: text("created_by_user_id"),
    title: text("title"),
    agentSessionId: text("agent_session_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("conversations_project_idx").on(table.projectId)],
);

/**
 * One row per Claude Agent SDK run — an agent "turn" triggered by a
 * single user message. Used by the owner-only Usage tab to break down
 * cost/tokens by project, user, and model. The model_usage_json column
 * stores the SDK's per-model detail as a JSON blob so we don't need a
 * separate table for the (model, run) cross-product.
 */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id"),
    /** Null when the run was attributed to "Quillra itself" (system
     *  triggers, future background tasks). Normally the signed-in user. */
    userId: text("user_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    costUsd: text("cost_usd").notNull().default("0"),
    numTurns: integer("num_turns").notNull().default(1),
    /** JSON: { [modelName]: { inputTokens, outputTokens, cacheReadInputTokens,
     *  cacheCreationInputTokens, costUSD, ... } } — what the SDK's
     *  modelUsage map gave us verbatim. Read with json_each() for
     *  per-model aggregation without a second table. */
    modelUsageJson: text("model_usage_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("agent_runs_project_idx").on(table.projectId),
    index("agent_runs_user_idx").on(table.userId),
    index("agent_runs_created_idx").on(table.createdAt),
  ],
);

/**
 * Warn/hard usage caps scoped at three levels. `scope` decides how to
 * interpret `target`: "" for global, a project role name for "role",
 * or a user id for "user". The enforcement path walks user → role →
 * global → built-in default when looking up the effective limit for
 * a given (user, role-in-this-project) pair.
 *
 * NULL on either column means "inherit" — a row can exist just to set
 * `warn_usd` and leave `hard_usd` to fall back to a less specific scope.
 */
export const usageLimits = sqliteTable(
  "usage_limits",
  {
    scope: text("scope").notNull().$type<"global" | "role" | "user">(),
    target: text("target").notNull().default(""),
    warnUsd: integer("warn_usd", { mode: "number" }),
    hardUsd: integer("hard_usd", { mode: "number" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("usage_limits_scope_target_idx").on(table.scope, table.target)],
);

/**
 * Deduplication bookkeeping so a single threshold crossing never emails
 * the operator more than once per calendar month. The (scope, target,
 * month_ymd, kind) tuple is unique: one row per "client user Alice
 * crossed the warn threshold in 2026-03".
 */
export const usageAlertsSent = sqliteTable(
  "usage_alerts_sent",
  {
    scope: text("scope").notNull(),
    target: text("target").notNull().default(""),
    monthYmd: text("month_ymd").notNull(),
    kind: text("kind").notNull().$type<"warn" | "hard">(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("usage_alerts_sent_target_month_idx").on(table.scope, table.target, table.monthYmd)],
);

/**
 * Monthly-report delivery log. One row per (user, month_ymd) the
 * scheduler has successfully emailed. Prevents duplicates across the
 * daily tick and boot-time catch-up.
 */
export const usageReportsSent = sqliteTable(
  "usage_reports_sent",
  {
    userId: text("user_id").notNull(),
    monthYmd: text("month_ymd").notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("usage_reports_sent_user_idx").on(table.userId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** JSON-encoded array of {path, originalName} for image attachments */
    attachments: text("attachments"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("messages_project_idx").on(table.projectId)],
);

export const projectsRelations = relations(projects, ({ many }) => ({
  members: many(projectMembers),
  invites: many(projectInvites),
  conversations: many(conversations),
  messages: many(messages),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  project: one(projects, {
    fields: [conversations.projectId],
    references: [projects.id],
  }),
  messages: many(messages),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, {
    fields: [projectMembers.projectId],
    references: [projects.id],
  }),
  user: one(user, {
    fields: [projectMembers.userId],
    references: [user.id],
  }),
}));

export const projectInvitesRelations = relations(projectInvites, ({ one }) => ({
  project: one(projects, {
    fields: [projectInvites.projectId],
    references: [projects.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  project: one(projects, {
    fields: [messages.projectId],
    references: [projects.id],
  }),
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  user: one(user, {
    fields: [messages.userId],
    references: [user.id],
  }),
}));
