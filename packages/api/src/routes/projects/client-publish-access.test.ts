import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../lib/auth.js";

const workspaceMocks = vi.hoisted(() => ({
  authenticatedGitForProject: vi.fn(),
  ensureRepoCloned: vi.fn(),
  projectRepoPath: vi.fn(),
  pushToGitHub: vi.fn(),
  runInProjectLock: vi.fn(),
  simpleGitForProject: vi.fn(),
}));

vi.mock("../../services/workspace.js", () => workspaceMocks);

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "NODE_ENV",
  "ANTHROPIC_API_KEY",
] as const;

const originalEnvironment = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));

let tempDirectory: string;
let openDatabase: typeof import("../../db/index.js")["rawSqlite"] | null = null;

function restoreEnvironment() {
  for (const key of CONTROLLED_ENV_KEYS) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-client-publish-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "quillra-client-publish-test-auth-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.NODE_ENV = "test";
  Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");

  for (const mock of Object.values(workspaceMocks)) mock.mockReset();
  workspaceMocks.ensureRepoCloned.mockResolvedValue(path.join(tempDirectory, "repo"));
  workspaceMocks.simpleGitForProject.mockReturnValue({
    status: vi.fn().mockResolvedValue({
      modified: [],
      created: [],
      not_added: [],
      deleted: [],
    }),
  });
  workspaceMocks.runInProjectLock.mockImplementation(
    async (_projectId: string, operation: () => Promise<unknown>) => operation(),
  );
  workspaceMocks.pushToGitHub.mockResolvedValue({
    ok: true,
    message: "Published by the Quillra GitHub App",
  });
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function createClientApp() {
  vi.resetModules();
  const [{ rawSqlite }, { publishRouter }, { githubRouter }] = await Promise.all([
    import("../../db/index.js"),
    import("./publish.js"),
    import("../github.js"),
  ]);
  openDatabase = rawSqlite;
  const now = Date.now();

  rawSqlite
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('client-1', 'Client One', 'client@example.com', 1, ?, ?)`,
    )
    .run(now, now);
  rawSqlite
    .prepare(
      `INSERT INTO projects
         (id, name, github_repo_full_name, github_installation_id, github_repository_id,
          default_branch, created_at, updated_at)
       VALUES
         ('project-1', 'Pinned project', 'example/pinned', '11', '101', 'main', ?, ?),
         ('project-2', 'Other project', 'example/other', '22', '202', 'main', ?, ?)`,
    )
    .run(now, now, now, now);
  rawSqlite
    .prepare(
      `INSERT INTO project_members (id, project_id, user_id, role, created_at)
       VALUES ('member-pinned', 'project-1', 'client-1', 'client', ?)`,
    )
    .run(now);

  type Variables = {
    user: SessionUser | null;
    clientSession: { projectId: string } | null;
  };
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "client-1",
      name: "Client One",
      email: "client@example.com",
    } as SessionUser);
    c.set("clientSession", { projectId: "project-1" });
    await next();
  });
  app.route("/projects", publishRouter);
  app.route("/github", githubRouter);

  return { app, rawSqlite };
}

describe("client publish access", () => {
  it("publishes the pinned project through the App without personal GitHub access", async () => {
    const { app, rawSqlite } = await createClientApp();

    expect(
      rawSqlite.prepare("SELECT count(*) AS count FROM github_user_connections").get(),
    ).toEqual({ count: 0 });

    const publish = await app.request("/projects/project-1/publish", { method: "POST" });
    expect(publish.status).toBe(200);
    await expect(publish.json()).resolves.toEqual({
      ok: true,
      message: "Published by the Quillra GitHub App",
    });
    expect(workspaceMocks.ensureRepoCloned).toHaveBeenCalledWith(
      "project-1",
      "example/pinned",
      "main",
      { expectedBindingGeneration: 1 },
    );
    expect(workspaceMocks.pushToGitHub).toHaveBeenCalledWith(
      "project-1",
      path.join(tempDirectory, "repo"),
      "main",
      "example/pinned",
      { name: "Client One", email: "client@example.com" },
      null,
    );

    const outsideProject = await app.request("/projects/project-2/publish", { method: "POST" });
    expect(outsideProject.status).toBe(404);
    expect(workspaceMocks.ensureRepoCloned).toHaveBeenCalledTimes(1);
    expect(workspaceMocks.pushToGitHub).toHaveBeenCalledTimes(1);

    expect((await app.request("/github/connection")).status).toBe(403);
    expect((await app.request("/github/connect/start?returnTo=/")).status).toBe(403);
    expect((await app.request("/github/repos")).status).toBe(403);
    expect((await app.request("/github/connection", { method: "DELETE" })).status).toBe(403);

    expect(
      rawSqlite.prepare("SELECT count(*) AS count FROM github_user_connections").get(),
    ).toEqual({ count: 0 });
  });
});
