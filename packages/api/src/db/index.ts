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
} catch { /* table may not exist yet on a fresh init */ }
try {
  ensureColumn("user", "language", "TEXT");
} catch { /* table may not exist yet on a fresh init */ }
try {
  ensureColumn("projects", "logo_url", "TEXT");
} catch { /* table may not exist yet on a fresh init */ }
try {
  ensureColumn("conversations", "created_by_user_id", "TEXT");
} catch { /* table may not exist yet on a fresh init */ }

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
  sqlite.exec(`CREATE INDEX IF NOT EXISTS client_sessions_token_idx ON client_sessions(token)`);
} catch { /* ignore */ }
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
  sqlite.exec(`CREATE INDEX IF NOT EXISTS client_login_codes_project_email_idx ON client_login_codes(project_id, email)`);
} catch { /* ignore */ }

// Team email-code login: admins/editors/translators who don't use GitHub.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS team_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS team_sessions_token_idx ON team_sessions(token)`);
} catch { /* ignore */ }
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS team_login_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS team_login_codes_email_idx ON team_login_codes(email)`);
} catch { /* ignore */ }

// Instance settings — key/value store used by the first-run setup wizard
// and any config the admin can change at runtime without restarting the
// container (Anthropic key, GitHub token, mailer backend, etc.)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS instance_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  )`);
} catch { /* ignore */ }

export { sqlite as rawSqlite };

export const db = drizzle(sqlite, { schema });
