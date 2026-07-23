import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../lib/auth.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalEncryptionKey = process.env.QUILLRA_ENCRYPTION_KEY;

let tempDirectory: string;
let openDatabase: typeof import("../../db/index.js")["rawSqlite"] | null = null;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-project-binding-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "project-binding-test-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "c".repeat(64);
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
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function createApp() {
  vi.resetModules();
  const [{ rawSqlite }, { crudRouter }, { encryptSecret }] = await Promise.all([
    import("../../db/index.js"),
    import("./crud.js"),
    import("../../services/crypto.js"),
  ]);
  openDatabase = rawSqlite;
  const now = Date.now();
  rawSqlite
    .prepare(
      `INSERT INTO user
        (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("user-1", "Alice", "alice@example.com", 1, "member", now, now);
  rawSqlite
    .prepare(
      `INSERT INTO github_user_connections
        (user_id, github_user_id, github_login, access_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("user-1", "1", "alice", encryptSecret("user-token"), now, now);

  type TestVariables = {
    user: SessionUser | null;
    clientSession: { projectId: string } | null;
  };
  const app = new Hono<{ Variables: TestVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
    } as SessionUser);
    c.set("clientSession", null);
    await next();
  });
  app.route("/projects", crudRouter);
  return { app, rawSqlite };
}

function stubGithub() {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer user-token" });
      const url = new URL(String(input));
      if (url.pathname === "/user/installations/11/repositories") {
        return Response.json({
          repositories: [
            {
              id: 101,
              full_name: "alice/canonical-site",
              default_branch: "main",
              permissions: { push: true, pull: true },
            },
            {
              id: 102,
              full_name: "customer/read-only",
              default_branch: "main",
              permissions: { push: false, pull: true },
            },
            {
              id: 103,
              full_name: "alice/second-site",
              default_branch: "main",
              permissions: { push: true, pull: true },
            },
          ],
        });
      }
      if (url.pathname === "/user/installations/11") {
        return Response.json({ id: 11, permissions: { contents: "write" } });
      }
      if (
        url.pathname === "/repos/alice/canonical-site/branches" ||
        url.pathname === "/repos/alice/second-site/branches"
      ) {
        return Response.json([{ name: "main" }]);
      }
      return Response.json({ message: "not found" }, { status: 404 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("project GitHub bindings", () => {
  it("ignores a client-supplied repo name and persists GitHub's immutable binding", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();

    const response = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Canonical project",
        githubRepoFullName: "attacker/arbitrary-name",
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(
      rawSqlite
        .prepare(
          `SELECT github_repo_full_name, github_installation_id, github_repository_id
             FROM projects WHERE id = ?`,
        )
        .get(id),
    ).toEqual({
      github_repo_full_name: "alice/canonical-site",
      github_installation_id: "11",
      github_repository_id: "101",
    });

    const membership = rawSqlite
      .prepare("SELECT user_id, role FROM project_members WHERE project_id = ?")
      .get(id);
    expect(membership).toEqual({ user_id: "user-1", role: "admin" });
  });

  it("rejects read-only repositories and generic repository rebinding", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();

    const readOnly = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Read only",
        githubInstallationId: "11",
        githubRepositoryId: "102",
        defaultBranch: "main",
      }),
    });
    expect(readOnly.status).toBe(403);
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({
      count: 0,
    });

    rawSqlite
      .prepare(
        `INSERT INTO projects
          (id, name, github_repo_full_name, github_installation_id, github_repository_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("project-1", "Existing", "alice/canonical-site", "11", "101");
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, ?)`,
      )
      .run("member-1", "project-1", "user-1", "admin");

    const bypass = await app.request("/projects/project-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubRepoFullName: "attacker/repo" }),
    });
    expect(bypass.status).toBe(400);
    expect(
      rawSqlite.prepare("SELECT github_repo_full_name FROM projects WHERE id = ?").get("project-1"),
    ).toEqual({ github_repo_full_name: "alice/canonical-site" });
  });

  it("increments the binding generation across an A to B to A rebind", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    rawSqlite
      .prepare(
        `INSERT INTO projects
          (id, name, github_repo_full_name, github_installation_id, github_repository_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("project-1", "Existing", "alice/canonical-site", "11", "101");
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, ?)`,
      )
      .run("member-1", "project-1", "user-1", "admin");

    for (const repositoryId of ["103", "101"]) {
      const response = await app.request("/projects/project-1/github/rebind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubInstallationId: "11",
          githubRepositoryId: repositoryId,
          defaultBranch: "main",
        }),
      });
      expect(response.status).toBe(200);
    }

    expect(
      rawSqlite
        .prepare(
          `SELECT github_repository_id, github_binding_generation
             FROM projects WHERE id = ?`,
        )
        .get("project-1"),
    ).toEqual({
      github_repository_id: "101",
      github_binding_generation: 3,
    });
  });
});
