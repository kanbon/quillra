import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalEncryptionKey = process.env.QUILLRA_ENCRYPTION_KEY;
const originalGithubAppId = process.env.GITHUB_APP_ID;
const originalGithubAppPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
const originalGithubAppClientId = process.env.GITHUB_APP_CLIENT_ID;
const originalGithubAppClientSecret = process.env.GITHUB_APP_CLIENT_SECRET;

let tempDirectory: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;

async function loadRuntime() {
  vi.resetModules();
  const service = await import("./github-user-connection.js");
  const { rawSqlite } = await import("../db/index.js");
  const { encryptSecret } = await import("./crypto.js");
  openDatabase = rawSqlite;
  return { service, rawSqlite, encryptSecret };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-github-user-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "github-user-test-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "b".repeat(64);
  process.env.GITHUB_APP_ID = "42";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  process.env.GITHUB_APP_CLIENT_ID = "Iv1.test-client";
  process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnv("DATABASE_URL", originalDatabaseUrl);
  restoreEnv("BETTER_AUTH_SECRET", originalAuthSecret);
  restoreEnv("QUILLRA_ENCRYPTION_KEY", originalEncryptionKey);
  restoreEnv("GITHUB_APP_ID", originalGithubAppId);
  restoreEnv("GITHUB_APP_PRIVATE_KEY", originalGithubAppPrivateKey);
  restoreEnv("GITHUB_APP_CLIENT_ID", originalGithubAppClientId);
  restoreEnv("GITHUB_APP_CLIENT_SECRET", originalGithubAppClientSecret);
  rmSync(tempDirectory, { recursive: true, force: true });
});

function insertUser(
  sqlite: typeof import("../db/index.js")["rawSqlite"],
  id: string,
  email: string,
) {
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO user
        (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, id, email, 1, "member", now, now);
}

