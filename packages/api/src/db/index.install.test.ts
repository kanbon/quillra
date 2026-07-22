import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageAlertsSent, usageLimits, usageReportsSent } from "./app-schema.js";

type SqliteDatabase = typeof import("./index.js")["rawSqlite"];

const originalDatabaseUrl = process.env.DATABASE_URL;

let tempDirectory: string;
let databasePath: string;
let openDatabase: SqliteDatabase | null = null;

async function loadFreshDatabase() {
  vi.resetModules();
  const { rawSqlite } = await import("./index.js");
  openDatabase = rawSqlite;
  return rawSqlite;
}

type RuntimeColumn = { name: string; type: string; pk: number };
type RuntimeIndex = { name: string; unique: number };
type RuntimeIndexColumn = { name: string; seqno: number };
type UsageTable = typeof usageLimits | typeof usageAlertsSent | typeof usageReportsSent;

function runtimeShape(database: SqliteDatabase, tableName: string) {
  const columns = database.pragma(`table_info(${tableName})`) as RuntimeColumn[];
  const uniqueIndexes = (database.pragma(`index_list(${tableName})`) as RuntimeIndex[])
    .filter((index) => index.unique === 1)
    .map((index) => ({
      name: index.name,
      columns: (database.pragma(`index_info(${index.name})`) as RuntimeIndexColumn[])
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    columns: columns.map((column) => ({ name: column.name, type: column.type.toLowerCase() })),
    primaryKey: columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name),
    uniqueIndexes,
  };
}

function declaredShape(table: UsageTable) {
  const config = getTableConfig(table);
  const primaryColumns = [
    ...config.columns.filter((column) => column.primary),
    ...config.primaryKeys.flatMap((key) => key.columns),
  ];

  return {
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType().toLowerCase(),
    })),
    primaryKey: primaryColumns.map((column) => column.name),
    uniqueIndexes: config.indexes
      .filter((index) => index.config.unique)
      .map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) => {
          if (!("name" in column) || typeof column.name !== "string") {
            throw new Error(`Usage index ${index.config.name} must contain direct columns only`);
          }
          return column.name;
        }),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-schema-install-"));
  databasePath = path.join(tempDirectory, "cms.sqlite");
  process.env.DATABASE_URL = `file:${databasePath}`;
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.resetModules();
  if (originalDatabaseUrl === undefined) {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("fresh-install database constraints", () => {
  it("enables foreign-key enforcement", async () => {
    expect(existsSync(databasePath)).toBe(false);
    const sqlite = await loadFreshDatabase();

    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO project_members (id, project_id, user_id, role)
           VALUES (?, ?, ?, ?)`,
        )
        .run("invalid-member", "missing-project", "missing-user", "client"),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("cascades project membership deletes", async () => {
    const sqlite = await loadFreshDatabase();
    const now = Date.now();

    sqlite
      .prepare(
        `INSERT INTO user
          (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("member-1", "Member", "member@example.com", 1, "member", now, now);
    sqlite
      .prepare("INSERT INTO projects (id, name, github_repo_full_name) VALUES (?, ?, ?)")
      .run("project-1", "First site", "example/first-site");
    sqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, ?)`,
      )
      .run("membership-1", "project-1", "member-1", "client");

    expect(sqlite.prepare("SELECT count(*) AS count FROM project_members").get()).toEqual({
      count: 1,
    });
    sqlite.prepare("DELETE FROM projects WHERE id = ?").run("project-1");

    expect(sqlite.prepare("SELECT count(*) AS count FROM project_members").get()).toEqual({
      count: 0,
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM user").get()).toEqual({ count: 1 });
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps runtime usage-table types and natural keys aligned with Drizzle", async () => {
    const sqlite = await loadFreshDatabase();
    const tables: UsageTable[] = [usageLimits, usageAlertsSent, usageReportsSent];

    for (const table of tables) {
      const declaration = getTableConfig(table);
      expect(runtimeShape(sqlite, declaration.name)).toEqual(declaredShape(table));
    }
  });

  it("upgrades the old non-unique usage indexes without losing the newest row", async () => {
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE usage_limits (
        scope TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        warn_usd INTEGER,
        hard_usd INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX usage_limits_scope_target_idx ON usage_limits(scope, target);
      INSERT INTO usage_limits VALUES ('global', '', 10, NULL, 1);
      INSERT INTO usage_limits VALUES ('global', '', 20, NULL, 2);

      CREATE TABLE usage_alerts_sent (
        scope TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        month_ymd TEXT NOT NULL,
        kind TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );
      CREATE INDEX usage_alerts_sent_target_month_idx
        ON usage_alerts_sent(scope, target, month_ymd);
      INSERT INTO usage_alerts_sent VALUES ('global', '', '2026-07', 'warn', 1);
      INSERT INTO usage_alerts_sent VALUES ('global', '', '2026-07', 'warn', 2);

      CREATE TABLE usage_reports_sent (
        user_id TEXT NOT NULL,
        month_ymd TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );
      CREATE INDEX usage_reports_sent_user_idx ON usage_reports_sent(user_id);
      INSERT INTO usage_reports_sent VALUES ('user-1', '2026-07', 1);
      INSERT INTO usage_reports_sent VALUES ('user-1', '2026-07', 2);
    `);
    legacy.close();

    const sqlite = await loadFreshDatabase();
    expect(sqlite.prepare("SELECT warn_usd FROM usage_limits").get()).toEqual({ warn_usd: 20 });
    expect(sqlite.prepare("SELECT sent_at FROM usage_alerts_sent").get()).toEqual({ sent_at: 2 });
    expect(sqlite.prepare("SELECT sent_at FROM usage_reports_sent").get()).toEqual({ sent_at: 2 });

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO usage_limits (scope, target, warn_usd, updated_at)
           VALUES ('global', '', 30, 3)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO usage_alerts_sent (scope, target, month_ymd, kind, sent_at)
           VALUES ('global', '', '2026-07', 'warn', 3)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO usage_reports_sent (user_id, month_ymd, sent_at)
           VALUES ('user-1', '2026-07', 3)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
