import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../lib/auth.js";

const workspaceMocks = vi.hoisted(() => ({
  beginProjectDeletion: vi.fn(),
  cancelProjectDeletion: vi.fn(),
  clearProjectRepoClone: vi.fn(),
  destroyProjectExecution: vi.fn(),
  scheduleDeletedProjectWorkspaceCleanup: vi.fn(),
}));

vi.mock("../../services/workspace.js", () => workspaceMocks);
vi.mock("../../services/branding.js", () => ({
  getProjectBrandContext: vi.fn(),
}));

const controlledEnvironmentKeys = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "NODE_ENV",
] as const;
const originalEnvironment = new Map(
  controlledEnvironmentKeys.map((key) => [key, process.env[key]]),
);

let tempDirectory: string;
let openDatabase: typeof import("../../db/index.js")["rawSqlite"] | null = null;

function restoreEnvironment() {
  for (const key of controlledEnvironmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-project-delete-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "quillra-project-delete-test-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.NODE_ENV = "test";
  for (const mock of Object.values(workspaceMocks)) mock.mockReset();
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function createApp() {
  const [{ rawSqlite }, { crudRouter }] = await Promise.all([
    import("../../db/index.js"),
    import("./crud.js"),
  ]);
  openDatabase = rawSqlite;
  const now = Date.now();
  rawSqlite
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('owner-1', 'Owner', 'owner@example.com', 1, ?, ?)`,
    )
    .run(now, now);
  rawSqlite
    .prepare(
      `INSERT INTO projects (id, name, github_repo_full_name, created_at, updated_at)
       VALUES ('project-1', 'Project One', 'example/site', ?, ?)`,
    )
    .run(now, now);
  rawSqlite
    .prepare(
      `INSERT INTO project_members (id, project_id, user_id, role, created_at)
       VALUES ('membership-1', 'project-1', 'owner-1', 'admin', ?)`,
    )
    .run(now);

  type Variables = {
    user: SessionUser | null;
    clientSession: { projectId: string } | null;
  };
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "owner-1",
      name: "Owner",
      email: "owner@example.com",
    } as SessionUser);
    c.set("clientSession", null);
    await next();
  });
  app.route("/projects", crudRouter);
  return { app, rawSqlite };
}

describe("project deletion", () => {
  it("returns immediately after the database delete while cleanup continues", async () => {
    const { app, rawSqlite } = await createApp();
    workspaceMocks.scheduleDeletedProjectWorkspaceCleanup.mockReturnValue(
      new Promise<void>(() => {}),
    );

    const response = await app.request("/projects/project-1", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(workspaceMocks.destroyProjectExecution).toHaveBeenCalledWith("project-1", 1);
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({ count: 0 });
    expect(workspaceMocks.scheduleDeletedProjectWorkspaceCleanup).toHaveBeenCalledWith("project-1");
  });

  it("commits the database delete before scheduling workspace cleanup", async () => {
    const { app, rawSqlite } = await createApp();
    workspaceMocks.scheduleDeletedProjectWorkspaceCleanup.mockImplementation(() => {
      expect(
        rawSqlite.prepare("SELECT 1 FROM projects WHERE id = 'project-1'").get(),
      ).toBeUndefined();
      return Promise.resolve();
    });

    const response = await app.request("/projects/project-1", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(workspaceMocks.beginProjectDeletion).toHaveBeenCalledWith("project-1");
    expect(workspaceMocks.scheduleDeletedProjectWorkspaceCleanup).toHaveBeenCalledWith("project-1");
    expect(workspaceMocks.cancelProjectDeletion).not.toHaveBeenCalled();
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({ count: 0 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM project_members").get()).toEqual({
      count: 0,
    });
  });

  it("keeps the project row when the remote sandbox cannot be destroyed", async () => {
    const { app, rawSqlite } = await createApp();
    workspaceMocks.destroyProjectExecution.mockRejectedValue(
      new Error("E2B sandbox destruction was not confirmed."),
    );

    const response = await app.request("/projects/project-1", { method: "DELETE" });

    expect(response.status).toBe(500);
    expect(workspaceMocks.cancelProjectDeletion).toHaveBeenCalledWith("project-1");
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({
      count: 1,
    });
    expect(workspaceMocks.scheduleDeletedProjectWorkspaceCleanup).not.toHaveBeenCalled();
  });
});
