import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;
let tempDirectory: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-client-usage-scope-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.resetModules();
  if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, "DATABASE_URL");
  else process.env.DATABASE_URL = originalDatabaseUrl;
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("client-scoped usage limits", () => {
  it("does not inherit the underlying user's owner cap exemption", async () => {
    vi.resetModules();
    const { rawSqlite } = await import("../db/index.js");
    const { shouldBlockRun } = await import("./usage-limits.js");
    openDatabase = rawSqlite;
    const now = new Date();
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, 'owner', ?, ?)`,
      )
      .run("owner-1", "Owner", "owner@example.com", now.getTime(), now.getTime());
    rawSqlite
      .prepare(
        `INSERT INTO usage_limits (scope, target, hard_usd, updated_at)
         VALUES ('role', 'client', 1, ?)`,
      )
      .run(now.getTime());
    rawSqlite
      .prepare(
        `INSERT INTO agent_runs (id, project_id, user_id, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("run-1", "project-1", "owner-1", "2", now.getTime());

    await expect(shouldBlockRun("owner-1", "client", now)).resolves.toMatchObject({
      blocked: false,
    });
    await expect(
      shouldBlockRun("owner-1", "client", now, { allowOwnerExemption: false }),
    ).resolves.toMatchObject({
      blocked: true,
      spend: 2,
      limits: { hardUsd: 1, hardSource: "role" },
    });
  });
});
