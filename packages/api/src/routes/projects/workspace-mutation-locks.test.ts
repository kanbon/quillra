import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../lib/auth.js";

const workspaceMocks = vi.hoisted(() => ({
  authenticatedGitForProject: vi.fn(),
  ensureQuillraTempIgnored: vi.fn(),
  ensureRepoCloned: vi.fn(),
  projectRepoPath: vi.fn(),
  pushToGitHub: vi.fn(),
  runInProjectLock: vi.fn(),
  simpleGitForProject: vi.fn(),
}));

const frameworkMocks = vi.hoisted(() => ({
  detectFramework: vi.fn(() => ({ id: "generic", name: "Generic", optimizes: true })),
}));

vi.mock("../../services/workspace.js", () => ({
  QUILLRA_TEMP_DIR: ".quillra-temp",
  ...workspaceMocks,
}));
vi.mock("../../services/framework.js", () => frameworkMocks);

const controlledEnvironmentKeys = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "NODE_ENV",
  "ANTHROPIC_API_KEY",
] as const;
const originalEnvironment = new Map(
  controlledEnvironmentKeys.map((key) => [key, process.env[key]]),
);

let tempDirectory: string;
let repoPath: string;
let lockActive = false;
let openDatabase: typeof import("../../db/index.js")["rawSqlite"] | null = null;

function restoreEnvironment() {
  for (const key of controlledEnvironmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

function locked<T extends unknown[], R>(result: R) {
  return vi.fn(async (..._args: T) => {
    expect(lockActive).toBe(true);
    return result;
  });
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-workspace-route-locks-"));
  repoPath = path.join(tempDirectory, "repo");
  fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "quillra-workspace-route-locks-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.NODE_ENV = "test";
  lockActive = false;

  for (const mock of Object.values(workspaceMocks)) mock.mockReset();
  frameworkMocks.detectFramework.mockClear();
  workspaceMocks.ensureRepoCloned.mockResolvedValue(repoPath);
  workspaceMocks.projectRepoPath.mockReturnValue(repoPath);
  workspaceMocks.runInProjectLock.mockImplementation(
    async (_projectId: string, operation: () => Promise<unknown>) => {
      expect(lockActive).toBe(false);
      lockActive = true;
      try {
        return await operation();
      } finally {
        lockActive = false;
      }
    },
  );
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function createApp() {
  vi.resetModules();
  const [{ rawSqlite }, { filesRouter }, { publishRouter }] = await Promise.all([
    import("../../db/index.js"),
    import("./files.js"),
    import("./publish.js"),
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
      `INSERT INTO projects
         (id, name, github_repo_full_name, default_branch, migration_target, created_at, updated_at)
       VALUES ('project-1', 'Project One', 'example/site', 'main', 'astro', ?, ?)`,
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
  app.route("/projects", filesRouter);
  app.route("/projects", publishRouter);
  return app;
}

describe("project workspace mutation locking", () => {
  it("writes uploads and deletes assets only while holding the project lock", async () => {
    const app = await createApp();
    const originalWriteFile = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (String(target).startsWith(repoPath)) expect(lockActive).toBe(true);
      return originalWriteFile(target, data, options);
    });
    workspaceMocks.ensureQuillraTempIgnored.mockImplementation(() => {
      expect(lockActive).toBe(true);
    });

    const form = new FormData();
    form.set("file", new File(["# Updated copy"], "copy.md", { type: "text/markdown" }));
    const upload = await app.request("/projects/project-1/upload", {
      method: "POST",
      body: form,
    });

    expect(upload.status).toBe(200);
    expect(workspaceMocks.runInProjectLock).toHaveBeenCalledWith("project-1", expect.any(Function));
    expect(workspaceMocks.ensureQuillraTempIgnored).toHaveBeenCalledWith(repoPath);
    expect(writeSpy).toHaveBeenCalled();

    const assetPath = path.join(repoPath, "public", "old.png");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    originalWriteFile(assetPath, "old");
    const originalUnlink = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (String(target).startsWith(repoPath)) expect(lockActive).toBe(true);
      return originalUnlink(target);
    });

    const deleted = await app.request("/projects/project-1/asset-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "public/old.png" }),
    });

    expect(deleted.status).toBe(200);
    expect(unlinkSpy).toHaveBeenCalledWith(assetPath);
    expect(fs.existsSync(assetPath)).toBe(false);
  });

  it("does not write an authorized upload when lifecycle locking rejects it", async () => {
    const app = await createApp();
    workspaceMocks.runInProjectLock.mockRejectedValueOnce(new Error("Project is being deleted"));
    const form = new FormData();
    form.set("file", new File(["content"], "copy.md", { type: "text/markdown" }));

    const response = await app.request("/projects/project-1/upload", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(500);
    expect(workspaceMocks.ensureQuillraTempIgnored).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repoPath, ".quillra-temp"))).toBe(false);
  });

  it("keeps discard, migration cleanup, and publish Git operations inside the lock", async () => {
    const app = await createApp();
    const git = {
      fetch: locked<[string, string], undefined>(undefined),
      branch: locked<[string[]], { all: string[] }>({ all: ["origin/main"] }),
      reset: locked<[string[]], undefined>(undefined),
      clean: locked<[string], undefined>(undefined),
      status: locked<
        [],
        {
          modified: string[];
          created: string[];
          not_added: string[];
          deleted: string[];
        }
      >({ modified: ["src/page.ts"], created: [], not_added: [], deleted: [] }),
      diff: locked<[string[]], string>("src/page.ts | 1 +"),
    };
    workspaceMocks.authenticatedGitForProject.mockImplementation(async () => {
      expect(lockActive).toBe(true);
      return git;
    });
    workspaceMocks.simpleGitForProject.mockImplementation(() => {
      expect(lockActive).toBe(true);
      return git;
    });
    workspaceMocks.pushToGitHub.mockImplementation(async () => {
      expect(lockActive).toBe(true);
      return { ok: true, message: "Published" };
    });
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        expect(lockActive).toBe(false);
        return Response.json({ content: [{ text: "Update the project page" }] });
      }),
    );

    const discarded = await app.request("/projects/project-1/discard-changes", {
      method: "POST",
    });
    expect(discarded.status).toBe(200);
    expect(git.reset).toHaveBeenCalledWith(["--hard", "origin/main"]);
    expect(git.clean).toHaveBeenCalledWith("fd");

    const canceled = await app.request("/projects/project-1/cancel-migration", {
      method: "POST",
    });
    expect(canceled.status).toBe(200);
    expect(workspaceMocks.projectRepoPath).toHaveBeenCalledWith("project-1");

    const published = await app.request("/projects/project-1/publish", {
      method: "POST",
    });
    expect(published.status).toBe(200);
    expect(workspaceMocks.pushToGitHub).toHaveBeenCalledWith(
      repoPath,
      "main",
      "example/site",
      { name: "Owner", email: "owner@example.com" },
      "Update the project page",
    );
    expect(workspaceMocks.runInProjectLock).toHaveBeenCalledTimes(4);
  });
});
