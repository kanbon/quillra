import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "QUILLRA_SETUP_TOKEN",
  "EMAIL_PROVIDER",
  "RESEND_API_KEY",
  "NODE_ENV",
] as const;

const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));
const TEST_AUTH_SECRET = "quillra-team-login-test-auth-secret";

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

async function loadRuntime() {
  vi.resetModules();
  const { getTeamSessionFromCookie, teamLoginRouter } = await import("./team-login.js");
  const { rawSqlite } = await import("../db/index.js");
  openDatabase = rawSqlite;
  return { getTeamSessionFromCookie, teamLoginRouter, rawSqlite };
}

async function requestCode(
  router: Awaited<ReturnType<typeof loadRuntime>>["teamLoginRouter"],
  email: string,
  ip = "198.51.100.10",
  accessToken: string | null = "quillra-team-login-test-token",
) {
  const response = await router.request("/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ email, ...(accessToken ? { accessToken } : {}) }),
  });
  return {
    response,
    body: (await response.json()) as {
      ok?: boolean;
      devCode?: string;
      recoveryRequired?: boolean;
      error?: string;
    },
  };
}

async function verifyCode(
  router: Awaited<ReturnType<typeof loadRuntime>>["teamLoginRouter"],
  email: string,
  code: string,
  ip = "198.51.100.10",
  accessToken: string | null = "quillra-team-login-test-token",
  cookie?: string,
) {
  return router.request("/verify-code", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ email, code, ...(accessToken ? { accessToken } : {}) }),
  });
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-owner-login-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.QUILLRA_SETUP_TOKEN = "quillra-team-login-test-token";
  process.env.EMAIL_PROVIDER = "none";
  process.env.NODE_ENV = "test";
  // biome-ignore lint/performance/noDelete: each test starts without host mail credentials
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("team login owner bootstrap", () => {
  it("creates the first owner and a team session from an email code", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();
    const email = "owner@example.com";
    rawSqlite
      .prepare("INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("INSTANCE_OPERATOR_NAME", "Quillra Test Owner", Date.now());
    const requested = await requestCode(teamLoginRouter, email);

    expect(requested.response.status).toBe(200);
    expect(requested.body.devCode).toMatch(/^\d{6}$/);

    const verified = await verifyCode(teamLoginRouter, email, requested.body.devCode as string);

    expect(verified.status).toBe(200);
    expect(verified.headers.get("set-cookie")).toContain("quillra_team_session=");
    expect(verified.headers.get("set-cookie")).toContain("quillra_server_access=");
    expect(rawSqlite.prepare("SELECT name, email, instance_role AS role FROM user").all()).toEqual([
      { name: "Quillra Test Owner", email, role: "owner" },
    ]);
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_sessions").get()).toEqual({
      count: 1,
    });
  });

  it("never discloses a no-email code without server access", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();

    const requested = await requestCode(
      teamLoginRouter,
      "owner@example.com",
      "198.51.100.10",
      null,
    );

    expect(requested.response.status).toBe(200);
    expect(requested.body).toEqual({ ok: true, recoveryRequired: true });
    expect(requested.body).not.toHaveProperty("devCode");
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_login_codes").get()).toEqual({
      count: 0,
    });
  });

  it("requires server access before first-owner signup even when email works", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test_never_called";
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", send);
    const { teamLoginRouter, rawSqlite } = await loadRuntime();

    const requested = await requestCode(
      teamLoginRouter,
      "owner@example.com",
      "198.51.100.10",
      null,
    );

    expect(requested.response.status).toBe(401);
    expect(requested.body.error).toBe("Server access token required for first-owner signup.");
    expect(send).not.toHaveBeenCalled();
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_login_codes").get()).toEqual({
      count: 0,
    });
  });

  it("requires server access again when redeeming the first-owner code", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();
    const email = "owner@example.com";
    const requested = await requestCode(teamLoginRouter, email);

    const rejected = await verifyCode(
      teamLoginRouter,
      email,
      requested.body.devCode as string,
      "198.51.100.10",
      null,
    );

    expect(rejected.status).toBe(401);
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM user").get()).toEqual({ count: 0 });
    const accepted = await verifyCode(teamLoginRouter, email, requested.body.devCode as string);
    expect(accepted.status).toBe(200);
  });

  it("rate-limits invalid server-token probes on first-owner verification", async () => {
    const { teamLoginRouter } = await loadRuntime();
    const email = "token-probe@example.com";

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await verifyCode(
        teamLoginRouter,
        email,
        "000000",
        "198.51.100.10",
        "wrong-token",
      );
      expect(response.status).toBe(401);
    }

    const blocked = await verifyCode(
      teamLoginRouter,
      email,
      "000000",
      "198.51.100.10",
      "wrong-token",
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("allows exactly one of two competing empty-instance claims to become owner", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();
    const first = await requestCode(teamLoginRouter, "first@example.com");
    const second = await requestCode(teamLoginRouter, "second@example.com");

    const responses = await Promise.all([
      verifyCode(teamLoginRouter, "first@example.com", first.body.devCode as string),
      verifyCode(teamLoginRouter, "second@example.com", second.body.devCode as string),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(
      rawSqlite.prepare("SELECT count(*) AS count FROM user WHERE instance_role = 'owner'").get(),
    ).toEqual({ count: 1 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM user").get()).toEqual({ count: 1 });
  });

  it("promotes a stray legacy member when the installation has no owner", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, 'member', ?, ?)`,
      )
      .run("legacy-member", "Legacy Member", "Legacy.Owner@Example.COM", now, now);

    const requested = await requestCode(teamLoginRouter, "legacy.owner@example.com");
    const verified = await verifyCode(
      teamLoginRouter,
      "legacy.owner@example.com",
      requested.body.devCode as string,
    );

    expect(verified.status).toBe(200);
    expect(rawSqlite.prepare("SELECT id, instance_role AS role FROM user").all()).toEqual([
      { id: "legacy-member", role: "owner" },
    ]);
  });

  it("lets the established owner sign in again without creating another user", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();
    const email = "returning-owner@example.com";
    const initialCode = await requestCode(teamLoginRouter, email);
    expect(
      (await verifyCode(teamLoginRouter, email, initialCode.body.devCode as string)).status,
    ).toBe(200);

    const returningCode = await requestCode(teamLoginRouter, email);
    const returningLogin = await verifyCode(
      teamLoginRouter,
      email,
      returningCode.body.devCode as string,
    );

    expect(returningCode.body.devCode).toMatch(/^\d{6}$/);
    expect(returningLogin.status).toBe(200);
    expect(returningLogin.headers.get("set-cookie")).toContain("quillra_team_session=");
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM user").get()).toEqual({ count: 1 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_sessions").get()).toEqual({
      count: 2,
    });
  });

  it("keeps exactly one live code during concurrent requests", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();
    const { otpCodeMatches } = await import("../lib/otp.js");
    const email = "concurrent.member@example.com";
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES ('concurrent-member', 'Concurrent', ?, 1, 'member', ?, ?)`,
      )
      .run(email, now, now);

    const requested = await Promise.all([
      requestCode(teamLoginRouter, email, "198.51.100.20"),
      requestCode(teamLoginRouter, email, "198.51.100.21"),
    ]);
    expect(requested.map(({ response }) => response.status)).toEqual([200, 200]);
    const rows = rawSqlite
      .prepare("SELECT code_hash AS codeHash FROM team_login_codes WHERE email = ?")
      .all(email) as { codeHash: string }[];
    expect(rows).toHaveLength(1);
    const liveCode = requested
      .map(({ body }) => body.devCode)
      .find((code) => code && otpCodeMatches(code, rows[0]?.codeHash ?? ""));
    expect(liveCode).toMatch(/^\d{6}$/);
    expect((await verifyCode(teamLoginRouter, email, liveCode as string)).status).toBe(200);
  });

  it("reuses legacy mixed-case users and invites without creating a duplicate", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();
    const ownerCode = await requestCode(teamLoginRouter, "owner@example.com");
    expect(
      (await verifyCode(teamLoginRouter, "owner@example.com", ownerCode.body.devCode as string))
        .status,
    ).toBe(200);

    const owner = rawSqlite.prepare("SELECT id FROM user WHERE instance_role = 'owner'").get() as {
      id: string;
    };
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run("legacy-member", "Legacy Member", "Legacy.Member@Example.COM", now, now);
    rawSqlite
      .prepare(
        `INSERT INTO instance_invites
           (id, email, token_hash, invited_by_user_id, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-invite",
        "LEGACY.member@example.com",
        "unused-token-hash",
        owner.id,
        now + 60_000,
      );

    const requested = await requestCode(teamLoginRouter, "legacy.member@example.com");
    expect(requested.body.devCode).toMatch(/^\d{6}$/);
    const verified = await verifyCode(
      teamLoginRouter,
      "LEGACY.MEMBER@example.com",
      requested.body.devCode as string,
    );

    expect(verified.status).toBe(200);
    expect(
      rawSqlite
        .prepare("SELECT count(*) AS count FROM user WHERE lower(email) = ?")
        .get("legacy.member@example.com"),
    ).toEqual({ count: 1 });
    expect(
      rawSqlite.prepare("SELECT instance_role AS role FROM user WHERE id = ?").get("legacy-member"),
    ).toEqual({ role: "member" });
    expect(
      rawSqlite
        .prepare("SELECT accepted_at AS acceptedAt FROM instance_invites WHERE id = ?")
        .get("legacy-invite"),
    ).toEqual({ acceptedAt: expect.any(Number) });
  });

  it("rejects an expired instance invite even when its email casing differs", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();
    const ownerCode = await requestCode(teamLoginRouter, "owner@example.com");
    expect(
      (await verifyCode(teamLoginRouter, "owner@example.com", ownerCode.body.devCode as string))
        .status,
    ).toBe(200);

    const owner = rawSqlite.prepare("SELECT id FROM user WHERE instance_role = 'owner'").get() as {
      id: string;
    };
    rawSqlite
      .prepare(
        `INSERT INTO instance_invites
           (id, email, token_hash, invited_by_user_id, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("expired-invite", "Expired@Example.COM", "unused", owner.id, Date.now() - 1);

    const requested = await requestCode(teamLoginRouter, "expired@example.com");

    expect(requested.response.status).toBe(403);
    expect(requested.body).not.toHaveProperty("devCode");
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_login_codes").get()).toEqual({
      count: 0,
    });
  });

  it("replaces conflicting client and Better Auth sessions when team login succeeds", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();
    const email = "owner@example.com";
    const ownerCode = await requestCode(teamLoginRouter, email);
    expect(
      (await verifyCode(teamLoginRouter, email, ownerCode.body.devCode as string)).status,
    ).toBe(200);

    const owner = rawSqlite.prepare("SELECT id FROM user WHERE instance_role = 'owner'").get() as {
      id: string;
    };
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO projects (id, name, github_repo_full_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("client-project", "Client Project", "example/repo", now, now);
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'client', ?)`,
      )
      .run("client-membership", "client-project", owner.id, now);
    rawSqlite
      .prepare(
        `INSERT INTO client_sessions (id, user_id, project_id, token, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("client-session", owner.id, "client-project", "conflicting-client-token", now + 60_000);
    rawSqlite
      .prepare(
        `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("better-session", now + 60_000, "conflicting-better-token", now, now, owner.id);

    const returningCode = await requestCode(teamLoginRouter, email);
    const verified = await verifyCode(
      teamLoginRouter,
      email,
      returningCode.body.devCode as string,
      "198.51.100.10",
      "quillra-team-login-test-token",
      `quillra_client_session=conflicting-client-token; better-auth.session_token=${signedBetterAuthCookie("conflicting-better-token")}`,
    );

    expect(verified.status).toBe(200);
    expect(verified.headers.get("set-cookie")).toContain("quillra_client_session=");
    expect(verified.headers.get("set-cookie")).toContain("better-auth.session_token=");
    expect(
      rawSqlite
        .prepare("SELECT count(*) AS count FROM client_sessions WHERE id = ?")
        .get("client-session"),
    ).toEqual({ count: 0 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM session").get()).toEqual({ count: 0 });
  });

  it("clears client, team, and Better Auth sessions on logout", async () => {
    const { teamLoginRouter, rawSqlite } = await loadRuntime();
    const now = Date.now();
    const expiresAt = now + 60_000;
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES ('member-1', 'Member', 'member@example.com', 1, 'member', ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO client_sessions (id, user_id, project_id, token, expires_at)
         VALUES ('client-session', 'member-1', 'project-1', 'client-token', ?)`,
      )
      .run(expiresAt);
    rawSqlite
      .prepare(
        `INSERT INTO team_sessions (id, user_id, token, expires_at)
         VALUES ('team-session', 'member-1', 'team-token', ?)`,
      )
      .run(expiresAt);
    rawSqlite
      .prepare(
        `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
         VALUES ('better-session', ?, 'better-token', ?, ?, 'member-1')`,
      )
      .run(expiresAt, now, now);

    const response = await teamLoginRouter.request("/logout", {
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

  it("deletes an expired team session while resolving it", async () => {
    const { getTeamSessionFromCookie, rawSqlite } = await loadRuntime();
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES ('member-1', 'Member', 'member@example.com', 1, 'member', ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO team_sessions (id, user_id, token, expires_at)
         VALUES ('expired-session', 'member-1', 'expired-token', ?)`,
      )
      .run(now - 1);

    await expect(getTeamSessionFromCookie("expired-token")).resolves.toBeNull();
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_sessions").get()).toEqual({
      count: 0,
    });
  });

  it("deletes a team session when the user's instance role was revoked", async () => {
    const { getTeamSessionFromCookie, rawSqlite } = await loadRuntime();
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES ('revoked-member', 'Revoked', 'revoked@example.com', 1, ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO team_sessions (id, user_id, token, expires_at)
         VALUES ('revoked-session', 'revoked-member', 'revoked-token', ?)`,
      )
      .run(now + 60_000);

    await expect(getTeamSessionFromCookie("revoked-token")).resolves.toBeNull();
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_sessions").get()).toEqual({
      count: 0,
    });
  });

  it("reports email delivery failures and burns the undeliverable code", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test_invalid";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("provider rejected the message", { status: 422 })),
    );
    const { teamLoginRouter, rawSqlite } = await loadRuntime();

    const requested = await requestCode(teamLoginRouter, "owner@example.com");

    expect(requested.response.status).toBe(502);
    expect(requested.body.error).toBe(
      "Could not send the sign-in code. Check the email settings and try again.",
    );
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_login_codes").get()).toEqual({
      count: 0,
    });
  });

  it("rate-limits repeated code requests per email", async () => {
    const { teamLoginRouter } = await loadRuntime();
    const email = "owner@example.com";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await requestCode(teamLoginRouter, email)).response.status).toBe(200);
    }
    const blocked = await requestCode(teamLoginRouter, email);

    expect(blocked.response.status).toBe(429);
    expect(blocked.response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(blocked.body.error).toBe("Too many sign-in code requests. Try again later.");
  });

  it("rate-limits verification probes even when no code exists", async () => {
    const { teamLoginRouter } = await loadRuntime();
    const email = "unknown@example.com";

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await verifyCode(teamLoginRouter, email, "000000")).status).toBe(400);
    }
    const blocked = await verifyCode(teamLoginRouter, email, "000000");

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    await expect(blocked.json()).resolves.toEqual({
      error: "Too many verification attempts. Try again later.",
    });
  });
});
