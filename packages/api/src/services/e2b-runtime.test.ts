import { mkdtemp, rm } from "node:fs/promises";
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

  it("quiesces daemons and disables preview ingress before sync and again before writeback", async () => {
    const commandDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox(commandDone.promise);
    const { runtime, store } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    store.setPreview(fence.projectId, sandbox.sandboxId, { pid: 99, port: 4_321 });
    vi.clearAllMocks();

    const execution = runtime.runCommand(fence, {
      localRoot,
      command: "build-and-daemonize",
    });
    await vi.waitFor(() => expect(sandbox.startCommand).toHaveBeenCalledOnce());

    expect(store.get(fence.projectId)?.previewPid).toBeNull();
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

  it("stabilizes a direct workspace sync and clears stale preview state first", async () => {
    const sandbox = fakeSandbox();
    const { runtime, store } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    store.setPreview(fence.projectId, sandbox.sandboxId, { pid: 99, port: 4_321 });
    vi.clearAllMocks();

    sync.to.mockImplementationOnce(async () => {
      expect(store.get(fence.projectId)?.previewPid).toBeNull();
      return { entries: 1, bytes: 1 };
    });
    await runtime.syncToSandbox(fence, localRoot);

    expect(sandbox.quiesceProjectProcesses).toHaveBeenCalledOnce();
    expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce();
    expect(vi.mocked(sandbox.quiesceProjectProcesses).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.stopPreviewRelay).mock.invocationCallOrder[0] ?? 0,
    );
    expect(vi.mocked(sandbox.stopPreviewRelay).mock.invocationCallOrder[0]).toBeLessThan(
      sync.to.mock.invocationCallOrder[0] ?? 0,
    );
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
    expect(sandbox.startPreviewRelay).toHaveBeenCalledWith(4_321, undefined);
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
