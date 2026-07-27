import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../lib/auth.js";

const workspaceMocks = vi.hoisted(() => ({
  ensureRepoCloned: vi.fn(),
  getPackageManager: vi.fn(),
  getPreviewAddress: vi.fn(),
  getPreviewLogs: vi.fn(),
  getPreviewProcessInfo: vi.fn(),
  projectRepoPath: vi.fn(),
  reinstallProjectDependencies: vi.fn(),
  reserveAvailablePreviewPort: vi.fn(),
  resolveDevCommand: vi.fn(),
  runInProjectLock: vi.fn(),
  simpleGitForProject: vi.fn(),
  startDevPreview: vi.fn(),
  stopPreview: vi.fn(),
}));

vi.mock("../../services/workspace.js", () => workspaceMocks);

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "NODE_ENV",
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
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-preview-start-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "quillra-preview-start-test-auth-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.NODE_ENV = "test";

  for (const mock of Object.values(workspaceMocks)) mock.mockReset();
  workspaceMocks.ensureRepoCloned.mockResolvedValue(path.join(tempDirectory, "repo"));
  workspaceMocks.startDevPreview.mockResolvedValue({ port: 4_321, label: "Vite" });
  workspaceMocks.reserveAvailablePreviewPort.mockResolvedValue(4_321);
  workspaceMocks.projectRepoPath.mockReturnValue(path.join(tempDirectory, "repo"));
  workspaceMocks.getPreviewProcessInfo.mockReturnValue({
    running: true,
    pid: 42,
    exitCode: null,
    signalCode: null,
  });
  workspaceMocks.getPreviewAddress.mockReturnValue({
    url: "https://preview.example.test",
    mode: "host",
  });
  workspaceMocks.runInProjectLock.mockImplementation(
    async (_projectId: string, operation: () => Promise<unknown>) => operation(),
  );
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function createPreviewApp() {
  vi.resetModules();
  const [{ rawSqlite }, { previewRouter }, previewStatus] = await Promise.all([
    import("../../db/index.js"),
    import("./preview.js"),
    import("../../services/preview-status.js"),
  ]);
  openDatabase = rawSqlite;
  const now = Date.now();

  rawSqlite
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('editor-1', 'Editor One', 'editor@example.com', 1, ?, ?)`,
    )
    .run(now, now);
  rawSqlite
    .prepare(
      `INSERT INTO projects
         (id, name, github_repo_full_name, github_binding_generation, default_branch,
          created_at, updated_at)
       VALUES ('project-1', 'Preview project', 'example/site', 1, 'main', ?, ?)`,
    )
    .run(now, now);
  rawSqlite
    .prepare(
      `INSERT INTO project_members (id, project_id, user_id, role, created_at)
       VALUES ('member-1', 'project-1', 'editor-1', 'editor', ?)`,
    )
    .run(now);

  type Variables = {
    user: SessionUser | null;
    clientSession: { projectId: string } | null;
  };
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "editor-1",
      name: "Editor One",
      email: "editor@example.com",
    } as SessionUser);
    c.set("clientSession", null);
    await next();
  });
  app.route("/projects", previewRouter);
  return { app, previewStatus };
}

describe("preview start", () => {
  it("skips the redundant workspace install and lets the isolated preview install once", async () => {
    const { app } = await createPreviewApp();

    const response = await app.request("/projects/project-1/preview", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://preview.example.test",
      previewMode: "host",
      port: 4_321,
      previewLabel: "Vite",
    });
    expect(workspaceMocks.ensureRepoCloned).toHaveBeenCalledWith(
      "project-1",
      "example/site",
      "main",
      {
        expectedBindingGeneration: 1,
        skipInstall: true,
      },
    );
    expect(workspaceMocks.startDevPreview).toHaveBeenCalledWith(
      "project-1",
      path.join(tempDirectory, "repo"),
      null,
      1,
    );
    expect(workspaceMocks.stopPreview).not.toHaveBeenCalled();
  });

  it("reports an in-progress preview so reopening the editor does not restart it", async () => {
    const { app } = await createPreviewApp();

    const response = await app.request("/projects/project-1/preview-meta");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://preview.example.test",
      previewMode: "host",
      previewActive: false,
      previewStarting: true,
      port: 4_321,
      previewLabel: "-",
    });
  });

  it("preserves a terminal preview error reported by the lifecycle owner", async () => {
    const { app, previewStatus } = await createPreviewApp();
    workspaceMocks.startDevPreview.mockImplementationOnce(async () => {
      previewStatus.setPreviewStatus("project-1", "error", "Dev server exited with code 1");
      throw new Error("The E2B dev server exited during startup with code 1.");
    });

    const response = await app.request("/projects/project-1/preview", { method: "POST" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "The E2B dev server exited during startup with code 1.",
    });
    expect(previewStatus.getPreviewStatus("project-1")).toMatchObject({
      stage: "error",
      message: "Dev server exited with code 1",
    });
  });

  it("does not let a stale request overwrite the replacement preview status", async () => {
    const { app, previewStatus } = await createPreviewApp();
    previewStatus.setPreviewStatus("project-1", "ready", "Current preview");
    workspaceMocks.runInProjectLock.mockRejectedValueOnce(
      new Error("The project GitHub repository changed while this request was running."),
    );

    const response = await app.request("/projects/project-1/preview", { method: "POST" });

    expect(response.status).toBe(500);
    expect(previewStatus.getPreviewStatus("project-1")).toMatchObject({
      stage: "ready",
      message: "Current preview",
    });
    expect(workspaceMocks.ensureRepoCloned).not.toHaveBeenCalled();
    expect(workspaceMocks.startDevPreview).not.toHaveBeenCalled();
  });
});
