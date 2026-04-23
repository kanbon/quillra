import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const rawUrl = process.env.DATABASE_URL ?? "file:./data/cms.sqlite";
const filePath = rawUrl.startsWith("file:") ? rawUrl.slice("file:".length) : rawPath(rawUrl);

function rawPath(p: string) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
fs.mkdirSync(path.dirname(resolved), { recursive: true });

const sqlite = new Database(resolved);
sqlite.pragma("journal_mode = WAL");

/**
 * Lightweight bootstrap for additive schema changes that don't ship via
 * drizzle-kit migrate. Each block must be idempotent.
 */
function ensureColumn(table: string, column: string, definition: string) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
try {
  ensureColumn("messages", "attachments", "TEXT");
} catch {
  /* table may not exist yet on a fresh init */
}
try {
  ensureColumn("user", "language", "TEXT");
} catch {
  /* table may not exist yet on a fresh init */
}
try {
  ensureColumn("projects", "logo_url", "TEXT");
} catch {
  /* table may not exist yet on a fresh init */
}
try {
  ensureColumn("conversations", "created_by_user_id", "TEXT");
} catch {
  /* table may not exist yet on a fresh init */
}
try {
  ensureColumn("projects", "migration_target", "TEXT");
} catch {
  /* table may not exist yet on a fresh init */
}

// Usage accounting, one row per agent run. Written by the chat WS
// handler when the SDK emits its terminal `result` event; read by the
// Organization Settings → Usage tab for per-project / per-user
// breakdowns.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    conversation_id TEXT,
    user_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd TEXT NOT NULL DEFAULT '0',
    num_turns INTEGER NOT NULL DEFAULT 1,
    model_usage_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS agent_runs_project_idx ON agent_runs(project_id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs(user_id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS agent_runs_created_idx ON agent_runs(created_at)");
} catch {
  /* ignore */
}

// Bootstrap new tables (drizzle-kit isn't run at boot, so create-if-missing)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS client_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS client_sessions_token_idx ON client_sessions(token)");
} catch {
  /* ignore */
}
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS client_login_codes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS client_login_codes_project_email_idx ON client_login_codes(project_id, email)",
  );
} catch {
  /* ignore */
}

// Team email-code login: admins/editors who don't use GitHub.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS team_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS team_sessions_token_idx ON team_sessions(token)");
} catch {
  /* ignore */
}
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS team_login_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS team_login_codes_email_idx ON team_login_codes(email)");
} catch {
  /* ignore */
}

// Instance settings, key/value store used by the first-run setup wizard
// and any config the admin can change at runtime without restarting the
// container (Anthropic key, GitHub token, mailer backend, etc.)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS instance_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
} catch {
  /* ignore */
}

// Usage limits + alert bookkeeping. `usage_limits` stores warn/hard
// thresholds at three scopes ("global" / "role" / "user"), each row's
// `target` keyed by role name or userId (empty string for global).
// NULL warn/hard = "inherit from a less specific scope". Enforcement
// walks: user → role → global → built-in default ($20 warn, no cap).
// `usage_alerts_sent` deduplicates notifications within a calendar
// month so a single crossing doesn't email the owner every run.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS usage_limits (
    scope TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    warn_usd REAL,
    hard_usd REAL,
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    PRIMARY KEY (scope, target)
  )`);
} catch {
  /* ignore */
}
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS usage_alerts_sent (
    scope TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    month_ymd TEXT NOT NULL,
    kind TEXT NOT NULL,
    sent_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    PRIMARY KEY (scope, target, month_ymd, kind)
  )`);
} catch {
  /* ignore */
}

// Monthly usage report per user. The per-user opt-in lives as a column
// on `user` (see ensureColumn below). `usage_reports_sent` tracks which
// (user, month) pairs have been delivered so the scheduler can catch up
// after downtime without double-sending.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS usage_reports_sent (
    user_id TEXT NOT NULL,
    month_ymd TEXT NOT NULL,
    sent_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    PRIMARY KEY (user_id, month_ymd)
  )`);
} catch {
  /* ignore */
}
try {
  ensureColumn("user", "monthly_usage_reports_enabled", "INTEGER NOT NULL DEFAULT 0");
} catch {
  /* table may not exist yet on a fresh init */
}

// Operator-editable behavior prompt per project role. Rows are seeded
// lazily: when a prompt is missing we fall back to the built-in default
// from services/role-prompts.ts, so there's nothing to bootstrap here
// beyond creating the table.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS role_permission_prompts (
    role TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
} catch {
  /* ignore */
}

// One-shot sweep: the `translator` project role was dropped in favour
// of narrowing member grants to admin/editor/client only. Any existing
// translator rows are safely collapsed into `editor`, which gives the
// user back the closest equivalent permission set. Idempotent, after
// the first boot there are no translator rows left to update.
try {
  sqlite.prepare(`UPDATE project_members SET role = 'editor' WHERE role = 'translator'`).run();
} catch {
  /* project_members may not exist yet on a fresh init */
}

export { sqlite as rawSqlite };

export const db = drizzle(sqlite, { schema });
