import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../lib/auth.js";

const EXPECTED_TABLES = [
  "account",
  "agent_runs",
  "client_login_codes",
  "client_sessions",
  "conversations",
  "github_oauth_states",
  "github_user_connections",
  "instance_invites",
  "instance_settings",
  "messages",
  "project_groups",
  "project_invites",
  "project_members",
  "project_sandboxes",
  "projects",
  "role_permission_prompts",
  "session",
  "team_login_codes",
  "team_sessions",
  "usage_alerts_sent",
  "usage_limits",
  "usage_reports_sent",
  "user",
  "verification",
] as const;

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "QUILLRA_SETUP_TOKEN",
  "NODE_ENV",
  "ANTHROPIC_API_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));

let tempDirectory: string;
let databasePath: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;

function closeDatabase() {
  if (!openDatabase) return;
  openDatabase.close();
  openDatabase = null;
}

function restoreEnvironment() {
  for (const key of CONTROLLED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function loadSetupRuntime() {
  vi.resetModules();
  const { setupRouter } = await import("./setup.js");
  const { rawSqlite } = await import("../db/index.js");
  openDatabase = rawSqlite;
  const { fixedWindowRateLimiter } = await import("../lib/fixed-window-rate-limit.js");
  fixedWindowRateLimiter.clear();
  return { setupRouter, rawSqlite };
}

function tableNames(database: typeof import("../db/index.js")["rawSqlite"]): string[] {
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-first-install-"));
  databasePath = path.join(tempDirectory, "cms.sqlite");
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.BETTER_AUTH_SECRET = "quillra-setup-test-auth-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.QUILLRA_SETUP_TOKEN = "quillra-setup-test-token";
  process.env.NODE_ENV = "test";
  for (const key of ["ANTHROPIC_API_KEY", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] as const) {
    delete process.env[key];
  }
});

afterEach(() => {
  closeDatabase();
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("first-install database bootstrap", () => {
  it("does not let a project-scoped client session inherit setup-owner access", async () => {
    const { setupRouter, rawSqlite } = await loadSetupRuntime();
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, 'owner', ?, ?)`,
      )
      .run("owner-1", "Owner", "owner@example.com", now, now);

    const app = new Hono<{
      Variables: {
        user: SessionUser | null;
        clientSession: { projectId: string } | null;
      };
    }>();
    app.use("*", async (c, next) => {
      c.set("user", {
        id: "owner-1",
        name: "Owner",
        email: "owner@example.com",
      } as SessionUser);
      c.set("clientSession", { projectId: "project-1" });
      await next();
    });
    app.route("/", setupRouter);

    const status = await app.request("/status");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      needsSetup: true,
      needsOwner: false,
      access: "owner-required",
    });

    const save = await app.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: { ANTHROPIC_API_KEY: "must-not-be-written" } }),
    });
    expect(save.status).toBe(403);
    await expect(save.json()).resolves.toEqual({ error: "Owner only" });
    expect(
      rawSqlite
        .prepare("SELECT value FROM instance_settings WHERE key = 'ANTHROPIC_API_KEY'")
        .get(),
    ).toBeUndefined();
  });

  it("creates the complete schema and serves the setup API from an empty database", async () => {
    expect(existsSync(databasePath)).toBe(false);

    const { setupRouter, rawSqlite } = await loadSetupRuntime();
    const statusResponse = await setupRouter.request("/status");

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toEqual({
      needsSetup: true,
      needsOwner: true,
      access: "token-required",
    });
    expect(tableNames(rawSqlite)).toEqual(EXPECTED_TABLES);

    const unauthorizedSave = await setupRouter.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: { ANTHROPIC_API_KEY: "test-anthropic-key" } }),
    });
    expect(unauthorizedSave.status).toBe(401);

    const unlockResponse = await setupRouter.request("/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "quillra-setup-test-token" }),
    });
    expect(unlockResponse.status).toBe(200);
    const cookie = unlockResponse.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^quillra_server_access=/);

    const authorizedStatus = await setupRouter.request("/status", {
      headers: { Cookie: cookie ?? "" },
    });
    expect(await authorizedStatus.json()).toMatchObject({
      needsSetup: true,
      needsOwner: true,
      access: "granted",
      missing: ["ANTHROPIC_API_KEY", "E2B", "GITHUB_APP", "__owner"],
    });

    const saveResponse = await setupRouter.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
      body: JSON.stringify({ values: { ANTHROPIC_API_KEY: "test-anthropic-key" } }),
    });
    expect(saveResponse.status).toBe(200);

    const stored = rawSqlite
      .prepare("SELECT value FROM instance_settings WHERE key = ?")
      .get("ANTHROPIC_API_KEY") as { value: string };
    expect(stored.value).toMatch(/^v1:/);
    expect(stored.value).not.toContain("test-anthropic-key");
  });

  it("rejects generic GitHub App writes atomically while preserving normal setup saves", async () => {
    const { setupRouter, rawSqlite } = await loadSetupRuntime();
    const unlockResponse = await setupRouter.request("/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "quillra-setup-test-token" }),
    });
    const cookie = unlockResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    rawSqlite
      .prepare("INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("GITHUB_APP_ID", "existing-app-id", Date.now());

    const rejected = await setupRouter.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        values: {
          GITHUB_APP_ID: "replacement-app-id",
          GITHUB_APP_FUTURE_CREDENTIAL: "future-secret",
          ANTHROPIC_API_KEY: "must-not-be-partially-written",
        },
      }),
    });

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: "GitHub App settings must be managed through the dedicated GitHub App flow.",
    });
    expect(
      rawSqlite.prepare("SELECT value FROM instance_settings WHERE key = ?").get("GITHUB_APP_ID"),
    ).toEqual({ value: "existing-app-id" });
    expect(
      rawSqlite
        .prepare("SELECT value FROM instance_settings WHERE key = ?")
        .get("ANTHROPIC_API_KEY"),
    ).toBeUndefined();

    const allowed = await setupRouter.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ values: { ANTHROPIC_API_KEY: "allowed-anthropic-key" } }),
    });

    expect(allowed.status).toBe(200);
    const stored = rawSqlite
      .prepare("SELECT value FROM instance_settings WHERE key = ?")
      .get("ANTHROPIC_API_KEY") as { value: string };
    expect(stored.value).toMatch(/^v1:/);
    expect(stored.value).not.toContain("allowed-anthropic-key");
  });

  it("is idempotent across restarts and preserves first-install data", async () => {
    const firstRuntime = await loadSetupRuntime();
    const now = Date.now();
    firstRuntime.rawSqlite
      .prepare(
        `INSERT INTO user
          (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("owner-1", "Owner", "owner@example.com", 1, "owner", now, now);
    firstRuntime.rawSqlite
      .prepare("INSERT INTO projects (id, name, github_repo_full_name) VALUES (?, ?, ?)")
      .run("project-1", "First site", "example/first-site");

    closeDatabase();
    const secondRuntime = await loadSetupRuntime();

    expect(tableNames(secondRuntime.rawSqlite)).toEqual(EXPECTED_TABLES);
    expect(secondRuntime.rawSqlite.prepare("SELECT count(*) AS count FROM user").get()).toEqual({
      count: 1,
    });
    expect(secondRuntime.rawSqlite.prepare("SELECT count(*) AS count FROM projects").get()).toEqual(
      { count: 1 },
    );

    const statusResponse = await secondRuntime.setupRouter.request("/status");
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toEqual({
      needsSetup: true,
      needsOwner: false,
      access: "owner-required",
    });
  });
});
