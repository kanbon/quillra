import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.hoisted(() => ({
  to: vi.fn(async () => ({ entries: 1, bytes: 1 })),
  from: vi.fn(async () => ({ entries: 1, bytes: 1 })),
}));

vi.mock("./e2b-workspace-sync.js", () => ({
  E2B_WORKSPACE_ROOT: "/home/quillra-project/quillra-workspace",
  E2B_PREVIEW_ROOT: "/home/quillra-project/quillra-preview",
  syncLocalWorkspaceToE2B: sync.to,
  syncE2BWorkspaceToLocal: sync.from,
}));

import type { E2BAdapter, E2BCommandResult, E2BProcess, E2BSandboxHandle } from "./e2b-adapter.js";
import { E2BTrustedEnvironmentError } from "./e2b-preview-relay.js";
import {
  E2BActivePreviewError,
  type E2BProjectFence,
  E2BProjectFenceError,
  type E2BProjectSandboxRecord,
  type E2BProjectSandboxStore,
  E2BRuntime,
} from "./e2b-runtime.js";
import {
  getPreviewUpstream,
  registerPreviewUpstream,
  unregisterPreviewUpstream,
} from "./preview-upstream.js";

class MemoryStore implements E2BProjectSandboxStore {
  readonly records = new Map<string, E2BProjectSandboxRecord>();
  generation = 1;
  assertHook: (() => void) | undefined;

  assertFence(fence: E2BProjectFence): void {
    this.assertHook?.();
    if (fence.githubBindingGeneration !== this.generation) {
      throw new E2BProjectFenceError();
    }
  }
  get(projectId: string): E2BProjectSandboxRecord | null {
    return this.records.get(projectId) ?? null;
  }
  list(): E2BProjectSandboxRecord[] {
    return [...this.records.values()];
  }
  save(record: E2BProjectSandboxRecord): void {
    this.records.set(record.projectId, { ...record });
  }
  setPreview(
    projectId: string,
    sandboxId: string,
    preview: { pid: number; port: number } | null,
  ): void {
    const record = this.records.get(projectId);
    if (!record || record.sandboxId !== sandboxId) return;
    record.previewPid = preview?.pid ?? null;
    record.previewPort = preview?.port ?? null;
  }
  delete(projectId: string, sandboxId?: string): void {
    const record = this.records.get(projectId);
    if (!sandboxId || record?.sandboxId === sandboxId) this.records.delete(projectId);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeSandbox(processResult?: Promise<E2BCommandResult>): E2BSandboxHandle {
  const result =
    processResult ??
    Promise.resolve({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
  const process: E2BProcess = {
    pid: 42,
    wait: () => result,
    kill: vi.fn(async () => true),
  };
  return {
    sandboxId: "sandbox-a",
    trafficAccessToken: "traffic-a",
    prepareExecutionEnvironment: vi.fn(async () => undefined),
    quiesceProjectProcesses: vi.fn(async () => undefined),
    startPreviewRelay: vi.fn(async () => undefined),
    stopPreviewRelay: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    getInfo: vi.fn(),
    readFileChunk: vi.fn(),
    writeFiles: vi.fn(async () => undefined),
    makeDir: vi.fn(async () => undefined),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    startCommand: vi.fn(async () => process),
    killProcess: vi.fn(async () => false),
    getHost: vi.fn((port: number) => `${port}-sandbox.e2b.app`),
    pause: vi.fn(async () => true),
    kill: vi.fn(async () => true),
  };
}

function runtimeFixture(sandbox = fakeSandbox()) {
  const store = new MemoryStore();
  const adapter: E2BAdapter = {
    create: vi.fn(async () => sandbox),
    connect: vi.fn(async () => sandbox),
    destroy: vi.fn(async () => true),
    isNotFound: vi.fn(() => false),
  };
  const runtime = new E2BRuntime({
    adapter,
    store,
    config: {
      apiKey: "e2b_control_plane_key",
      templateId: "base",
      sandboxTimeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    },
  });
  return { runtime, store, adapter, sandbox };
}

let localRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  localRoot = await mkdtemp(path.join(os.tmpdir(), "quillra-e2b-runtime-"));
});

afterEach(async () => {
  unregisterPreviewUpstream("project-a");
  await rm(localRoot, { recursive: true, force: true });
});

describe("E2B runtime", () => {
  it("persists and reuses exactly one sandbox for concurrent project access", async () => {
    const { runtime, adapter, store } = runtimeFixture();
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };

    const [first, second] = await Promise.all([
      runtime.ensureProject(fence),
      runtime.ensureProject(fence),
    ]);

    expect(first.sandboxId).toBe("sandbox-a");
    expect(second.sandboxId).toBe("sandbox-a");
    expect(adapter.create).toHaveBeenCalledOnce();
    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(store.records).toHaveLength(1);
    expect(adapter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "e2b_control_plane_key",
        allowInternetAccess: true,
        projectId: "project-a",
      }),
    );
  });

