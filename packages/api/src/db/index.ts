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

export const db = drizzle(sqlite, { schema });
