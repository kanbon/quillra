import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PreviewExitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type PreviewStartOptions = {
  setupCommand?: string;
  setupCacheKey?: string;
  command: string;
  port: number;
  defaultNodeRuntime?: boolean;
  onSetupStart?: () => void | Promise<void>;
  onSetupComplete?: () => void | Promise<void>;
  onExit?: (result: PreviewExitResult) => void | Promise<void>;
};

function previewStartResult(port: number, pid = 42) {
  return {
    pid,
    port,
    access: {
      origin: "https://preview.example.test",
      headers: { "e2b-traffic-access-token": "test-preview-token" },
    },
  };
}

const cloneMock = vi.hoisted(() => vi.fn());
const e2bRuntimeMock = vi.hoisted(() => ({
  cancelPendingPreviewStart: vi.fn(),
  destroyProject: vi.fn(async () => undefined),
  getPreviewAccess: vi.fn(async () => ({
    origin: "https://preview.example.test",
    headers: { "e2b-traffic-access-token": "test-preview-token" },
  })),
  runCommand: vi.fn(),
  startPreview: vi.fn(async (_fence: unknown, _options: PreviewStartOptions) => ({
    pid: 42,
    port: 4321,
    access: {
      origin: "https://preview.example.test",
      headers: { "e2b-traffic-access-token": "test-preview-token" },
    },
  })),
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
  E2BProjectFenceError: class E2BProjectFenceError extends Error {
    constructor() {
      super("The project repository binding changed during E2B execution.");
      this.name = "E2BProjectFenceError";
    }
  },
  getDefaultE2BRuntime: () => e2bRuntimeMock,
}));

