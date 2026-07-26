import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloneMock = vi.hoisted(() => vi.fn());
const e2bRuntimeMock = vi.hoisted(() => ({
  destroyProject: vi.fn(async () => undefined),
  getPreviewAccess: vi.fn(async () => ({
    origin: "https://preview.example.test",
    headers: { "e2b-traffic-access-token": "test-preview-token" },
  })),
  runCommand: vi.fn(),
  startPreview: vi.fn(async () => ({ pid: 42, port: 4321 })),
  stopPreview: vi.fn(async () => undefined),
}));

vi.mock("simple-git", () => ({
  simpleGit: () => ({
    env: () => ({
      clone: cloneMock,
    }),
  }),
}));

vi.mock("./github-app.js", () => ({
  requireGithubAppBotIdentity: vi.fn(async () => ({
    name: "quillra-test[bot]",
    email: "123+quillra-test[bot]@users.noreply.github.com",
  })),
}));

vi.mock("./project-github-token.js", () => ({
  assertProjectGithubBinding: vi.fn(async () => undefined),
  resolveProjectGitToken: vi.fn(async () => ({
    token: "test-installation-token",
    fullName: "example/site",
  })),
}));

vi.mock("./e2b-runtime.js", () => ({
  getDefaultE2BRuntime: () => e2bRuntimeMock,
}));

import { rawSqlite } from "../db/index.js";
import {
  beginProjectWriterAuthorizationChange,
  cancelAndWaitForProjectWriters,
  projectWriterAuthorizationEpoch,
  registerProjectWriter,
} from "./project-workspace-lifecycle.js";
import {
  beginProjectDeletion,
  clearProjectRepoClone,
  ensureRepoCloned,
  getPreviewProcessInfo,
  projectRepoPath,
  removeDeletedProjectWorkspace,
  runInProjectLock,
  scheduleDeletedProjectWorkspaceCleanup,
  startDevPreview,
  sweepOrphanedProjectWorkspaces,
} from "./workspace.js";

const originalWorkspaceDirectory = process.env.WORKSPACE_DIR;
const cleanupProjectIds = new Set<string>();
let tempDirectory: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quillra-workspace-lifecycle-"));
  process.env.WORKSPACE_DIR = path.join(tempDirectory, "workspaces");
  cloneMock.mockReset();
  for (const mock of Object.values(e2bRuntimeMock)) mock.mockClear();
});