  it("reasserts the binding fence before command writeback", async () => {
    const commandDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox(commandDone.promise);
    const { runtime, store } = runtimeFixture(sandbox);
    const execution = runtime.runCommand(
      { projectId: "project-a", githubBindingGeneration: 1 },
      { localRoot, command: "touch changed" },
    );
    await vi.waitFor(() => {
      expect(sandbox.startCommand).toHaveBeenCalledOnce();
    });
    store.generation = 2;
    commandDone.resolve({ exitCode: 0, stdout: "", stderr: "" });

    await expect(execution).rejects.toBeInstanceOf(E2BProjectFenceError);
    expect(sync.from).not.toHaveBeenCalled();
  });

  it("bootstraps a project-selected Node runtime before running a finite command", async () => {
    await writeFile(
      path.join(localRoot, "package.json"),
      JSON.stringify({ volta: { node: "22.23.1" } }),
    );
    const sandbox = fakeSandbox();
    const { runtime } = runtimeFixture(sandbox);

    await expect(
      runtime.runCommand(
        { projectId: "project-a", githubBindingGeneration: 1 },
        { localRoot, command: "npm run build" },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(sandbox.startCommand).toHaveBeenCalledTimes(2);
    const [bootstrapCommand, bootstrapOptions] =
      vi.mocked(sandbox.startCommand).mock.calls[0] ?? [];
    const [projectCommand, projectOptions] = vi.mocked(sandbox.startCommand).mock.calls[1] ?? [];
    expect(bootstrapCommand).toContain("https://nodejs.org/dist/v${resolved}");
    expect(bootstrapCommand).toContain("SHASUMS256.txt");
    expect(bootstrapOptions).toMatchObject({
      cwd: "/home/quillra-project",
      maxOutputBytes: 32 * 1024,
    });
    expect(bootstrapOptions).not.toHaveProperty("projectPathPrefix");
    expect(projectCommand).toBe("npm run build");
    expect(projectOptions).toMatchObject({
      cwd: "/home/quillra-project/quillra-workspace",
      envs: {
        COREPACK_DEFAULT_TO_LATEST: "0",
        COREPACK_ENABLE_AUTO_PIN: "0",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        COREPACK_ENV_FILE: "0",
        COREPACK_ENABLE_PROJECT_SPEC: "0",
        COREPACK_HOME: expect.stringMatching(
          /^\/home\/quillra-project\/\.quillra\/node-runtimes\/[0-9a-f]{32}\/corepack-cache$/,
        ),
      },
      projectPathPrefix: expect.stringMatching(
        /^\/home\/quillra-project\/\.quillra\/node-runtimes\/[0-9a-f]{32}\/bin$/,
      ),
    });
  });

  it("quiesces daemons before a finite command and again before writeback", async () => {
    const commandDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox(commandDone.promise);
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    vi.clearAllMocks();

    const execution = runtime.runCommand(fence, {
      localRoot,
      command: "build-and-daemonize",
    });
    await vi.waitFor(() => expect(sandbox.startCommand).toHaveBeenCalledOnce());

    expect(sandbox.quiesceProjectProcesses).toHaveBeenCalledOnce();
    expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce();
    const firstQuiesce =
      vi.mocked(sandbox.quiesceProjectProcesses).mock.invocationCallOrder[0] ?? 0;
    const relayStop = vi.mocked(sandbox.stopPreviewRelay).mock.invocationCallOrder[0] ?? 0;
    const syncTo = sync.to.mock.invocationCallOrder[0] ?? 0;
    const commandStart = vi.mocked(sandbox.startCommand).mock.invocationCallOrder[0] ?? 0;
    expect(firstQuiesce).toBeLessThan(relayStop);
    expect(relayStop).toBeLessThan(syncTo);
    expect(syncTo).toBeLessThan(commandStart);

    commandDone.resolve({ exitCode: 0, stdout: "done", stderr: "" });
    await expect(execution).resolves.toMatchObject({ exitCode: 0, stdout: "done" });

    expect(sandbox.quiesceProjectProcesses).toHaveBeenCalledTimes(2);
    const secondQuiesce =
      vi.mocked(sandbox.quiesceProjectProcesses).mock.invocationCallOrder[1] ?? 0;
    const syncFrom = sync.from.mock.invocationCallOrder[0] ?? 0;
    expect(commandStart).toBeLessThan(secondQuiesce);
    expect(secondQuiesce).toBeLessThan(syncFrom);
  });

  it("refuses direct workspace access while a managed preview is active", async () => {
    const sandbox = fakeSandbox();
    const { runtime, adapter, store } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    store.setPreview(fence.projectId, sandbox.sandboxId, { pid: 99, port: 4_321 });
    vi.clearAllMocks();

    await expect(
      runtime.runCommand(fence, {
        localRoot,
        command: "build-without-owner-stop",
      }),
    ).rejects.toBeInstanceOf(E2BActivePreviewError);

    expect(store.get(fence.projectId)).toMatchObject({
      previewPid: 99,
      previewPort: 4_321,
    });
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(sandbox.quiesceProjectProcesses).not.toHaveBeenCalled();
    expect(sandbox.stopPreviewRelay).not.toHaveBeenCalled();
    expect(sandbox.startCommand).not.toHaveBeenCalled();
    expect(sync.to).not.toHaveBeenCalled();
    expect(sync.from).not.toHaveBeenCalled();
  });

  it("quarantines the sandbox and skips writeback when descendant quiescence fails", async () => {
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.quiesceProjectProcesses)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("untrusted provider detail"));
    const { runtime, store } = runtimeFixture(sandbox);

    await expect(
      runtime.runCommand(
        { projectId: "project-a", githubBindingGeneration: 1 },
        { localRoot, command: "start-background-child" },
      ),
    ).rejects.toMatchObject({
      name: "E2BTrustedEnvironmentError",
      stage: "project-quiesce",
      cleanupStatus: "confirmed",
    });

    expect(sandbox.kill).toHaveBeenCalledOnce();
    expect(sync.from).not.toHaveBeenCalled();
    expect(store.get("project-a")).toBeNull();
  });

