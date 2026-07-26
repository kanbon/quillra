import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../lib/auth.js";

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "QUILLRA_ENCRYPTION_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_OAUTH_CALLBACK_URL",
] as const;

const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));
let tempDirectory: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-github-connection-route-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "github-connection-route-auth-secret";
  process.env.BETTER_AUTH_URL = "https://quillra.test";
  process.env.QUILLRA_ENCRYPTION_KEY = "c".repeat(64);
  process.env.GITHUB_APP_ID = "42";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  process.env.GITHUB_APP_CLIENT_ID = "Iv1.test-client";
  process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
  process.env.GITHUB_APP_SLUG = "quillra-test";
  Reflect.deleteProperty(process.env, "GITHUB_APP_OAUTH_CALLBACK_URL");
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.resetModules();
  for (const key of CONTROLLED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function createApp() {
  vi.resetModules();
  const [{ githubRouter }, { rawSqlite }] = await Promise.all([
    import("./github.js"),
    import("../db/index.js"),
  ]);
  openDatabase = rawSqlite;
  const now = Date.now();
  rawSqlite
    .prepare(
      `INSERT INTO user
        (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, 'member', ?, ?)`,
    )
    .run("user-1", "User One", "user@example.com", now, now);
  const app = new Hono<{
    Variables: {
      user: SessionUser | null;
      clientSession: { projectId: string } | null;
    };
  }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "user-1",
      name: "User One",
      email: "user@example.com",
    } as SessionUser);
    c.set("clientSession", null);
    await next();
  });
  app.route("/github", githubRouter);
  return { app, rawSqlite };
}

describe("GitHub user connection callback migration", () => {
  it("blocks OAuth with owner-facing instructions when an older App lacks the callback marker", async () => {
    const { app, rawSqlite } = await createApp();

    const response = await app.request("/github/connect/start?returnTo=/dashboard");

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("https://quillra.test/api/github/connect/callback");
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM github_oauth_states").get()).toEqual({
      count: 0,
    });
  });

  it("starts PKCE OAuth only when the configured callback matches the public URL", async () => {
    process.env.GITHUB_APP_OAUTH_CALLBACK_URL = "https://quillra.test/api/github/connect/callback";
    const { app, rawSqlite } = await createApp();

    const response = await app.request("/github/connect/start?returnTo=/dashboard");

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("Iv1.test-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://quillra.test/api/github/connect/callback",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM github_oauth_states").get()).toEqual({
      count: 1,
    });
  });
});