afterEach(async () => {
  for (const projectId of cleanupProjectIds) {
    beginProjectDeletion(projectId);
    await removeDeletedProjectWorkspace(projectId).catch(() => undefined);
  }
  for (const projectId of cleanupProjectIds) {
    rawSqlite.prepare("DELETE FROM project_sandboxes WHERE project_id = ?").run(projectId);
    rawSqlite.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  }
  cleanupProjectIds.clear();
  if (originalWorkspaceDirectory === undefined) {
    Reflect.deleteProperty(process.env, "WORKSPACE_DIR");
  } else {
    process.env.WORKSPACE_DIR = originalWorkspaceDirectory;
  }
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

function ensureProjectRow(projectId: string): void {
  rawSqlite
    .prepare(
      `INSERT OR IGNORE INTO projects
         (id, name, github_repo_full_name, github_binding_generation, default_branch)
       VALUES (?, ?, 'example/site', 1, 'main')`,
    )
    .run(projectId, projectId);
}

describe("project workspace lifecycle", () => {
  it("rejects cleanup paths that escape the managed workspace root", () => {
    expect(() => projectRepoPath("../outside")).toThrow("Invalid project workspace path");
    expect(() => projectRepoPath("nested/project")).toThrow("Invalid project workspace path");
  });

  it("removes a partial non-git clone before cloning again", async () => {
    const projectId = "partial-clone";
    cleanupProjectIds.add(projectId);
    const repoPath = projectRepoPath(projectId);
    const staleFile = path.join(repoPath, "node_modules", ".vite", "stale");
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, "partial");

    cloneMock.mockImplementation(async (_url: string, destination: string) => {
      fs.mkdirSync(path.join(destination, ".git", "info"), { recursive: true });
      fs.writeFileSync(path.join(destination, "package.json"), '{"name":"fresh"}');
    });

    await expect(
      ensureRepoCloned(projectId, "example/site", "main", {
        expectedBindingGeneration: 1,
        skipInstall: true,
      }),
    ).resolves.toBe(repoPath);

    expect(cloneMock).toHaveBeenCalledOnce();
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(path.join(repoPath, ".git"))).toBe(true);
    expect(fs.readFileSync(path.join(repoPath, "package.json"), "utf8")).toContain("fresh");
  });

  it("waits for repository work, blocks new work, and removes the whole project directory", async () => {
    const projectId = "serialized-delete";
    cleanupProjectIds.add(projectId);
    const repoPath = projectRepoPath(projectId);
    let releaseOperation: (() => void) | undefined;
    let markOperationStarted: (() => void) | undefined;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const operationStarted = new Promise<void>((resolve) => {
      markOperationStarted = resolve;
    });
    const activeOperation = runInProjectLock(projectId, async () => {
      markOperationStarted?.();
      await operationGate;
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "finished"), "yes");
    });

    await operationStarted;
    beginProjectDeletion(projectId);
    const cleanup = removeDeletedProjectWorkspace(projectId);
    await expect(
      ensureRepoCloned(projectId, "example/site", "main", {
        expectedBindingGeneration: 1,
        skipInstall: true,
      }),
    ).rejects.toThrow("Project is being deleted");
    expect(() => startDevPreview(projectId, repoPath, null)).toThrow("Project is being deleted");

    releaseOperation?.();
    await activeOperation;
    await cleanup;

    expect(fs.existsSync(path.dirname(repoPath))).toBe(false);
    await expect(removeDeletedProjectWorkspace(projectId)).resolves.toBeUndefined();
  });

  it("holds publish and sync operations for the full writer lifetime and permits nested locking", async () => {
    const projectId = "agent-writer-serialization";
    cleanupProjectIds.add(projectId);
    const events: string[] = [];
    let releaseAgent: (() => void) | undefined;
    let markAgentStarted: (() => void) | undefined;
    const agentGate = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const agentStarted = new Promise<void>((resolve) => {
      markAgentStarted = resolve;
    });
    const epoch = projectWriterAuthorizationEpoch(projectId, "writer-user");

    const agent = runInProjectLock(projectId, async () => {
      const releaseWriter = registerProjectWriter(projectId, vi.fn(), {
        userId: "writer-user",
        expectedEpoch: epoch,
      });
      try {
        events.push("agent:start");
        await runInProjectLock(projectId, async () => {
          events.push("agent:nested");
        });
        markAgentStarted?.();
        await agentGate;
        events.push("agent:end");
      } finally {
        releaseWriter();
      }
    });

    await agentStarted;
    const publish = runInProjectLock(projectId, async () => {
      events.push("publish");
    });
    const sync = runInProjectLock(projectId, async () => {
      events.push("sync");
    });

    await Promise.resolve();
    expect(events).toEqual(["agent:start", "agent:nested"]);

    releaseAgent?.();
    await Promise.all([agent, publish, sync]);
    expect(events).toEqual(["agent:start", "agent:nested", "agent:end", "publish", "sync"]);
  });

  it("does not treat async work retained from a finished lock as reentrant", async () => {
    const projectId = "expired-lock-context";
    cleanupProjectIds.add(projectId);
    let runRetainedContext: (() => void) | undefined;
    let retainedOperation: Promise<void> | undefined;
    const retainedGate = new Promise<void>((resolve) => {
      runRetainedContext = resolve;
    });

    await runInProjectLock(projectId, async () => {
      // The promise continuation inherits the current AsyncLocalStorage
      // context even though it runs only after this lock has returned.
      retainedOperation = retainedGate.then(() => runInProjectLock(projectId, async () => {}));
    });

    let releaseBlocker: (() => void) | undefined;
    let markBlockerStarted: (() => void) | undefined;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve;
    });
    const blocker = runInProjectLock(projectId, async () => {
      markBlockerStarted?.();
      await blockerGate;
    });
    await blockerStarted;

    let retainedFinished = false;
    void retainedOperation?.then(() => {
      retainedFinished = true;
    });
    runRetainedContext?.();
    await Promise.resolve();
    expect(retainedFinished).toBe(false);

    releaseBlocker?.();
    await blocker;
    await retainedOperation;
    expect(retainedFinished).toBe(true);
  });

  it("cancels and waits for an active locked writer before resetting its repository", async () => {
    const projectId = "agent-writer-reset";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "in-progress"), "agent output");
    let releaseAgent: (() => void) | undefined;
    let markAgentStarted: (() => void) | undefined;
    const agentGate = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const agentStarted = new Promise<void>((resolve) => {
      markAgentStarted = resolve;
    });
    const cancel = vi.fn();

    const agent = runInProjectLock(projectId, async () => {
      const releaseWriter = registerProjectWriter(projectId, cancel);
      try {
        markAgentStarted?.();
        await agentGate;
      } finally {
        releaseWriter();
      }
    });
    await agentStarted;

    const reset = clearProjectRepoClone(projectId);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fs.existsSync(path.join(repoPath, "in-progress"))).toBe(true);

    releaseAgent?.();
    await Promise.all([agent, reset]);
    expect(fs.existsSync(repoPath)).toBe(false);
  });

  it("cancels member writers and rejects authorization captured before a role change", () => {
    const projectId = "member-authorization-change";
    const userId = "member-1";
    const staleEpoch = projectWriterAuthorizationEpoch(projectId, userId);
    const cancel = vi.fn();
    const release = registerProjectWriter(projectId, cancel, {
      userId,
      expectedEpoch: staleEpoch,
    });

    const finishChange = beginProjectWriterAuthorizationChange(projectId, userId);
    expect(cancel).toHaveBeenCalledOnce();
    const currentEpoch = projectWriterAuthorizationEpoch(projectId, userId);
    expect(currentEpoch).toBe(staleEpoch + 1);
    expect(() =>
      registerProjectWriter(projectId, vi.fn(), {
        userId,
        expectedEpoch: currentEpoch,
      }),
    ).toThrow("Project authorization changed");

    finishChange();
    expect(() =>
      registerProjectWriter(projectId, vi.fn(), {
        userId,
        expectedEpoch: staleEpoch,
      }),
    ).toThrow("Project authorization changed");
    expect(() =>
      registerProjectWriter(projectId, vi.fn(), {
        userId,
        expectedEpoch: currentEpoch,
      }),
    ).toThrow("Project authorization changed");

    const freshEpoch = projectWriterAuthorizationEpoch(projectId, userId);
    expect(freshEpoch).toBe(currentEpoch + 1);
    const releaseFresh = registerProjectWriter(projectId, vi.fn(), {
      userId,
      expectedEpoch: freshEpoch,
    });
    releaseFresh();
    release();
  });

  it("cancels an active project writer and waits for its release before deleting files", async () => {
    const projectId = "active-writer-delete";
    cleanupProjectIds.add(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "writer-output"), "still active");

    const cancel = vi.fn();
    const release = registerProjectWriter(projectId, cancel);

    beginProjectDeletion(projectId);
    const cleanup = removeDeletedProjectWorkspace(projectId);
    let cleanupFinished = false;
    void cleanup.then(() => {
      cleanupFinished = true;
    });

    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(cleanupFinished).toBe(false);
    expect(fs.existsSync(repoPath)).toBe(true);
    expect(() => registerProjectWriter(projectId, vi.fn())).toThrow("Project is being deleted");

    release();
    await cleanup;

    expect(cleanupFinished).toBe(true);
    expect(fs.existsSync(path.dirname(repoPath))).toBe(false);
  });

  it("returns a bounded status when a writer does not release after cancellation", async () => {
    const projectId = "stuck-writer";
    cleanupProjectIds.add(projectId);
    const cancel = vi.fn();
    const release = registerProjectWriter(projectId, cancel);

    beginProjectDeletion(projectId);
    await expect(cancelAndWaitForProjectWriters(projectId, 20)).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledOnce();

    release();
  });

  it("does not reset repository files while a cancelled writer is still active", async () => {
    const projectId = "stuck-writer-reset";
    cleanupProjectIds.add(projectId);
    const repoPath = projectRepoPath(projectId);
    const existingFile = path.join(repoPath, "keep");
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(existingFile, "yes");
    const release = registerProjectWriter(projectId, vi.fn());

    try {
      await expect(clearProjectRepoClone(projectId, 10)).rejects.toThrow(
        `Project writers are still active for ${projectId}`,
      );
      expect(fs.existsSync(existingFile)).toBe(true);
    } finally {
      release();
    }
  });

  it("retries a failed deleted-workspace cleanup until it succeeds", async () => {
    const projectId = "retry-delete";
    cleanupProjectIds.add(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "stale"), "yes");

    const remove = fs.promises.rm.bind(fs.promises);
    const cleanupError = new Error("ENOTEMPTY");
    const removeSpy = vi
      .spyOn(fs.promises, "rm")
      .mockRejectedValueOnce(cleanupError)
      .mockImplementation(remove);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await scheduleDeletedProjectWorkspaceCleanup(projectId);

      expect(removeSpy).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledWith(
        `[workspace] cleanup attempt 1 failed for deleted project ${projectId}; retrying in 250ms:`,
        cleanupError,
      );
      expect(fs.existsSync(path.dirname(repoPath))).toBe(false);
    } finally {
      removeSpy.mockRestore();
      warning.mockRestore();
    }
  });

  it("retries deletion after a writer misses the cancellation deadline", async () => {
    const projectId = "writer-timeout-retry";
    cleanupProjectIds.add(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "stale"), "yes");
    const release = registerProjectWriter(projectId, vi.fn());
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      beginProjectDeletion(projectId);
      const cleanup = scheduleDeletedProjectWorkspaceCleanup(projectId, {
        writerTimeoutMs: 10,
        retryDelaysMs: [5],
      });
      await vi.waitFor(() =>
        expect(warning).toHaveBeenCalledWith(
          `[workspace] project writers did not stop before cleanup timeout for ${projectId}; cleanup will be retried`,
        ),
      );

      release();
      await cleanup;

      expect(fs.existsSync(path.dirname(repoPath))).toBe(false);
      expect(warning).toHaveBeenCalledWith(
        `[workspace] cleanup attempt 1 failed for deleted project ${projectId}; retrying in 5ms:`,
        expect.any(Error),
      );
    } finally {
      release();
      warning.mockRestore();
    }
  });

  it("sweeps only workspace directories without an active project", async () => {
    const activeProjectId = "active-project";
    const orphanedProjectId = "orphaned-project";
    cleanupProjectIds.add(activeProjectId);
    cleanupProjectIds.add(orphanedProjectId);
    const activeRepoPath = projectRepoPath(activeProjectId);
    const orphanedRepoPath = projectRepoPath(orphanedProjectId);
    fs.mkdirSync(activeRepoPath, { recursive: true });
    fs.mkdirSync(orphanedRepoPath, { recursive: true });

    const cleanups = sweepOrphanedProjectWorkspaces([activeProjectId]);
    await Promise.all(cleanups);

    expect(cleanups).toHaveLength(1);
    expect(fs.existsSync(path.dirname(activeRepoPath))).toBe(true);
    expect(fs.existsSync(path.dirname(orphanedRepoPath))).toBe(false);
  });

  it("keeps writers blocked until every concurrent workspace reset has completed", async () => {
    const projectId = "concurrent-reset";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });

    let releaseFirstRemoval: (() => void) | undefined;
    let releaseSecondRemoval: (() => void) | undefined;
    let markFirstRemovalStarted: (() => void) | undefined;
    let markSecondRemovalStarted: (() => void) | undefined;
    const firstRemovalGate = new Promise<void>((resolve) => {
      releaseFirstRemoval = resolve;
    });
    const secondRemovalGate = new Promise<void>((resolve) => {
      releaseSecondRemoval = resolve;
    });
    const firstRemovalStarted = new Promise<void>((resolve) => {
      markFirstRemovalStarted = resolve;
    });
    const secondRemovalStarted = new Promise<void>((resolve) => {
      markSecondRemovalStarted = resolve;
    });
    const remove = fs.promises.rm.bind(fs.promises);
    let removalCount = 0;
    const removeSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      const index = removalCount++;
      if (index === 0) {
        markFirstRemovalStarted?.();
        await firstRemovalGate;
      } else if (index === 1) {
        markSecondRemovalStarted?.();
        await secondRemovalGate;
      }
      await remove(target, options);
    });

    const firstReset = clearProjectRepoClone(projectId);
    await firstRemovalStarted;
    const secondReset = clearProjectRepoClone(projectId);

    try {
      expect(() => registerProjectWriter(projectId, vi.fn())).toThrow(
        "Project workspace is being reset",
      );

      releaseFirstRemoval?.();
      await firstReset;
      await secondRemovalStarted;

      expect(() => registerProjectWriter(projectId, vi.fn())).toThrow(
        "Project workspace is being reset",
      );

      releaseSecondRemoval?.();
      await secondReset;

      const releaseWriter = registerProjectWriter(projectId, vi.fn());
      releaseWriter();
    } finally {
      releaseFirstRemoval?.();
      releaseSecondRemoval?.();
      await Promise.allSettled([firstReset, secondReset]);
      removeSpy.mockRestore();
    }
  });

  it("stops and destroys the remote preview before reset removes local files", async () => {
    const projectId = "busy-preview-delete";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.html"), "preview");

    await startDevPreview(projectId, repoPath, "npm run dev");
    expect(getPreviewProcessInfo(projectId).running).toBe(true);
    await clearProjectRepoClone(projectId);

    expect(e2bRuntimeMock.stopPreview).toHaveBeenCalled();
    expect(e2bRuntimeMock.destroyProject).toHaveBeenCalledWith({
      projectId,
      githubBindingGeneration: 1,
    });
    expect(getPreviewProcessInfo(projectId).running).toBe(false);
    expect(fs.existsSync(repoPath)).toBe(false);
  });
});