  it("revokes the traffic-token route before a failed reconnect cleanup settles", async () => {
    const sandbox = fakeSandbox();
    const { runtime, adapter } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    registerPreviewUpstream(fence.projectId, 4_321, {
      origin: "https://733-sandbox.e2b.app",
      headers: { "e2b-traffic-access-token": "must-be-revoked" },
    });

    const cleanupPending = deferred<void>();
    const connectEntered = deferred<void>();
    vi.mocked(adapter.connect).mockImplementationOnce(async () => {
      connectEntered.resolve();
      await cleanupPending.promise;
      throw new E2BTrustedEnvironmentError("project-isolation", "failed");
    });

    const reconnect = runtime.ensureProject(fence);
    await connectEntered.promise;
    expect(getPreviewUpstream(fence.projectId, 4_321)).toBeNull();

    cleanupPending.resolve();
    await expect(reconnect).rejects.toMatchObject({
      name: "E2BTrustedEnvironmentError",
      cleanupStatus: "failed",
    });
  });

  it("preserves caller cancellation after confirmed reconnect cleanup", async () => {
    const sandbox = fakeSandbox();
    const { runtime, adapter, store } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    const controller = new AbortController();
    const reason = new Error("expected-cancellation");
    vi.mocked(adapter.connect).mockImplementationOnce(async () => {
      controller.abort(reason);
      throw new E2BTrustedEnvironmentError("bootstrap", "confirmed");
    });

    await expect(
      runtime.runCommand(fence, {
        localRoot,
        command: "sleep 60",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    expect(store.get(fence.projectId)).toBeNull();
  });

  it("preserves caller cancellation after confirmed create cleanup", async () => {
    const { runtime, adapter, store } = runtimeFixture();
    const controller = new AbortController();
    const reason = new Error("expected-create-cancellation");
    vi.mocked(adapter.create).mockImplementationOnce(async () => {
      controller.abort(reason);
      throw new E2BTrustedEnvironmentError("bootstrap", "confirmed");
    });

    await expect(
      runtime.ensureProject(
        { projectId: "project-a", githubBindingGeneration: 1 },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);

    expect(store.get("project-a")).toBeNull();
  });

  it("persists a provisional sandbox id until failed bootstrap cleanup can be retried", async () => {
    const { runtime, adapter, store } = runtimeFixture();
    vi.mocked(adapter.create).mockImplementationOnce(async (options) => {
      await options.onSandboxCreated?.("sandbox-orphan");
      throw new E2BTrustedEnvironmentError("bootstrap", "failed", "sandbox-orphan");
    });

    await expect(
      runtime.ensureProject({ projectId: "project-a", githubBindingGeneration: 1 }),
    ).rejects.toMatchObject({
      name: "E2BTrustedEnvironmentError",
      cleanupStatus: "failed",
      sandboxId: "sandbox-orphan",
    });

    expect(store.get("project-a")).toMatchObject({
      sandboxId: "sandbox-orphan",
      previewPid: null,
      previewPort: null,
    });

    await runtime.destroyAllWithApiKey({ apiKey: "e2b_control_plane_key" });
    expect(adapter.destroy).toHaveBeenCalledWith(
      "sandbox-orphan",
      expect.objectContaining({ apiKey: "e2b_control_plane_key" }),
    );
    expect(store.get("project-a")).toBeNull();
  });

  it("retains the returned sandbox id when a mismatched create callback cannot be cleaned up", async () => {
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.kill).mockRejectedValueOnce(new Error("provider cleanup failed"));
    const { runtime, adapter, store } = runtimeFixture(sandbox);
    vi.mocked(adapter.create).mockImplementationOnce(async (options) => {
      await options.onSandboxCreated?.("stale-callback-id");
      return sandbox;
    });

    await expect(
      runtime.ensureProject({ projectId: "project-a", githubBindingGeneration: 1 }),
    ).rejects.toMatchObject({
      name: "E2BTrustedEnvironmentError",
      stage: "bootstrap",
      cleanupStatus: "failed",
      sandboxId: "sandbox-a",
    });

    expect(store.get("project-a")).toMatchObject({
      sandboxId: "sandbox-a",
      previewPid: null,
      previewPort: null,
    });

    await runtime.destroyAllWithApiKey({ apiKey: "e2b_control_plane_key" });
    expect(adapter.destroy).toHaveBeenCalledWith(
      "sandbox-a",
      expect.objectContaining({ apiKey: "e2b_control_plane_key" }),
    );
    expect(store.get("project-a")).toBeNull();
  });

  it("refuses a direct workspace sync while a managed preview is active", async () => {
    const sandbox = fakeSandbox();
    const { runtime, adapter, store } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    store.setPreview(fence.projectId, sandbox.sandboxId, { pid: 99, port: 4_321 });
    vi.clearAllMocks();

    await expect(runtime.syncToSandbox(fence, localRoot)).rejects.toBeInstanceOf(
      E2BActivePreviewError,
    );

    expect(store.get(fence.projectId)).toMatchObject({
      previewPid: 99,
      previewPort: 4_321,
    });
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(sandbox.quiesceProjectProcesses).not.toHaveBeenCalled();
    expect(sandbox.stopPreviewRelay).not.toHaveBeenCalled();
    expect(sync.to).not.toHaveBeenCalled();
  });

  it("runs preview from its isolated copy, never writes it back, and reports exit", async () => {
    const previewDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox(previewDone.promise);
    const { runtime } = runtimeFixture(sandbox);
    const onExit = vi.fn();

    await runtime.startPreview(
      { projectId: "project-a", githubBindingGeneration: 1 },
      {
        localRoot,
        command: "npm run dev",
        port: 4_321,
        onExit,
      },
    );
    expect(sync.to).toHaveBeenCalledWith(
      expect.objectContaining({ remoteRoot: "/home/quillra-project/quillra-preview" }),
    );
    expect(sync.from).not.toHaveBeenCalled();
    expect(sandbox.quiesceProjectProcesses).toHaveBeenCalledOnce();
    expect(sandbox.startPreviewRelay).toHaveBeenCalledWith(4_321, expect.any(AbortSignal));
    expect(vi.mocked(sandbox.quiesceProjectProcesses).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.startPreviewRelay).mock.invocationCallOrder[0] ?? 0,
    );
    expect(vi.mocked(sandbox.startPreviewRelay).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.startCommand).mock.invocationCallOrder[0] ?? 0,
    );
    expect(sandbox.startCommand).toHaveBeenCalledWith(
      "npm run dev",
      expect.objectContaining({
        cwd: "/home/quillra-project/quillra-preview",
        envs: { HOST: "127.0.0.1", PORT: "4321" },
      }),
    );

    const result = { exitCode: 2, stdout: "", stderr: "failed" };
    previewDone.resolve(result);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(result));
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
    expect(sync.from).not.toHaveBeenCalled();
  });

