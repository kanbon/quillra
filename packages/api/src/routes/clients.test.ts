import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "EMAIL_PROVIDER",
  "NODE_ENV",
] as const;

const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));
const TEST_AUTH_SECRET = "quillra-client-login-test-auth-secret";

let tempDirectory: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;

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

function signedBetterAuthCookie(token: string): string {
  const signature = createHmac("sha256", TEST_AUTH_SECRET).update(token).digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-client-login-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.EMAIL_PROVIDER = "none";
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("client login codes", () => {
  it("treats an anonymous client session probe as an expected empty state", async () => {
    vi.resetModules();
    const { clientsRouter } = await import("./clients.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;

    const response = await clientsRouter.request("/me");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ user: null });
  });

  it("does not create or disclose a code when email delivery is disabled", async () => {
    vi.resetModules();
    const { clientsRouter } = await import("./clients.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO projects (id, name, github_repo_full_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("project-1", "Example", "example/repo", now, now);
    rawSqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run("client-1", "Client", "client@example.com", now, now);
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'client', ?)`,
      )
      .run("membership-1", "project-1", "client-1", now);

    const response = await clientsRouter.request("/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1", email: "client@example.com" }),
    });
    const body = (await response.json()) as { error?: string; devCode?: string };

    expect(response.status).toBe(503);
    expect(body.error).toBe(
      "Email sign-in is unavailable because email delivery is not configured.",
    );
    expect(body).not.toHaveProperty("devCode");

    const unknownResponse = await clientsRouter.request("/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1", email: "unknown@example.com" }),
    });
    expect(unknownResponse.status).toBe(503);
    await expect(unknownResponse.json()).resolves.toEqual({
      error: "Email sign-in is unavailable because email delivery is not configured.",
    });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM client_login_codes").get()).toEqual({
      count: 0,
    });
  });

  it("reuses a mixed-case user and replaces conflicting team and Better Auth sessions", async () => {
    vi.resetModules();
    const { clientsRouter } = await import("./clients.js");
    const { rawSqlite } = await import("../db/index.js");
    const { hashOtpCode } = await import("../lib/otp.js");
    openDatabase = rawSqlite;
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO projects (id, name, github_repo_full_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("project-1", "Example", "example/repo", now, now);
    rawSqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run("client-1", "Client", "Client.User@Example.COM", now, now);
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'client', ?)`,
      )
      .run("membership-1", "project-1", "client-1", now);
    rawSqlite
      .prepare(
        `INSERT INTO team_sessions (id, user_id, token, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("team-session-1", "client-1", "conflicting-team-token", now + 60_000);
    rawSqlite
      .prepare(
        `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("better-session-1", now + 60_000, "conflicting-better-token", now, now, "client-1");
    rawSqlite
      .prepare(
        `INSERT INTO client_login_codes
           (id, project_id, email, code_hash, expires_at, attempts)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(
        "client-code-1",
        "project-1",
        "client.user@example.com",
        hashOtpCode("123456"),
        now + 60_000,
      );

    const response = await clientsRouter.request("/verify-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `quillra_team_session=conflicting-team-token; better-auth.session_token=${signedBetterAuthCookie("conflicting-better-token")}`,
      },
      body: JSON.stringify({
        projectId: "project-1",
        email: "CLIENT.USER@example.com",
        code: "123456",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("quillra_client_session=");
    expect(response.headers.get("set-cookie")).toContain("quillra_team_session=");
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=");
    expect(
      rawSqlite
        .prepare("SELECT count(*) AS count FROM user WHERE lower(email) = ?")
        .get("client.user@example.com"),
    ).toEqual({ count: 1 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_sessions").get()).toEqual({
      count: 0,
    });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM session").get()).toEqual({ count: 0 });
    expect(rawSqlite.prepare("SELECT user_id AS userId FROM client_sessions").get()).toEqual({
      userId: "client-1",
    });
  });

  it("revokes an existing client session as soon as project membership is removed", async () => {
    vi.resetModules();
    const { getClientSessionFromCookie } = await import("./clients.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO projects (id, name, github_repo_full_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("project-1", "Example", "example/repo", now, now);
    rawSqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run("client-1", "Client", "client@example.com", now, now);
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'client', ?)`,
      )
      .run("membership-1", "project-1", "client-1", now);
    rawSqlite
      .prepare(
        `INSERT INTO client_sessions (id, user_id, project_id, token, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("client-session-1", "client-1", "project-1", "client-token", now + 60_000);

    await expect(getClientSessionFromCookie("client-token")).resolves.toMatchObject({
      projectId: "project-1",
      user: { id: "client-1" },
    });
    rawSqlite.prepare("DELETE FROM project_members WHERE id = ?").run("membership-1");

    await expect(getClientSessionFromCookie("client-token")).resolves.toBeNull();
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM client_sessions").get()).toEqual({
      count: 0,
    });
  });

  it("clears both custom session kinds and the Better Auth session on logout", async () => {
    vi.resetModules();
    const { clientsRouter } = await import("./clients.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    const expiresAt = Date.now() + 60_000;
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run("user-1", "User", "user@example.com", now, now);
    rawSqlite
      .prepare(
        `INSERT INTO client_sessions (id, user_id, project_id, token, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("client-session", "user-1", "project-1", "client-token", expiresAt);
    rawSqlite
      .prepare(
        `INSERT INTO team_sessions (id, user_id, token, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("team-session", "user-1", "team-token", expiresAt);
    rawSqlite
      .prepare(
        `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("better-session", expiresAt, "better-token", now, now, "user-1");

    const response = await clientsRouter.request("/logout", {
      method: "POST",
      headers: {
        Cookie: `quillra_client_session=client-token; quillra_team_session=team-token; better-auth.session_token=${signedBetterAuthCookie("better-token")}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("quillra_client_session=");
    expect(response.headers.get("set-cookie")).toContain("quillra_team_session=");
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=");
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM client_sessions").get()).toEqual({
      count: 0,
    });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_sessions").get()).toEqual({
      count: 0,
    });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM session").get()).toEqual({ count: 0 });
  });
});