describe("GitHub App user connections", () => {
  it("binds OAuth state to one user and consumes it only once", async () => {
    const { service, rawSqlite } = await loadRuntime();
    insertUser(rawSqlite, "user-a", "a@example.com");
    insertUser(rawSqlite, "user-b", "b@example.com");

    const flow = service.issueGithubOauthState("user-a", "//attacker.example/path");
    expect(flow.state).not.toContain("=");
    expect(flow.codeChallenge).not.toContain("=");
    expect(service.consumeGithubOauthState("user-b", flow.state)).toBeNull();

    const consumed = service.consumeGithubOauthState("user-a", flow.state);
    expect(consumed?.returnTo).toBe("/");
    expect(consumed?.codeVerifier.length).toBeGreaterThan(40);
    expect(service.consumeGithubOauthState("user-a", flow.state)).toBeNull();
  });

  it("returns only repositories where the user has write access", async () => {
    const { service, rawSqlite, encryptSecret } = await loadRuntime();
    insertUser(rawSqlite, "user-a", "a@example.com");
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO github_user_connections
          (user_id, github_user_id, github_login, access_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("user-a", "1", "alice", encryptSecret("user-token"), now, now);

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
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
                full_name: "alice/writeable",
                default_branch: "main",
                permissions: { push: true, pull: true },
              },
              {
                id: 102,
                full_name: "customer/read-only",
                default_branch: "main",
                permissions: { push: false, pull: true },
              },
            ],
          });
        }
        if (url.pathname === "/user/installations/11") {
          return Response.json({ id: 11, permissions: { contents: "write" } });
        }
        return Response.json({ message: "not found" }, { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.listGithubRepositoriesForUser("user-a")).resolves.toEqual([
      {
        repositoryId: "101",
        installationId: "11",
        fullName: "alice/writeable",
        defaultBranch: "main",
      },
    ]);
    await expect(service.getGithubRepositoryForUser("user-a", "11", "102")).rejects.toBeInstanceOf(
      service.GithubRepositoryAccessError,
    );

    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer user-token" });
    }
  });

  it("revokes the complete GitHub grant before deleting the local connection", async () => {
    const { service, rawSqlite, encryptSecret } = await loadRuntime();
    insertUser(rawSqlite, "user-a", "a@example.com");
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO github_user_connections
          (user_id, github_user_id, github_login, access_token, refresh_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "user-a",
        "1",
        "alice",
        encryptSecret("user-token"),
        encryptSecret("refresh-token"),
        now,
        now,
      );
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await service.disconnectGithubUser("user-a");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe("https://api.github.com/applications/Iv1.test-client/grant");
    expect(init).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ access_token: "user-token" }),
    });
    expect(
      rawSqlite
        .prepare("SELECT user_id FROM github_user_connections WHERE user_id = ?")
        .get("user-a"),
    ).toBeUndefined();
  });

  it.each([404, 503])(
    "keeps the local connection when GitHub grant revocation returns HTTP %s",
    async (status) => {
      const { service, rawSqlite, encryptSecret } = await loadRuntime();
      insertUser(rawSqlite, "user-a", "a@example.com");
      const now = Date.now();
      rawSqlite
        .prepare(
          `INSERT INTO github_user_connections
          (user_id, github_user_id, github_login, access_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("user-a", "1", "alice", encryptSecret("user-token"), now, now);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({}, { status })),
      );

      await expect(service.disconnectGithubUser("user-a")).rejects.toThrow(/revocation failed/);
      expect(
        rawSqlite
          .prepare("SELECT user_id FROM github_user_connections WHERE user_id = ?")
          .get("user-a"),
      ).toEqual({ user_id: "user-a" });
    },
  );

  it("refreshes a near-expiry access token before revoking the grant", async () => {
    const { service, rawSqlite, encryptSecret } = await loadRuntime();
    insertUser(rawSqlite, "user-a", "a@example.com");
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO github_user_connections
          (user_id, github_user_id, github_login, access_token, refresh_token,
           access_token_expires_at, refresh_token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "user-a",
        "1",
        "alice",
        encryptSecret("nearly-expired-token"),
        encryptSecret("refresh-token"),
        now + 30_000,
        now + 60_000,
        now,
        now,
      );
    const revokedTokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("refresh_token");
          return Response.json({
            access_token: "fresh-token",
            expires_in: 28_800,
            refresh_token: "rotated-refresh-token",
            refresh_token_expires_in: 15_897_600,
          });
        }
        if (url.endsWith("/applications/Iv1.test-client/grant")) {
          revokedTokens.push(
            (JSON.parse(String(init?.body)) as { access_token: string }).access_token,
          );
          return new Response(null, { status: 204 });
        }
        return Response.json({}, { status: 404 });
      }),
    );

    await service.disconnectGithubUser("user-a");

    expect(revokedTokens).toEqual(["fresh-token"]);
    expect(
      rawSqlite
        .prepare("SELECT user_id FROM github_user_connections WHERE user_id = ?")
        .get("user-a"),
    ).toBeUndefined();
  });

  it("waits for an in-flight reconnect and revokes the newest grant", async () => {
    const { service, rawSqlite, encryptSecret } = await loadRuntime();
    insertUser(rawSqlite, "user-a", "a@example.com");
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO github_user_connections
          (user_id, github_user_id, github_login, access_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("user-a", "1", "alice", encryptSecret("old-token"), now, now);

    let releaseExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const revokedTokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          await exchangeGate;
          return Response.json({ access_token: "new-token" });
        }
        if (url === "https://api.github.com/user") {
          return Response.json({ id: 1, login: "alice" });
        }
        if (url.endsWith("/applications/Iv1.test-client/grant")) {
          revokedTokens.push(
            (JSON.parse(String(init?.body)) as { access_token: string }).access_token,
          );
          return new Response(null, { status: 204 });
        }
        return Response.json({}, { status: 404 });
      }),
    );

    const reconnect = service.completeGithubConnection({
      userId: "user-a",
      code: "oauth-code",
      codeVerifier: "pkce-verifier",
      redirectUri: "https://quillra.test/api/github/connect/callback",
    });
    const disconnect = service.disconnectGithubUser("user-a");
    releaseExchange();

    await expect(reconnect).resolves.toEqual({ githubLogin: "alice" });
    await expect(disconnect).resolves.toBeUndefined();
    expect(revokedTokens).toEqual(["new-token"]);
    expect(
      rawSqlite
        .prepare("SELECT user_id FROM github_user_connections WHERE user_id = ?")
        .get("user-a"),
    ).toBeUndefined();
  });

  async function runRefreshReconnectRace(mode: "disconnect" | "reset") {
    const { service, rawSqlite, encryptSecret } = await loadRuntime();
    insertUser(rawSqlite, "user-a", "a@example.com");
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO github_user_connections
          (user_id, github_user_id, github_login, access_token, refresh_token,
           access_token_expires_at, refresh_token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "user-a",
        "1",
        "alice",
        encryptSecret("expired-token"),
        encryptSecret("refresh-token"),
        now - 1,
        now + 60_000,
        now,
        now,
      );

    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let releaseReconnect!: () => void;
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    let markReconnectStarted!: () => void;
    const reconnectStarted = new Promise<void>((resolve) => {
      markReconnectStarted = resolve;
    });
    const revokedTokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          const params = new URLSearchParams(String(init?.body));
          if (params.get("grant_type") === "refresh_token") {
            await refreshGate;
            return Response.json({
              access_token: "refreshed-token",
              expires_in: 28_800,
              refresh_token: "rotated-refresh-token",
              refresh_token_expires_in: 15_897_600,
            });
          }
          markReconnectStarted();
          await reconnectGate;
          return Response.json({ access_token: "reconnected-token" });
        }
        if (url === "https://api.github.com/user") {
          return Response.json({ id: 1, login: "alice" });
        }
        if (url.endsWith("/applications/Iv1.test-client/grant")) {
          revokedTokens.push(
            (JSON.parse(String(init?.body)) as { access_token: string }).access_token,
          );
          return new Response(null, { status: 204 });
        }
        return Response.json({}, { status: 404 });
      }),
    );

    const refresh = service.getGithubUserAccessToken("user-a");
    const reconnect = service.completeGithubConnection({
      userId: "user-a",
      code: "oauth-code",
      codeVerifier: "pkce-verifier",
      redirectUri: "https://quillra.test/api/github/connect/callback",
    });
    const finalize = vi.fn();
    const lifecycle =
      mode === "disconnect"
        ? service.disconnectGithubUser("user-a")
        : service.disconnectAllGithubUsers(finalize);

    releaseRefresh();
    await reconnectStarted;
    expect(revokedTokens).toEqual([]);
    releaseReconnect();

    await expect(refresh).resolves.toBe("refreshed-token");
    await expect(reconnect).resolves.toEqual({ githubLogin: "alice" });
    await expect(lifecycle).resolves.toBeUndefined();
    expect(revokedTokens).toEqual(["reconnected-token"]);
    expect(
      rawSqlite
        .prepare("SELECT user_id FROM github_user_connections WHERE user_id = ?")
        .get("user-a"),
    ).toBeUndefined();
    if (mode === "reset") expect(finalize).toHaveBeenCalledOnce();
  }

  it("tracks a refresh-waiting reconnect before disconnect starts", async () => {
    await runRefreshReconnectRace("disconnect");
  });

  it("tracks a refresh-waiting reconnect before bulk reset starts", async () => {
    await runRefreshReconnectRace("reset");
  });

  it("revokes every user grant before finalizing an App reset", async () => {
    const { service, rawSqlite, encryptSecret } = await loadRuntime();
    insertUser(rawSqlite, "user-a", "a@example.com");
    insertUser(rawSqlite, "user-b", "b@example.com");
    const now = Date.now();
    const insertConnection = rawSqlite.prepare(
      `INSERT INTO github_user_connections
        (user_id, github_user_id, github_login, access_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertConnection.run("user-a", "1", "alice", encryptSecret("token-a"), now, now);
    insertConnection.run("user-b", "2", "bob", encryptSecret("token-b"), now, now);

    const revokedTokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        revokedTokens.push(
          (JSON.parse(String(init?.body)) as { access_token: string }).access_token,
        );
        return new Response(null, { status: 204 });
      }),
    );
    let finalized = false;

    await service.disconnectAllGithubUsers(() => {
      finalized = true;
    });

    expect(revokedTokens.sort()).toEqual(["token-a", "token-b"]);
    expect(finalized).toBe(true);
    expect(rawSqlite.prepare("SELECT user_id FROM github_user_connections").all()).toHaveLength(0);
  });

  it("keeps App credentials available for retry when a bulk revocation fails", async () => {
    const { service, rawSqlite, encryptSecret } = await loadRuntime();
    insertUser(rawSqlite, "user-a", "a@example.com");
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO github_user_connections
          (user_id, github_user_id, github_login, access_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("user-a", "1", "alice", encryptSecret("token-a"), now, now);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 503 })),
    );
    const finalize = vi.fn();

    await expect(service.disconnectAllGithubUsers(finalize)).rejects.toThrow(/revocation failed/);

    expect(finalize).not.toHaveBeenCalled();
    expect(rawSqlite.prepare("SELECT user_id FROM github_user_connections").all()).toEqual([
      { user_id: "user-a" },
    ]);
  });

  it("invalidates stale local grants without a network call when the App is gone", async () => {
    const { service, rawSqlite, encryptSecret } = await loadRuntime();
    insertUser(rawSqlite, "user-a", "a@example.com");
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO github_user_connections
          (user_id, github_user_id, github_login, access_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("user-a", "1", "alice", encryptSecret("token-a"), now, now);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const finalize = vi.fn();

    await service.invalidateAllGithubUsers(finalize);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
    expect(rawSqlite.prepare("SELECT user_id FROM github_user_connections").all()).toHaveLength(0);
  });
});
