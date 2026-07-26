/**
 * Production-build E2E fixture.
 *
 * The live E2B verifier is covered at the API boundary with a deterministic
 * provider double. Browser E2E must not depend on an external paid account, so
 * this preload seeds only the two DB-only verification markers and leaves the
 * fake credential in the child-process environment. It is loaded exclusively
 * by e2e/start-production.mjs.
 */
import Database from "../packages/api/node_modules/better-sqlite3/lib/index.js";

if (process.env.QUILLRA_E2E_SEED_E2B !== "1") {
  throw new Error("The E2B E2E seed may only run in the isolated Playwright fixture.");
}

const rawDatabaseUrl = process.env.DATABASE_URL;
if (!rawDatabaseUrl?.startsWith("file:")) {
  throw new Error("The Playwright E2E fixture requires a file-backed SQLite database.");
}

const database = new Database(rawDatabaseUrl.slice("file:".length));
try {
  database.exec(`
    CREATE TABLE IF NOT EXISTS instance_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
    )
  `);
  const upsert = database.prepare(
    `INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE
       SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const now = Date.now();
  upsert.run("E2B_ENABLED", "true", now);
  upsert.run("E2B_VERIFIED_AT", new Date(now).toISOString(), now);
} finally {
  database.close();
}
