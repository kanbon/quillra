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
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("journal_mode = WAL");

/**
 * Create the tables that used to exist only after a manual `drizzle-kit push`.
 *
 * Production images contain the compiled API, not the TypeScript schema or the
 * Drizzle CLI config, so a brand-new data volume must be able to initialize
 * itself at runtime. Keep these statements aligned with db/schema.ts. The
 * additive compatibility blocks below still upgrade databases created by
 * older releases.
 */
function bootstrapCoreSchema() {
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        emailVerified INTEGER NOT NULL DEFAULT 0,
        image TEXT,
        instance_role TEXT,
        language TEXT,
        monthly_usage_reports_enabled INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
        updatedAt INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
      );

      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        expiresAt INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        createdAt INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
        updatedAt INTEGER NOT NULL,
        ipAddress TEXT,
        userAgent TEXT,
        userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS session_userId_idx ON session(userId);

      CREATE TABLE IF NOT EXISTS account (
        id TEXT PRIMARY KEY,
        accountId TEXT NOT NULL,
        providerId TEXT NOT NULL,
        userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        accessToken TEXT,
        refreshToken TEXT,
        idToken TEXT,
        accessTokenExpiresAt INTEGER,
        refreshTokenExpiresAt INTEGER,
        scope TEXT,
        password TEXT,
        createdAt INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS account_userId_idx ON account(userId);

      CREATE TABLE IF NOT EXISTS verification (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        value TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
        updatedAt INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
      );
      CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);

      CREATE TABLE IF NOT EXISTS project_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        brand_logo_url TEXT,
        brand_accent_color TEXT,
        brand_display_name TEXT,
        brand_tagline TEXT,
        created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
        updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
      );
      CREATE INDEX IF NOT EXISTS project_groups_slug_idx ON project_groups(slug);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        github_repo_full_name TEXT NOT NULL,
        github_installation_id TEXT,
        github_repository_id TEXT,
        github_binding_generation INTEGER NOT NULL DEFAULT 1,
        default_branch TEXT NOT NULL DEFAULT 'main',
        preview_dev_command TEXT,
        logo_url TEXT,
        brand_display_name TEXT,
        brand_accent_color TEXT,
        group_id TEXT REFERENCES project_groups(id) ON DELETE SET NULL,
        migration_target TEXT,
        created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
        updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
      );

      CREATE TABLE IF NOT EXISTS project_members (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        invited_by_user_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
      );
      CREATE INDEX IF NOT EXISTS project_members_project_idx ON project_members(project_id);
      CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id);

      CREATE TABLE IF NOT EXISTS project_invites (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        name TEXT,
        role TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        invited_by_user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS instance_invites (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        invited_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_by_user_id TEXT,
        title TEXT,
        agent_session_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
        updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
      );
      CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations(project_id);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT,
        created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
      );
      CREATE INDEX IF NOT EXISTS messages_project_idx ON messages(project_id);
    `);
  })();
}

bootstrapCoreSchema();

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
  ensureColumn("projects", "github_repository_id", "TEXT");
} catch {
  /* table may not exist yet on a fresh init */
}
try {
  ensureColumn("projects", "github_binding_generation", "INTEGER NOT NULL DEFAULT 1");
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
try {
  ensureColumn("project_invites", "name", "TEXT");
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
  sqlite.exec(`DELETE FROM client_login_codes
    WHERE rowid NOT IN (
      SELECT MAX(rowid) FROM client_login_codes GROUP BY project_id, lower(trim(email))
    )`);
  sqlite.exec("UPDATE client_login_codes SET email = lower(trim(email))");
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS client_login_codes_project_email_unique ON client_login_codes(project_id, email)",
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
  sqlite.exec(`DELETE FROM team_login_codes
    WHERE rowid NOT IN (
      SELECT MAX(rowid) FROM team_login_codes GROUP BY lower(trim(email))
    )`);
  sqlite.exec("UPDATE team_login_codes SET email = lower(trim(email))");
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS team_login_codes_email_unique ON team_login_codes(email)",
  );
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

// Per-user GitHub App OAuth connection. OAuth state is one-time and bound to
// the signed-in Quillra user; credentials are encrypted by the service before
// they reach these tables.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS github_oauth_states (
    state_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    code_verifier TEXT NOT NULL,
    return_to TEXT NOT NULL DEFAULT '/',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS github_oauth_states_user_idx ON github_oauth_states(user_id)",
  );
  sqlite.exec(`CREATE TABLE IF NOT EXISTS github_user_connections (
    user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    github_user_id TEXT NOT NULL,
    github_login TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    access_token_expires_at INTEGER,
    refresh_token_expires_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
} catch {
  /* ignore */
}

/**
 * Usage limits and delivery-deduplication tables used to be declared twice:
 * the Drizzle schema had non-unique indexes while this runtime bootstrap used
 * composite primary keys and different column affinities. Keep the runtime
 * shape identical to app-schema.ts and repair databases created by the old
 * Drizzle definition by replacing its non-unique indexes with natural-key
 * unique indexes. The short de-duplication sweep makes that upgrade safe even
 * if an old database accumulated duplicate rows before uniqueness was fixed.
 */
function bootstrapUsageSchema() {
  sqlite.transaction(() => {
    // INTEGER matches Drizzle's number-mode columns. SQLite still preserves a
    // fractional number as REAL when it cannot be represented as an integer.
    sqlite.exec(`CREATE TABLE IF NOT EXISTS usage_limits (
      scope TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      warn_usd INTEGER,
      hard_usd INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
    )`);
    sqlite.exec(`DELETE FROM usage_limits
      WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM usage_limits GROUP BY scope, target
      )`);
    sqlite.exec("DROP INDEX IF EXISTS usage_limits_scope_target_idx");
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS usage_limits_scope_target_unique
      ON usage_limits(scope, target)`);

    sqlite.exec(`CREATE TABLE IF NOT EXISTS usage_alerts_sent (
      scope TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      month_ymd TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
    )`);
    sqlite.exec(`DELETE FROM usage_alerts_sent
      WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM usage_alerts_sent GROUP BY scope, target, month_ymd, kind
      )`);
    sqlite.exec("DROP INDEX IF EXISTS usage_alerts_sent_target_month_idx");
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS usage_alerts_sent_scope_target_month_kind_unique
      ON usage_alerts_sent(scope, target, month_ymd, kind)`);

    // Monthly usage report per user. The per-user opt-in lives as a column
    // on `user`; this table prevents duplicate deliveries after downtime.
    sqlite.exec(`CREATE TABLE IF NOT EXISTS usage_reports_sent (
      user_id TEXT NOT NULL,
      month_ymd TEXT NOT NULL,
      sent_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
    )`);
    sqlite.exec(`DELETE FROM usage_reports_sent
      WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM usage_reports_sent GROUP BY user_id, month_ymd
      )`);
    sqlite.exec("DROP INDEX IF EXISTS usage_reports_sent_user_idx");
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS usage_reports_sent_user_month_unique
      ON usage_reports_sent(user_id, month_ymd)`);
  })();
}

bootstrapUsageSchema();
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

// Project-group tables are part of the core bootstrap above. Keep these
// additive column checks for databases created before group branding existed.
try {
  ensureColumn("projects", "brand_display_name", "TEXT");
} catch {
  /* table may not exist yet on a fresh init */
}
try {
  ensureColumn("projects", "brand_accent_color", "TEXT");
} catch {
  /* table may not exist yet on a fresh init */
}
try {
  ensureColumn("projects", "group_id", "TEXT");
} catch {
  /* table may not exist yet on a fresh init */
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
