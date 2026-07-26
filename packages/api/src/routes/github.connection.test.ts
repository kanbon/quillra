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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

describe("GitHub repository discovery", () => {
  async function connectGithubUser(
    rawSqlite: typeof import("../db/index.js")["rawSqlite"],
  ): Promise<void> {
    const { encryptSecret } = await import("../services/crypto.js");
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO github_user_connections
          (user_id, github_user_id, github_login, access_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("user-1", "1", "alice", encryptSecret("user-token"), now, now);
  }

  it("detects Vite through supported GitHub App user-token endpoints", async () => {
    const { app, rawSqlite } = await createApp();
    await connectGithubUser(rawSqlite);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer user-token" });
        const url = new URL(String(input));
        if (url.pathname === "/user/installations") {
          return Response.json({
            installations: [{ id: 11, permissions: { contents: "write" } }],
          });
        }
        if (url.pathname === "/user/installations/11/repositories") {
          return Response.json({
            repositories: [
              {
                id: 101,
                full_name: "kanbon/moduvista-website",
                default_branch: "main",
                permissions: { push: true, pull: true },
              },
            ],
          });
        }
        if (url.pathname === "/repos/kanbon/moduvista-website/branches") {
          return Response.json([{ name: "main" }]);
        }
        if (url.pathname === "/repos/kanbon/moduvista-website/contents") {
          return Response.json([
            { name: "package.json", type: "file" },
            { name: "vite.config.ts", type: "file" },
          ]);
        }
        if (url.pathname === "/repos/kanbon/moduvista-website/contents/package.json") {
          expect(init?.headers).toMatchObject({
            Accept: "application/vnd.github.raw+json",
          });
          return new Response(
            JSON.stringify({
              scripts: { dev: "vite --host 0.0.0.0" },
              devDependencies: { vite: "^7.0.0", "@vitejs/plugin-react": "^4.0.0" },
            }),
          );
        }
        return Response.json({ message: "not found" }, { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const branches = await app.request("/github/repos/kanbon/moduvista-website/branches");
    expect(branches.status).toBe(200);
    await expect(branches.json()).resolves.toEqual({
      branches: ["main"],
      defaultBranch: "main",
    });

    const framework = await app.request(
      "/github/repos/kanbon/moduvista-website/framework?ref=main",
    );
    expect(framework.status).toBe(200);
    await expect(framework.json()).resolves.toMatchObject({
      supported: true,
      framework: { id: "vite", label: "Vite" },
    });

    for (const [input] of fetchMock.mock.calls) {
      expect(new URL(String(input)).pathname).not.toBe("/user/installations/11");
    }
  });

  it("reports a GitHub outage instead of claiming the user lacks write access", async () => {
    const { app, rawSqlite } = await createApp();
    await connectGithubUser(rawSqlite);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "unavailable" }, { status: 503 })),
    );

    const response = await app.request("/github/repos/kanbon/moduvista-website/branches");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "github_provider_error",
      error: "GitHub is temporarily unavailable. Try again.",
    });
  });

  it("reports GitHub's HTTP 403 rate limit as a temporary provider error", async () => {
    const { app, rawSqlite } = await createApp();
    await connectGithubUser(rawSqlite);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { message: "rate limit exceeded" },
          { status: 403, headers: { "X-RateLimit-Remaining": "0" } },
        ),
      ),
    );

    const response = await app.request("/github/repos/kanbon/moduvista-website/branches");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "github_provider_error",
      error: "GitHub's API rate limit has been reached. Try again later.",
    });
  });
});