  it("finishes preview setup before opening the relay and starting the dev server", async () => {
    const previewDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox();
    const setupProcess: E2BProcess = {
      pid: 41,
      wait: vi.fn(async () => ({ exitCode: 0, stdout: "installed", stderr: "" })),
      kill: vi.fn(async () => true),
    };
    const previewProcess: E2BProcess = {
      pid: 42,
      wait: vi.fn(() => previewDone.promise),
      kill: vi.fn(async () => true),
    };
    vi.mocked(sandbox.startCommand)
      .mockResolvedValueOnce(setupProcess)
      .mockResolvedValueOnce(previewProcess);
    const { runtime } = runtimeFixture(sandbox);
    const onSetupComplete = vi.fn();

    await runtime.startPreview(
      { projectId: "project-a", githubBindingGeneration: 1 },
      {
        localRoot,
        setupCommand: "npm install --include=dev",
        command: "npm run dev",
        port: 4_321,
        onSetupComplete,
      },
    );

    expect(sandbox.startCommand).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sandbox.startCommand).mock.calls[0]).toEqual([
      "npm install --include=dev",
      expect.objectContaining({
        cwd: "/home/quillra-project/quillra-preview",
      }),
    ]);
    expect(vi.mocked(sandbox.startCommand).mock.calls[1]).toEqual([
      "npm run dev",
      expect.objectContaining({
        cwd: "/home/quillra-project/quillra-preview",
        envs: { HOST: "127.0.0.1", PORT: "4321" },
      }),
    ]);
    expect(setupProcess.wait).toHaveBeenCalledOnce();
    expect(vi.mocked(setupProcess.wait).mock.invocationCallOrder[0]).toBeLessThan(
      onSetupComplete.mock.invocationCallOrder[0] ?? 0,
    );
    expect(onSetupComplete.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.startPreviewRelay).mock.invocationCallOrder[0] ?? 0,
    );
    expect(vi.mocked(sandbox.startPreviewRelay).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.startCommand).mock.invocationCallOrder[1] ?? 0,
    );

    previewDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
  });

  it("fails bounded preview setup before opening ingress or starting project code", async () => {
    const sandbox = fakeSandbox();
    const setupProcess: E2BProcess = {
      pid: 41,
      wait: vi.fn(async () => ({
        exitCode: 1,
        stdout: "x".repeat(8_000),
        stderr: "dependency resolution failed",
      })),
      kill: vi.fn(async () => true),
    };
    vi.mocked(sandbox.startCommand).mockImplementationOnce(async (_command, options) => ({
      ...setupProcess,
      wait: async () => {
        const result = await setupProcess.wait();
        if (result.stdout) await options.onStdout?.(result.stdout);
        if (result.stderr) await options.onStderr?.(result.stderr);
        return result;
      },
    }));
    const { runtime } = runtimeFixture(sandbox);
    const onSetupComplete = vi.fn();
    const onStdout = vi.fn();
    const onStderr = vi.fn();

    const start = runtime.startPreview(
      { projectId: "project-a", githubBindingGeneration: 1 },
      {
        localRoot,
        setupCommand: "npm install --include=dev",
        command: "npm run dev",
        port: 4_321,
        onSetupComplete,
        onStdout,
        onStderr,
      },
    );

    await expect(start).rejects.toThrow(
      "E2B preview setup failed with exit code 1. Check the advanced preview logs for details.",
    );
    await expect(start).rejects.not.toThrow("dependency resolution failed");
    await expect(start).rejects.not.toThrow("x".repeat(100));
    expect(onStdout).toHaveBeenCalledWith("x".repeat(8_000));
    expect(onStderr).toHaveBeenCalledWith("dependency resolution failed");
    expect(onSetupComplete).not.toHaveBeenCalled();
    expect(sandbox.startPreviewRelay).not.toHaveBeenCalled();
    expect(sandbox.startCommand).toHaveBeenCalledOnce();
  });

  it("aborts an in-progress preview setup before the queued stop waits for it", async () => {
    const setupWaitStarted = deferred<void>();
    const setupDone = deferred<E2BCommandResult>();
    const setupProcess: E2BProcess = {
      pid: 41,
      wait: vi.fn(() => {
        setupWaitStarted.resolve();
        return setupDone.promise;
      }),
      kill: vi.fn(async () => true),
    };
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.startCommand).mockResolvedValueOnce(setupProcess);
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };

    const start = runtime.startPreview(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      command: "npm run dev",
      port: 4_321,
    });
    const startFailure = start.then(
      () => null,
      (error: unknown) => error,
    );
    await setupWaitStarted.promise;

    const stop = runtime.stopPreview(fence);
    expect(setupProcess.kill).toHaveBeenCalledOnce();

    await expect(startFailure).resolves.toMatchObject({
      name: "AbortError",
      message: "The preview start was stopped.",
    });
    await expect(stop).resolves.toBeUndefined();
    expect(sandbox.startPreviewRelay).not.toHaveBeenCalled();
  });

  it("aborts an in-progress preview setup before credential rotation drains and tears down", async () => {
    const setupWaitStarted = deferred<void>();
    const setupDone = deferred<E2BCommandResult>();
    const setupProcess: E2BProcess = {
      pid: 41,
      wait: vi.fn(() => {
        setupWaitStarted.resolve();
        return setupDone.promise;
      }),
      kill: vi.fn(async () => true),
    };
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.startCommand).mockResolvedValueOnce(setupProcess);
    const { runtime, adapter, store } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    const commit = vi.fn(async () => undefined);

    const start = runtime.startPreview(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      command: "npm run dev",
      port: 4_321,
    });
    const startFailure = start.then(
      () => null,
      (error: unknown) => error,
    );
    await setupWaitStarted.promise;

    const rotation = runtime.withCredentialRotation(async () => {
      await runtime.destroyAllWithApiKey({ apiKey: "e2b_control_plane_key" });
      await commit();
    });

    await vi.waitFor(() => expect(setupProcess.kill).toHaveBeenCalledOnce());
    await expect(startFailure).resolves.toMatchObject({
      name: "AbortError",
      message: "The E2B runtime is being reconfigured.",
    });
    await expect(rotation).resolves.toBeUndefined();

    expect(adapter.destroy).toHaveBeenCalledWith(
      "sandbox-a",
      expect.objectContaining({ apiKey: "e2b_control_plane_key" }),
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(store.get(fence.projectId)).toBeNull();
    expect(sandbox.startPreviewRelay).not.toHaveBeenCalled();
  });

  it("does not let a stale-fence stop abort a newer preview setup", async () => {
    const setupWaitStarted = deferred<void>();
    const setupDone = deferred<E2BCommandResult>();
    const previewDone = deferred<E2BCommandResult>();
    const setupProcess: E2BProcess = {
      pid: 41,
      wait: vi.fn(() => {
        setupWaitStarted.resolve();
        return setupDone.promise;
      }),
      kill: vi.fn(async () => true),
    };
    const previewProcess: E2BProcess = {
      pid: 42,
      wait: vi.fn(() => previewDone.promise),
      kill: vi.fn(async () => true),
    };
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.startCommand)
      .mockResolvedValueOnce(setupProcess)
      .mockResolvedValueOnce(previewProcess);
    const { runtime, store } = runtimeFixture(sandbox);
    store.generation = 2;
    const currentFence = { projectId: "project-a", githubBindingGeneration: 2 };

    const start = runtime.startPreview(currentFence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      command: "npm run dev",
      port: 4_321,
    });
    await setupWaitStarted.promise;

    const staleStop = runtime.stopPreview({
      projectId: "project-a",
      githubBindingGeneration: 1,
    });
    expect(setupProcess.kill).not.toHaveBeenCalled();

    setupDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await expect(start).resolves.toEqual({ pid: 42, port: 4_321 });
    await expect(staleStop).rejects.toBeInstanceOf(E2BProjectFenceError);
    expect(setupProcess.kill).not.toHaveBeenCalled();
    await expect(runtime.getPreviewAccess(currentFence, 4_321)).resolves.toMatchObject({
      headers: { "e2b-traffic-access-token": "traffic-a" },
    });

    previewDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
  });

  it("prepares the project Node runtime before opening the sealed preview relay", async () => {
    await writeFile(
      path.join(localRoot, "package.json"),
      JSON.stringify({ engines: { node: ">=22.11 <23" } }),
    );
    const previewDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox();
    const bootstrapProcess: E2BProcess = {
      pid: 41,
      wait: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      kill: vi.fn(async () => true),
    };
    const previewProcess: E2BProcess = {
      pid: 42,
      wait: () => previewDone.promise,
      kill: vi.fn(async () => true),
    };
    vi.mocked(sandbox.startCommand)
      .mockResolvedValueOnce(bootstrapProcess)
      .mockResolvedValueOnce(previewProcess);
    const { runtime } = runtimeFixture(sandbox);

    await runtime.startPreview(
      { projectId: "project-a", githubBindingGeneration: 1 },
      {
        localRoot,
        command: "npm run dev",
        port: 4_321,
      },
    );

    expect(sandbox.startCommand).toHaveBeenCalledTimes(2);
    const bootstrapStart = vi.mocked(sandbox.startCommand).mock.invocationCallOrder[0] ?? 0;
    const relayStart = vi.mocked(sandbox.startPreviewRelay).mock.invocationCallOrder[0] ?? 0;
    const projectStart = vi.mocked(sandbox.startCommand).mock.invocationCallOrder[1] ?? 0;
    expect(bootstrapStart).toBeLessThan(relayStart);
    expect(relayStart).toBeLessThan(projectStart);
    expect(sandbox.startPreviewRelay).toHaveBeenCalledWith(4_321, expect.any(AbortSignal));
    expect(vi.mocked(sandbox.startCommand).mock.calls[1]).toEqual([
      "npm run dev",
      expect.objectContaining({
        envs: expect.objectContaining({
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          COREPACK_HOME: expect.stringContaining("/.quillra/node-runtimes/"),
          HOST: "127.0.0.1",
          PORT: "4321",
        }),
        projectPathPrefix: expect.stringMatching(
          /^\/home\/quillra-project\/\.quillra\/node-runtimes\/[0-9a-f]{32}\/bin$/,
        ),
      }),
    ]);

    previewDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
  });

  it("uses the pinned Node runtime for a static preview without package.json", async () => {
    const previewDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox();
    const bootstrapProcess: E2BProcess = {
      pid: 41,
      wait: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      kill: vi.fn(async () => true),
    };
    const previewProcess: E2BProcess = {
      pid: 42,
      wait: () => previewDone.promise,
      kill: vi.fn(async () => true),
    };
    vi.mocked(sandbox.startCommand)
      .mockResolvedValueOnce(bootstrapProcess)
      .mockResolvedValueOnce(previewProcess);
    const { runtime } = runtimeFixture(sandbox);

    await runtime.startPreview(
      { projectId: "project-a", githubBindingGeneration: 1 },
      {
        localRoot,
        command: "npx vite --host 127.0.0.1",
        port: 4_321,
        defaultNodeRuntime: true,
      },
    );

    expect(sandbox.startCommand).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sandbox.startCommand).mock.calls[1]?.[1]).toMatchObject({
      projectPathPrefix: expect.stringContaining("/.quillra/node-runtimes/"),
    });

    previewDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
  });

  it("ignores a late exit from a superseded preview when E2B reuses its PID", async () => {
    const firstDone = deferred<E2BCommandResult>();
    const secondDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox();
    const firstProcess: E2BProcess = {
      pid: 42,
      wait: vi.fn(() => firstDone.promise),
      kill: vi.fn(async () => true),
    };
    const secondProcess: E2BProcess = {
      pid: 42,
      wait: vi.fn(() => secondDone.promise),
      kill: vi.fn(async () => true),
    };
    vi.mocked(sandbox.startCommand)
      .mockResolvedValueOnce(firstProcess)
      .mockResolvedValueOnce(secondProcess);
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    const firstExit = vi.fn();
    const secondExit = vi.fn();

    await runtime.startPreview(fence, {
      localRoot,
      command: "npm run dev",
      port: 4_321,
      onExit: firstExit,
    });
    await runtime.startPreview(fence, {
      localRoot,
      command: "npm run dev",
      port: 4_321,
      onExit: secondExit,
    });
    vi.mocked(sandbox.quiesceProjectProcesses).mockClear();
    vi.mocked(sandbox.stopPreviewRelay).mockClear();

    firstDone.resolve({ exitCode: 1, stdout: "", stderr: "old preview" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(firstExit).not.toHaveBeenCalled();
    expect(secondExit).not.toHaveBeenCalled();
    expect(sandbox.quiesceProjectProcesses).not.toHaveBeenCalled();
    expect(sandbox.stopPreviewRelay).not.toHaveBeenCalled();
    await expect(runtime.getPreviewAccess(fence, 4_321)).resolves.toMatchObject({
      headers: { "e2b-traffic-access-token": "traffic-a" },
    });

    secondDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await vi.waitFor(() => expect(secondExit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
  });

  it("keeps active-preview cleanup armed when stale stop and destroy fences are rejected", async () => {
    const previewDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox(previewDone.promise);
    const { runtime, store } = runtimeFixture(sandbox);
    const staleFence = { projectId: "project-a", githubBindingGeneration: 1 };
    const onExit = vi.fn();

    await runtime.startPreview(staleFence, {
      localRoot,
      command: "npm run dev",
      port: 4_321,
      onExit,
    });
    store.generation = 2;

    await expect(runtime.stopPreview(staleFence)).rejects.toBeInstanceOf(E2BProjectFenceError);
    await expect(runtime.destroyProject(staleFence)).rejects.toBeInstanceOf(E2BProjectFenceError);

    const result = { exitCode: 1, stdout: "", stderr: "preview exited" };
    previewDone.resolve(result);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(result));
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
  });

  it("invalidates a preview token when stop queues behind an in-progress start", async () => {
    const syncEntered = deferred<void>();
    const allowSync = deferred<void>();
    sync.to.mockImplementationOnce(async () => {
      syncEntered.resolve();
      await allowSync.promise;
      return { entries: 1, bytes: 1 };
    });
    const previewDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox(previewDone.promise);
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    const onExit = vi.fn();

    const start = runtime.startPreview(fence, {
      localRoot,
      command: "npm run dev",
      port: 4_321,
      onExit,
    });
    await syncEntered.promise;
    const stop = runtime.stopPreview(fence);
    allowSync.resolve();

    await expect(start).resolves.toEqual({ pid: 42, port: 4_321 });
    await expect(stop).resolves.toBeUndefined();
    previewDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(onExit).not.toHaveBeenCalled();
    expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce();
  });

  it("surfaces bounded Node bootstrap logs and never opens preview ingress on failure", async () => {
    await writeFile(path.join(localRoot, "package.json"), "{}");
    const sandbox = fakeSandbox();
    const bootstrapProcess: E2BProcess = {
      pid: 41,
      wait: vi.fn(async () => ({
        exitCode: 1,
        stdout: "runtime stdout",
        stderr: "official archive checksum failed",
      })),
      kill: vi.fn(async () => true),
    };
    vi.mocked(sandbox.startCommand).mockResolvedValueOnce(bootstrapProcess);
    const { runtime } = runtimeFixture(sandbox);
    const onStdout = vi.fn();
    const onStderr = vi.fn();

    await expect(
      runtime.startPreview(
        { projectId: "project-a", githubBindingGeneration: 1 },
        {
          localRoot,
          command: "npm run dev",
          port: 4_321,
          onStdout,
          onStderr,
        },
      ),
    ).rejects.toThrow(
      "Quillra could not prepare the project's Node.js runtime.\nstdout:\nruntime stdout\nstderr:\nofficial archive checksum failed",
    );

    expect(onStdout).toHaveBeenCalledWith("runtime stdout");
    expect(onStderr).toHaveBeenCalledWith("official archive checksum failed");
    expect(sandbox.startPreviewRelay).not.toHaveBeenCalled();
    expect(sandbox.startCommand).toHaveBeenCalledOnce();
  });

  it("returns only the protected E2B credential for the fixed trusted relay", async () => {
    const previewDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox(previewDone.promise);
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.startPreview(fence, {
      localRoot,
      command: "npm run dev",
      port: 4_321,
    });

    await expect(runtime.getPreviewAccess(fence, 4_321)).resolves.toEqual({
      origin: "https://733-sandbox.e2b.app",
      headers: { "e2b-traffic-access-token": "traffic-a" },
    });
    expect(sandbox.getHost).toHaveBeenCalledWith(733);
    await expect(runtime.getPreviewAccess(fence, 4_322)).rejects.toThrow(
      "requested E2B preview is not active",
    );
    previewDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
  });

  it("quiesces project descendants before stopping the relay even without a recorded PID", async () => {
    const { runtime, store, sandbox } = runtimeFixture();
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    expect(store.get(fence.projectId)?.previewPid).toBeNull();

    await runtime.stopPreview(fence);

    expect(sandbox.quiesceProjectProcesses).toHaveBeenCalledOnce();
    expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce();
    expect(vi.mocked(sandbox.quiesceProjectProcesses).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.stopPreviewRelay).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("fails closed and does not start project code when the trusted relay fails", async () => {
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.startPreviewRelay).mockRejectedValueOnce(new Error("relay failed"));
    const { runtime, store } = runtimeFixture(sandbox);

    await expect(
      runtime.startPreview(
        { projectId: "project-a", githubBindingGeneration: 1 },
        {
          localRoot,
          command: "npm run dev",
          port: 4_321,
        },
      ),
    ).rejects.toThrow("relay failed");

    expect(sandbox.startCommand).not.toHaveBeenCalled();
    expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce();
    expect(store.get("project-a")?.previewPid).toBeNull();
  });

  it("discards the sandbox when trusted relay startup fails and cleanup is confirmed", async () => {
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.startPreviewRelay).mockRejectedValueOnce(
      new E2BTrustedEnvironmentError("relay-start"),
    );
    const { runtime, store } = runtimeFixture(sandbox);

    await expect(
      runtime.startPreview(
        { projectId: "project-a", githubBindingGeneration: 1 },
        {
          localRoot,
          command: "npm run dev",
          port: 4_321,
        },
      ),
    ).rejects.toMatchObject({
      name: "E2BTrustedEnvironmentError",
      stage: "relay-start",
      cleanupStatus: "confirmed",
      message: "The E2B trusted execution environment could not be prepared.",
    });

    expect(sandbox.startCommand).not.toHaveBeenCalled();
    expect(sandbox.kill).toHaveBeenCalledOnce();
    expect(sandbox.stopPreviewRelay).not.toHaveBeenCalled();
    expect(store.get("project-a")).toBeNull();
  });

  it("retains a cleanup-retry record when trusted relay startup cleanup fails", async () => {
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.startPreviewRelay).mockRejectedValueOnce(
      new E2BTrustedEnvironmentError("relay-ready"),
    );
    vi.mocked(sandbox.kill).mockRejectedValueOnce(
      new Error("provider response containing sensitive details"),
    );
    const { runtime, store } = runtimeFixture(sandbox);

    await expect(
      runtime.startPreview(
        { projectId: "project-a", githubBindingGeneration: 1 },
        {
          localRoot,
          command: "npm run dev",
          port: 4_321,
        },
      ),
    ).rejects.toMatchObject({
      name: "E2BTrustedEnvironmentError",
      stage: "relay-ready",
      cleanupStatus: "failed",
      message:
        "The E2B trusted execution environment failed and its cleanup could not be confirmed.",
    });

    expect(sandbox.startCommand).not.toHaveBeenCalled();
    expect(sandbox.kill).toHaveBeenCalledOnce();
    expect(sandbox.stopPreviewRelay).not.toHaveBeenCalled();
    expect(store.get("project-a")).toMatchObject({
      sandboxId: "sandbox-a",
      previewPid: null,
      previewPort: null,
    });
  });
});