import { rawSqlite } from "../db/index.js";
import { E2B_RELAY_STATUS_HEADER, E2B_RELAY_UPSTREAM_UNAVAILABLE } from "./e2b-preview-relay.js";
import {
  issuePreviewCapability,
  resolveActivePreviewCapabilityToken,
  resolveReservedPreviewCapabilityToken,
} from "./preview-capability.js";
import { getPreviewStatus, markPreviewPortActive } from "./preview-status.js";
import { getPreviewUpstream } from "./preview-upstream.js";
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
  installDependenciesIfNeeded,
  projectRepoPath,
  reinstallProjectDependencies,
  removeDeletedProjectWorkspace,
  runFiniteProjectCommand,
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
  vi.stubEnv("BETTER_AUTH_SECRET", "workspace-lifecycle-test-secret");
  cloneMock.mockReset();
  for (const mock of Object.values(e2bRuntimeMock)) mock.mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
      }),
    ).resolves.toBe(repoPath);

    expect(cloneMock).toHaveBeenCalledOnce();
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(path.join(repoPath, ".git"))).toBe(true);
    expect(fs.readFileSync(path.join(repoPath, "package.json"), "utf8")).toContain("fresh");
    expect(e2bRuntimeMock.runCommand).not.toHaveBeenCalled();
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

  it("installs once in the isolated preview and starts only after a successful install", async () => {
    const projectId = "preview-install";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({
        scripts: { dev: "vite --host 0.0.0.0" },
        devDependencies: { vite: "latest" },
      }),
    );
    const lifecycleStages: string[] = [];
    vi.stubEnv("BETTER_AUTH_URL", "https://cms.example.test");
    vi.stubEnv("BETTER_AUTH_SECRET", "workspace-lifecycle-preview-secret");
    vi.stubEnv("PREVIEW_DOMAIN", "preview.example.test");
    e2bRuntimeMock.startPreview.mockImplementationOnce(async (_fence, options) => {
      lifecycleStages.push(getPreviewStatus(projectId).stage);
      await options.onSetupStart?.();
      lifecycleStages.push(getPreviewStatus(projectId).stage);
      await options.onSetupComplete?.();
      lifecycleStages.push(getPreviewStatus(projectId).stage);
      return previewStartResult(options.port);
    });

    await startDevPreview(projectId, repoPath, null, 1);

    expect(e2bRuntimeMock.runCommand).not.toHaveBeenCalled();
    expect(e2bRuntimeMock.cancelPendingPreviewStart).toHaveBeenCalledWith({
      projectId,
      githubBindingGeneration: 1,
    });
    expect(e2bRuntimeMock.cancelPendingPreviewStart.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      e2bRuntimeMock.startPreview.mock.invocationCallOrder[0] ?? 0,
    );
    expect(e2bRuntimeMock.startPreview).toHaveBeenCalledOnce();
    expect(lifecycleStages).toEqual(["cloning", "installing", "starting"]);
    const options = e2bRuntimeMock.startPreview.mock.calls[0]?.[1];
    expect(options?.defaultNodeRuntime).toBe(true);
    expect(options?.setupCommand).toContain("'corepack' 'pnpm' 'install' '--prod=false'");
    expect(options?.setupCacheKey).toMatch(/^v\d+:[a-f0-9]{64}$/);
    expect(options?.command).not.toContain("--include=dev");
    expect(options?.command).toMatch(
      /export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='p-[a-f0-9]{40}\.preview\.example\.test'/,
    );
    expect(options?.command).toContain("exec ");

    await clearProjectRepoClone(projectId);
  });

  it("coalesces concurrent preview starts instead of restarting the same project twice", async () => {
    const projectId = "coalesced-preview-start";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.html"), "preview");
    const started = deferred<ReturnType<typeof previewStartResult>>();
    e2bRuntimeMock.startPreview.mockReturnValueOnce(started.promise);

    const first = startDevPreview(projectId, repoPath, "npm run dev", 1);
    const second = startDevPreview(projectId, repoPath, "npm run dev", 1);

    expect(second).toBe(first);
    await vi.waitFor(() => expect(e2bRuntimeMock.startPreview).toHaveBeenCalledOnce());
    const port = e2bRuntimeMock.startPreview.mock.calls[0]?.[1].port ?? 4_321;
    started.resolve(previewStartResult(port));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { port, label: "Custom" },
      { port, label: "Custom" },
    ]);
    expect(e2bRuntimeMock.startPreview).toHaveBeenCalledOnce();
    expect(e2bRuntimeMock.stopPreview).not.toHaveBeenCalled();
  });

  it("clears a failed preview before a finite workspace install", async () => {
    const projectId = "failed-preview-workspace-install";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({
        scripts: { dev: "vite --host 0.0.0.0" },
        devDependencies: { vite: "latest" },
      }),
    );

    let onExit: PreviewStartOptions["onExit"];
    e2bRuntimeMock.startPreview.mockImplementationOnce(async (_fence, options) => {
      onExit = options.onExit;
      return previewStartResult(options.port);
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Preview is still starting"));

    try {
      await startDevPreview(projectId, repoPath, null, 1);
      await onExit?.({ exitCode: 1, stdout: "", stderr: "Previous preview failed" });
      expect(getPreviewStatus(projectId)).toMatchObject({
        stage: "error",
        message: "Dev server exited with code 1",
      });

      e2bRuntimeMock.runCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "installed",
        stderr: "",
      });
      await installDependenciesIfNeeded(repoPath, projectId, 1);

      expect(getPreviewProcessInfo(projectId)).toEqual({
        running: false,
        pid: null,
        exitCode: null,
        signalCode: null,
      });
      expect(getPreviewStatus(projectId)).toMatchObject({
        stage: "idle",
        message: "Project dependencies are ready",
      });
      expect(e2bRuntimeMock.stopPreview).toHaveBeenCalled();
      expect(e2bRuntimeMock.stopPreview.mock.invocationCallOrder.at(-1)).toBeLessThan(
        e2bRuntimeMock.runCommand.mock.invocationCallOrder.at(-1) ?? 0,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reports a terminal dependency-install error instead of remaining on installing", async () => {
    const projectId = "failed-workspace-install";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "package.json"), '{"name":"broken-install"}');
    const installDone = deferred<PreviewExitResult>();
    e2bRuntimeMock.runCommand.mockReturnValueOnce(installDone.promise);

    const installing = installDependenciesIfNeeded(repoPath, projectId, 1);
    await vi.waitFor(() => expect(e2bRuntimeMock.runCommand).toHaveBeenCalledOnce());
    expect(getPreviewStatus(projectId)).toMatchObject({
      stage: "installing",
      message: "Running pnpm install in E2B",
    });

    installDone.resolve({
      exitCode: 1,
      stdout: "",
      stderr: "package resolution failed",
    });
    await expect(installing).rejects.toThrow(
      "pnpm install failed in the secure sandbox: package resolution failed",
    );
    expect(getPreviewStatus(projectId)).toMatchObject({
      stage: "error",
      message: "pnpm install failed in E2B",
    });
  });

  it("ensures dependencies inside the same isolated agent command operation", async () => {
    const projectId = "agent-command-dependencies";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    e2bRuntimeMock.runCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "passed",
      stderr: "",
    });

    await runFiniteProjectCommand(projectId, repoPath, "pnpm test", {
      expectedBindingGeneration: 1,
      ensureDependencies: true,
    });

    expect(e2bRuntimeMock.runCommand).toHaveBeenCalledWith(
      { projectId, githubBindingGeneration: 1 },
      expect.objectContaining({
        command: "pnpm test",
        setupCommand: expect.stringContaining("'corepack' 'pnpm' 'install'"),
        setupCacheKey: expect.stringMatching(/^v\d+:[a-f0-9]{64}$/),
      }),
    );
  });

  it("does not let a stale finite command clear the current binding's preview", async () => {
    const projectId = "stale-finite-command";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    rawSqlite
      .prepare("UPDATE projects SET github_binding_generation = 2 WHERE id = ?")
      .run(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({ scripts: { dev: "vite --host 0.0.0.0" } }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Preview is still starting"));

    try {
      const preview = await startDevPreview(projectId, repoPath, "npm run dev", 2);
      const capability = issuePreviewCapability(projectId, preview.port);
      const processBefore = getPreviewProcessInfo(projectId);
      const statusBefore = getPreviewStatus(projectId);
      const upstreamBefore = getPreviewUpstream(projectId, preview.port);
      e2bRuntimeMock.stopPreview.mockClear();

      await expect(installDependenciesIfNeeded(repoPath, projectId, 1)).rejects.toThrow(
        "The project repository binding changed during E2B execution.",
      );

      expect(getPreviewProcessInfo(projectId)).toEqual(processBefore);
      expect(getPreviewStatus(projectId)).toEqual(statusBefore);
      expect(getPreviewUpstream(projectId, preview.port)).toEqual(upstreamBefore);
      expect(resolveReservedPreviewCapabilityToken(capability.token)).toMatchObject({
        ok: true,
        projectId,
        port: preview.port,
      });
      expect(e2bRuntimeMock.stopPreview).not.toHaveBeenCalled();
      expect(e2bRuntimeMock.runCommand).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reinstalls dependencies while holding the reset lock", async () => {
    const projectId = "reset-dependency-reinstall";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "package.json"), '{"name":"reset-install"}');
    e2bRuntimeMock.runCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "installed",
      stderr: "",
    });

    await expect(reinstallProjectDependencies(projectId)).resolves.toBeUndefined();

    expect(e2bRuntimeMock.destroyProject).toHaveBeenCalledWith({
      projectId,
      githubBindingGeneration: 1,
    });
    expect(e2bRuntimeMock.runCommand).toHaveBeenCalledOnce();
    expect(e2bRuntimeMock.destroyProject.mock.invocationCallOrder.at(-1)).toBeLessThan(
      e2bRuntimeMock.runCommand.mock.invocationCallOrder.at(-1) ?? 0,
    );
    expect(getPreviewStatus(projectId)).toMatchObject({
      stage: "idle",
      message: "Project dependencies are ready",
    });
  });

  it("does not publish process state when the preview exits before startup returns", async () => {
    const projectId = "preview-exits-during-start";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.html"), "preview");

    let port = 0;
    e2bRuntimeMock.startPreview.mockImplementationOnce(async (_fence, options) => {
      port = options.port;
      await options.onExit?.({ exitCode: 1, stdout: "", stderr: "Vite crashed" });
      return previewStartResult(options.port);
    });

    const starting = startDevPreview(projectId, repoPath, "npm run dev", 1);
    await expect(starting).rejects.toThrow("exited during startup with code 1");
    expect(getPreviewProcessInfo(projectId)).toEqual({
      running: false,
      pid: 42,
      exitCode: 1,
      signalCode: null,
    });
    expect(getPreviewStatus(projectId)).toMatchObject({
      stage: "error",
      message: "Dev server exited with code 1",
    });
    expect(getPreviewUpstream(projectId, port)).toBeNull();
  });

  it("treats an unexpected zero exit as a failed preview", async () => {
    const projectId = "preview-zero-exit";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.html"), "preview");

    let onExit: PreviewStartOptions["onExit"];
    e2bRuntimeMock.startPreview.mockImplementationOnce(async (_fence, options) => {
      onExit = options.onExit;
      return previewStartResult(options.port);
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Preview is still starting"));

    try {
      const { port } = await startDevPreview(projectId, repoPath, "npm run dev", 1);
      expect(getPreviewUpstream(projectId, port)).not.toBeNull();
      const capability = issuePreviewCapability(projectId, port);
      expect(markPreviewPortActive(projectId, port)).toBe(true);
      expect(resolveActivePreviewCapabilityToken(capability.token).ok).toBe(true);

      await onExit?.({ exitCode: 0, stdout: "", stderr: "" });

      expect(getPreviewProcessInfo(projectId)).toEqual({
        running: false,
        pid: 42,
        exitCode: 0,
        signalCode: null,
      });
      expect(getPreviewStatus(projectId)).toMatchObject({
        stage: "error",
        message: "Dev server exited with code 0",
      });
      expect(getPreviewUpstream(projectId, port)).toBeNull();
      expect(resolveActivePreviewCapabilityToken(capability.token).ok).toBe(false);
      expect(resolveReservedPreviewCapabilityToken(capability.token).ok).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ignores a late exit callback from a superseded launch even when its PID is reused", async () => {
    const projectId = "preview-reused-pid";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.html"), "preview");

    const exits: Array<NonNullable<PreviewStartOptions["onExit"]>> = [];
    e2bRuntimeMock.startPreview
      .mockImplementationOnce(async (_fence, options) => {
        if (options.onExit) exits.push(options.onExit);
        return previewStartResult(options.port);
      })
      .mockImplementationOnce(async (_fence, options) => {
        if (options.onExit) exits.push(options.onExit);
        return previewStartResult(options.port);
      });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Preview is still starting"));

    try {
      await startDevPreview(projectId, repoPath, "npm run dev", 1);
      const second = await startDevPreview(projectId, repoPath, "npm run dev", 1);

      await exits[0]?.({ exitCode: 1, stdout: "", stderr: "old preview exited" });

      expect(getPreviewProcessInfo(projectId)).toEqual({
        running: true,
        pid: 42,
        exitCode: null,
        signalCode: null,
      });
      expect(getPreviewStatus(projectId).stage).toBe("starting");
      expect(getPreviewUpstream(projectId, second.port)).not.toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps the active preview when replacement preparation is invalid", async () => {
    const projectId = "preview-invalid-replacement";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.html"), "preview");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Preview is still starting"));

    try {
      const current = await startDevPreview(projectId, repoPath, "npm run dev", 1);
      expect(getPreviewUpstream(projectId, current.port)).not.toBeNull();

      fs.writeFileSync(
        path.join(repoPath, "package.json"),
        JSON.stringify({ packageManager: "bun@1.0.0", scripts: { dev: "vite" } }),
      );

      await expect(startDevPreview(projectId, repoPath, null, 1)).rejects.toThrow(
        'Unsupported package manager "bun"',
      );
      expect(e2bRuntimeMock.startPreview).toHaveBeenCalledOnce();
      expect(e2bRuntimeMock.stopPreview).not.toHaveBeenCalled();
      expect(getPreviewProcessInfo(projectId)).toMatchObject({ running: true, pid: 42 });
      expect(getPreviewUpstream(projectId, current.port)).not.toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps probing a slow preview until the running process becomes ready", async () => {
    const projectId = "slow-preview-ready";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.html"), "preview");

    vi.useFakeTimers();
    let probeCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      probeCount += 1;
      if (probeCount <= 121) throw new Error("Still starting");
      return new Response("ready", { status: 200 });
    });

    try {
      await startDevPreview(projectId, repoPath, "npm run dev", 1);
      await vi.advanceTimersByTimeAsync(65_000);

      expect(probeCount).toBe(122);
      expect(getPreviewStatus(projectId).stage).toBe("ready");
    } finally {
      await clearProjectRepoClone(projectId);
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not activate a preview on the relay's synthetic not-ready response", async () => {
    const projectId = "relay-target-not-ready";
    cleanupProjectIds.add(projectId);
    ensureProjectRow(projectId);
    const repoPath = projectRepoPath(projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.html"), "preview");

    vi.useFakeTimers();
    let probeCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      probeCount += 1;
      if (probeCount === 1) {
        return new Response("Preview upstream unavailable", {
          status: 502,
          headers: {
            [E2B_RELAY_STATUS_HEADER]: E2B_RELAY_UPSTREAM_UNAVAILABLE,
          },
        });
      }
      return new Response("ready", { status: 200 });
    });

    try {
      await startDevPreview(projectId, repoPath, "npm run dev", 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(probeCount).toBe(1);
      expect(getPreviewStatus(projectId).stage).toBe("starting");

      await vi.advanceTimersByTimeAsync(500);

      expect(probeCount).toBe(2);
      expect(getPreviewStatus(projectId).stage).toBe("ready");
    } finally {
      await clearProjectRepoClone(projectId);
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
