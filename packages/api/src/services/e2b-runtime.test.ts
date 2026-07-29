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

import {
  type E2BAdapter,
  type E2BCommandResult,
  type E2BProcess,
  E2BProcessMonitorError,
  type E2BSandboxHandle,
} from "./e2b-adapter.js";
import { E2BTrustedEnvironmentError } from "./e2b-preview-relay.js";
import {
  E2BActivePreviewError,
  type E2BProjectFence,
  E2BProjectFenceError,
  type E2BProjectSandboxRecord,
  type E2BProjectSandboxStore,
  E2BRuntime,
  type E2BRuntimeConfig,
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function completedProcess(
  result: E2BCommandResult = { exitCode: 0, stdout: "", stderr: "" },
  pid = 41,
): E2BProcess {
  return {
    pid,
    wait: vi.fn(async () => result),
    kill: vi.fn(async () => true),
  };
}

function fakeSandbox(
  processResult?: Promise<E2BCommandResult>,
  sandboxId = "sandbox-a",
): E2BSandboxHandle {
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
    sandboxId,
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

function emulateSandboxFiles(sandbox: E2BSandboxHandle): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  vi.mocked(sandbox.exists).mockImplementation(async (filePath) => files.has(filePath));
  vi.mocked(sandbox.readFileChunk).mockImplementation(async (filePath, offset, length) => {
    const data = files.get(filePath);
    if (!data) throw new Error("missing");
    return data.slice(offset, offset + length);
  });
  vi.mocked(sandbox.writeFiles).mockImplementation(async (writes) => {
    for (const write of writes) files.set(write.path, Uint8Array.from(write.data));
  });
  vi.mocked(sandbox.remove).mockImplementation(async (filePath) => {
    files.delete(filePath);
  });
  return files;
}

function recordNpmInstallArtifact(
  files: Map<string, Uint8Array>,
  remoteRoot = "/home/quillra-project/quillra-preview",
): void {
  files.set(`${remoteRoot}/node_modules/.package-lock.json`, Buffer.from("{}"));
}

function recordPnpmInstallArtifact(
  files: Map<string, Uint8Array>,
  remoteRoot = "/home/quillra-project/quillra-preview",
): void {
  files.set(`${remoteRoot}/node_modules/.modules.yaml`, Buffer.from("nodeLinker: isolated\n"));
}

const TEST_RUNTIME_CONFIG: E2BRuntimeConfig = {
  apiKey: "e2b_control_plane_key",
  templateId: "base",
  sandboxTimeoutMs: 900_000,
  requestTimeoutMs: 60_000,
};

function runtimeFixture(
  sandbox = fakeSandbox(),
  config: E2BRuntimeConfig | (() => E2BRuntimeConfig) = TEST_RUNTIME_CONFIG,
) {
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
    config,
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
  vi.restoreAllMocks();
});

describe("E2B runtime", () => {
  it("persists and reuses exactly one live handle for concurrent project access", async () => {
    const { runtime, adapter, store } = runtimeFixture();
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };

    const [first, second] = await Promise.all([
      runtime.ensureProject(fence),
      runtime.ensureProject(fence),
    ]);

    expect(first.sandboxId).toBe("sandbox-a");
    expect(second.sandboxId).toBe("sandbox-a");
    expect(adapter.create).toHaveBeenCalledOnce();
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(1);
    expect(adapter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "e2b_control_plane_key",
        allowInternetAccess: true,
        projectId: "project-a",
      }),
    );
  });

  it("reconnects after the short-lived handle TTL expires", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { runtime, adapter } = runtimeFixture();
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };

    await runtime.ensureProject(fence);
    now.mockReturnValue(1_299_999);
    await runtime.ensureProject(fence);
    expect(adapter.connect).not.toHaveBeenCalled();

    now.mockReturnValue(1_300_000);
    await runtime.ensureProject(fence);
    expect(adapter.connect).toHaveBeenCalledOnce();
  });

  it("never reuses a handle for a different persisted sandbox id", async () => {
    const firstSandbox = fakeSandbox(undefined, "sandbox-a");
    const secondSandbox = fakeSandbox(undefined, "sandbox-b");
    const { runtime, adapter, store } = runtimeFixture(firstSandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    const record = store.get(fence.projectId);
    expect(record).not.toBeNull();
    store.save({ ...(record as E2BProjectSandboxRecord), sandboxId: "sandbox-b" });
    vi.mocked(adapter.connect).mockResolvedValueOnce(secondSandbox);

    await expect(runtime.ensureProject(fence)).resolves.toEqual({ sandboxId: "sandbox-b" });
    await runtime.ensureProject(fence);

    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(firstSandbox.makeDir).toHaveBeenCalledTimes(2);
    expect(secondSandbox.makeDir).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a handle after connection credentials change", async () => {
    let config = { ...TEST_RUNTIME_CONFIG };
    const { runtime, adapter } = runtimeFixture(fakeSandbox(), () => config);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    config = { ...config, apiKey: "e2b_replacement_control_plane_key" };

    await runtime.ensureProject(fence);

    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(adapter.connect).toHaveBeenCalledWith(
      "sandbox-a",
      expect.objectContaining({ apiKey: "e2b_replacement_control_plane_key" }),
    );
  });

  it("replaces the cached handle when the configured template changes", async () => {
    let config = { ...TEST_RUNTIME_CONFIG };
    const firstSandbox = fakeSandbox(undefined, "sandbox-a");
    const secondSandbox = fakeSandbox(undefined, "sandbox-b");
    const { runtime, adapter } = runtimeFixture(firstSandbox, () => config);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    config = { ...config, templateId: "quillra-v2" };
    vi.mocked(adapter.create).mockResolvedValueOnce(secondSandbox);

    await expect(runtime.ensureProject(fence)).resolves.toEqual({ sandboxId: "sandbox-b" });
    await runtime.ensureProject(fence);

    expect(adapter.destroy).toHaveBeenCalledWith("sandbox-a", expect.any(Object));
    expect(adapter.create).toHaveBeenCalledTimes(2);
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("does not let a stale fence evict a newer binding handle", async () => {
    const firstSandbox = fakeSandbox(undefined, "sandbox-a");
    const secondSandbox = fakeSandbox(undefined, "sandbox-b");
    const { runtime, adapter, store } = runtimeFixture(firstSandbox);
    await runtime.ensureProject({ projectId: "project-a", githubBindingGeneration: 1 });
    store.generation = 2;
    vi.mocked(adapter.create).mockResolvedValueOnce(secondSandbox);
    const currentFence = { projectId: "project-a", githubBindingGeneration: 2 };
    await runtime.ensureProject(currentFence);
    vi.clearAllMocks();

    await expect(
      runtime.ensureProject({ projectId: "project-a", githubBindingGeneration: 1 }),
    ).rejects.toBeInstanceOf(E2BProjectFenceError);
    await expect(runtime.ensureProject(currentFence)).resolves.toEqual({ sandboxId: "sandbox-b" });

    expect(adapter.create).not.toHaveBeenCalled();
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("drops a not-found handle and creates a newly tracked sandbox", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const firstSandbox = fakeSandbox(undefined, "sandbox-a");
    const secondSandbox = fakeSandbox(undefined, "sandbox-b");
    const { runtime, adapter, store } = runtimeFixture(firstSandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    now.mockReturnValue(1_300_000);
    const notFound = new Error("gone");
    vi.mocked(adapter.connect).mockRejectedValueOnce(notFound);
    vi.mocked(adapter.isNotFound).mockImplementation((error) => error === notFound);
    vi.mocked(adapter.create).mockResolvedValueOnce(secondSandbox);

    await expect(runtime.ensureProject(fence)).resolves.toEqual({ sandboxId: "sandbox-b" });

    expect(store.get(fence.projectId)?.sandboxId).toBe("sandbox-b");
    expect(adapter.create).toHaveBeenCalledTimes(2);
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

  it("ensures and reuses dependencies inside the same finite command operation", async () => {
    const sandbox = fakeSandbox();
    const files = emulateSandboxFiles(sandbox);
    const setupCommand =
      "NODE_ENV=development NPM_CONFIG_PRODUCTION=false COREPACK_ENABLE_AUTO_PIN=0 " +
      "COREPACK_DEFAULT_TO_LATEST=0 COREPACK_ENABLE_PROJECT_SPEC=0 " +
      "'npm' 'install' '--include=dev'";
    vi.mocked(sandbox.startCommand).mockImplementation(async (command) => {
      if (command === setupCommand) {
        recordNpmInstallArtifact(files, "/home/quillra-project/quillra-workspace");
      }
      return completedProcess();
    });
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    const firstSetup = vi.fn();
    const cachedSetup = vi.fn();

    await runtime.runCommand(fence, {
      localRoot,
      setupCommand,
      setupCacheKey: "dependencies-a",
      command: "npm run build",
      onSetupStart: firstSetup,
    });
    await runtime.runCommand(fence, {
      localRoot,
      setupCommand,
      setupCacheKey: "dependencies-a",
      command: "npm test",
      onSetupStart: cachedSetup,
    });

    const calls = vi.mocked(sandbox.startCommand).mock.calls;
    expect(calls.map(([command]) => command)).toEqual([setupCommand, "npm run build", "npm test"]);
    expect(calls[0]?.[1]).toMatchObject({
      cwd: "/home/quillra-project/quillra-workspace",
    });
    expect(firstSetup).toHaveBeenCalledOnce();
    expect(cachedSetup).not.toHaveBeenCalled();
    expect(sandbox.writeFiles).toHaveBeenCalledOnce();
  });

  it("does not cache a finite-command setup whose artifacts cannot be proven", async () => {
    const sandbox = fakeSandbox();
    emulateSandboxFiles(sandbox);
    vi.mocked(sandbox.startCommand).mockImplementation(async () => completedProcess());
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };

    for (const command of ["yarn build", "yarn test"]) {
      await runtime.runCommand(fence, {
        localRoot,
        setupCommand: "corepack yarn install",
        setupCacheKey: "dependencies-a",
        command,
      });
    }

    expect(
      vi
        .mocked(sandbox.startCommand)
        .mock.calls.filter(([command]) => command === "corepack yarn install"),
    ).toHaveLength(2);
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it("invalidates an npm marker when an uncacheable manager runs between npm commands", async () => {
    const sandbox = fakeSandbox();
    const files = emulateSandboxFiles(sandbox);
    vi.mocked(sandbox.startCommand).mockImplementation(async (command) => {
      if (command === "npm install --include=dev") {
        recordNpmInstallArtifact(files, "/home/quillra-project/quillra-workspace");
      }
      return completedProcess();
    });
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };

    await runtime.runCommand(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      setupCacheKey: "dependencies-a",
      command: "npm run build",
    });
    await runtime.runCommand(fence, {
      localRoot,
      setupCommand: "corepack yarn install",
      setupCacheKey: "dependencies-yarn",
      command: "yarn build",
    });
    await runtime.runCommand(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      setupCacheKey: "dependencies-a",
      command: "npm test",
    });

    expect(
      vi
        .mocked(sandbox.startCommand)
        .mock.calls.filter(([command]) => command === "npm install --include=dev"),
    ).toHaveLength(2);
    expect(
      vi
        .mocked(sandbox.startCommand)
        .mock.calls.filter(([command]) => command === "corepack yarn install"),
    ).toHaveLength(1);
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(2);
  });

  it("does not start a finite command when its dependency setup fails", async () => {
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.startCommand).mockImplementation(async (command) => {
      if (command === "npm install --include=dev") {
        return completedProcess({ exitCode: 1, stdout: "", stderr: "install failed" });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { runtime } = runtimeFixture(sandbox);

    await expect(
      runtime.runCommand(
        { projectId: "project-a", githubBindingGeneration: 1 },
        {
          localRoot,
          setupCommand: "npm install --include=dev",
          setupCacheKey: "dependencies-a",
          command: "npm run build",
        },
      ),
    ).rejects.toThrow("E2B preview setup failed with exit code 1");

    expect(sandbox.startCommand).toHaveBeenCalledOnce();
    expect(sync.from).toHaveBeenCalledOnce();
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
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const sandbox = fakeSandbox();
    const { runtime, adapter } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    now.mockReturnValue(1_300_000);
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
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const sandbox = fakeSandbox();
    const { runtime, adapter, store } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    now.mockReturnValue(1_300_000);
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

  it("keeps the live handle across an ordinary preview stop", async () => {
    const { runtime, adapter } = runtimeFixture();
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);

    await runtime.stopPreview(fence);
    await runtime.ensureProject(fence);

    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("invalidates the live handle when the sandbox is paused", async () => {
    const { runtime, adapter, sandbox } = runtimeFixture();
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);

    await runtime.pauseProject(fence);
    await runtime.ensureProject(fence);

    expect(sandbox.pause).toHaveBeenCalledOnce();
    expect(adapter.connect).toHaveBeenCalledOnce();
  });

  it("invalidates the live handle before destroying its sandbox", async () => {
    const firstSandbox = fakeSandbox(undefined, "sandbox-a");
    const secondSandbox = fakeSandbox(undefined, "sandbox-b");
    const { runtime, adapter } = runtimeFixture(firstSandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);
    vi.mocked(adapter.create).mockResolvedValueOnce(secondSandbox);

    await runtime.destroyProject(fence);
    await expect(runtime.ensureProject(fence)).resolves.toEqual({ sandboxId: "sandbox-b" });

    expect(adapter.destroy).toHaveBeenCalledWith("sandbox-a", expect.any(Object));
    expect(adapter.create).toHaveBeenCalledTimes(2);
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("invalidates every live handle when credential rotation starts", async () => {
    const { runtime, adapter } = runtimeFixture();
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    await runtime.ensureProject(fence);

    await runtime.withCredentialRotation(async () => undefined);
    await runtime.ensureProject(fence);

    expect(adapter.connect).toHaveBeenCalledOnce();
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
        timeoutMs: 0,
        envs: { HOST: "127.0.0.1", PORT: "4321" },
      }),
    );

    const result = { exitCode: 2, stdout: "", stderr: "failed" };
    previewDone.resolve(result);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(result));
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
    expect(sync.from).not.toHaveBeenCalled();
  });

  it("reports a monitor failure separately from a confirmed process exit and fails closed", async () => {
    const previewDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox(previewDone.promise);
    const { runtime, store } = runtimeFixture(sandbox);
    const onExit = vi.fn();
    const onMonitorFailure = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runtime.startPreview(
      { projectId: "project-a", githubBindingGeneration: 1 },
      {
        localRoot,
        command: "npm run dev",
        port: 4_321,
        onExit,
        onMonitorFailure,
      },
    );

    previewDone.reject(
      new E2BProcessMonitorError(
        "monitor-unavailable",
        "token=should-not-leak",
        "Bearer secret-value",
        "ConnectError",
      ),
    );

    await vi.waitFor(() =>
      expect(onMonitorFailure).toHaveBeenCalledWith({
        reason: "monitor-unavailable",
        message: "The secure preview connection was lost.",
        stdout: "token=should-not-leak",
        stderr: "Bearer secret-value",
        causeName: "ConnectError",
      }),
    );
    expect(onExit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
    expect(store.get("project-a")).toMatchObject({
      previewPid: null,
      previewPort: null,
    });
    expect(getPreviewUpstream("project-a", 4_321)).toBeNull();
    const monitorLog = errorLog.mock.calls
      .flat()
      .find((value) => typeof value === "string" && value.includes('"event":"monitor-failed"'));
    expect(monitorLog).toContain('"projectId":"project-a"');
    expect(monitorLog).toContain('"pid":42');
    expect(monitorLog).toContain('"port":4321');
    expect(monitorLog).toContain('"cause":"monitor-unavailable:ConnectError"');
    expect(monitorLog).toContain("[redacted]");
    expect(monitorLog).not.toContain("should-not-leak");
    expect(monitorLog).not.toContain("secret-value");
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
    const { runtime, adapter } = runtimeFixture(sandbox);
    const onSetupStart = vi.fn();
    const onSetupComplete = vi.fn();

    const started = await runtime.startPreview(
      { projectId: "project-a", githubBindingGeneration: 1 },
      {
        localRoot,
        setupCommand: "npm install --include=dev",
        setupCacheKey: "dependencies-a",
        command: "npm run dev",
        port: 4_321,
        onSetupStart,
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
    expect(onSetupStart).toHaveBeenCalledOnce();
    expect(onSetupStart.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.startCommand).mock.invocationCallOrder[0] ?? 0,
    );
    expect(vi.mocked(setupProcess.wait).mock.invocationCallOrder[0]).toBeLessThan(
      onSetupComplete.mock.invocationCallOrder[0] ?? 0,
    );
    expect(sandbox.writeFiles).toHaveBeenCalledOnce();
    expect(vi.mocked(sandbox.writeFiles).mock.invocationCallOrder[0]).toBeLessThan(
      onSetupComplete.mock.invocationCallOrder[0] ?? 0,
    );
    expect(onSetupComplete.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.startPreviewRelay).mock.invocationCallOrder[0] ?? 0,
    );
    expect(vi.mocked(sandbox.startPreviewRelay).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.startCommand).mock.invocationCallOrder[1] ?? 0,
    );
    expect(started).toEqual({
      pid: 42,
      port: 4_321,
      access: {
        origin: "https://733-sandbox.e2b.app",
        headers: { "e2b-traffic-access-token": "traffic-a" },
      },
    });
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(sandbox.getHost).toHaveBeenCalledWith(733);

    previewDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await vi.waitFor(() => expect(sandbox.stopPreviewRelay).toHaveBeenCalledOnce());
  });

  it("reuses successful preview setup only for the same cache key and Node runtime", async () => {
    const sandbox = fakeSandbox();
    const files = emulateSandboxFiles(sandbox);
    const previewResults = [
      deferred<E2BCommandResult>(),
      deferred<E2BCommandResult>(),
      deferred<E2BCommandResult>(),
    ];
    let previewIndex = 0;
    vi.mocked(sandbox.startCommand).mockImplementation(async (command) => {
      if (command === "npm install --include=dev") {
        recordNpmInstallArtifact(files);
        return completedProcess();
      }
      if (command === "npm run dev") {
        const result = previewResults[previewIndex++];
        if (!result) throw new Error("unexpected preview start");
        return {
          pid: 42,
          wait: () => result.promise,
          kill: vi.fn(async () => true),
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    const firstStart = vi.fn();
    const firstComplete = vi.fn();
    const cachedStart = vi.fn();
    const cachedComplete = vi.fn();
    const changedStart = vi.fn();
    const changedComplete = vi.fn();

    await runtime.startPreview(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      setupCacheKey: "dependencies-a",
      command: "npm run dev",
      port: 4_321,
      onSetupStart: firstStart,
      onSetupComplete: firstComplete,
    });
    await runtime.startPreview(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      setupCacheKey: "dependencies-a",
      command: "npm run dev",
      port: 4_321,
      onSetupStart: cachedStart,
      onSetupComplete: cachedComplete,
    });
    await runtime.startPreview(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      setupCacheKey: "dependencies-b",
      command: "npm run dev",
      port: 4_321,
      onSetupStart: changedStart,
      onSetupComplete: changedComplete,
    });

    const commands = vi.mocked(sandbox.startCommand).mock.calls.map(([command]) => command);
    expect(commands.filter((command) => command === "npm install --include=dev")).toHaveLength(2);
    expect(firstStart).toHaveBeenCalledOnce();
    expect(firstComplete).toHaveBeenCalledOnce();
    expect(cachedStart).not.toHaveBeenCalled();
    expect(cachedComplete).toHaveBeenCalledOnce();
    expect(changedStart).toHaveBeenCalledOnce();
    expect(changedComplete).toHaveBeenCalledOnce();
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(2);

    for (const result of previewResults) {
      result.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }
  });

  it("reuses ordinary pnpm setup but reruns it when its generated artifact is deleted", async () => {
    const sandbox = fakeSandbox();
    const files = emulateSandboxFiles(sandbox);
    const previewResults = [
      deferred<E2BCommandResult>(),
      deferred<E2BCommandResult>(),
      deferred<E2BCommandResult>(),
    ];
    let previewIndex = 0;
    const setupCommand =
      "NODE_ENV=development NPM_CONFIG_PRODUCTION=false COREPACK_ENABLE_AUTO_PIN=0 " +
      "COREPACK_DEFAULT_TO_LATEST=0 COREPACK_ENABLE_PROJECT_SPEC=0 " +
      "'corepack' 'pnpm@10.34.0' 'install' '--prod=false'";
    vi.mocked(sandbox.startCommand).mockImplementation(async (command) => {
      if (command === setupCommand) {
        recordPnpmInstallArtifact(files);
        return completedProcess();
      }
      const result = previewResults[previewIndex++];
      if (!result) throw new Error("unexpected preview start");
      return {
        pid: 42,
        wait: () => result.promise,
        kill: vi.fn(async () => true),
      };
    });
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    const options = {
      localRoot,
      setupCommand,
      setupCacheKey: "dependencies-a",
      command: "pnpm dev",
      port: 4_321,
    };

    await runtime.startPreview(fence, options);
    await runtime.startPreview(fence, options);
    expect(
      vi.mocked(sandbox.startCommand).mock.calls.filter(([command]) => command === setupCommand),
    ).toHaveLength(1);

    files.delete("/home/quillra-project/quillra-preview/node_modules/.modules.yaml");
    await runtime.startPreview(fence, options);

    expect(
      vi.mocked(sandbox.startCommand).mock.calls.filter(([command]) => command === setupCommand),
    ).toHaveLength(2);
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(2);

    for (const result of previewResults) {
      result.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }
  });

  it("does not reuse a preview setup marker from a replaced sandbox", async () => {
    const firstPreview = deferred<E2BCommandResult>();
    const firstSandbox = fakeSandbox(undefined, "sandbox-a");
    emulateSandboxFiles(firstSandbox);
    vi.mocked(firstSandbox.startCommand).mockImplementation(async (command) => {
      if (command === "npm install --include=dev") return completedProcess();
      return {
        pid: 42,
        wait: () => firstPreview.promise,
        kill: vi.fn(async () => true),
      };
    });
    const { runtime, adapter } = runtimeFixture(firstSandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };

    await runtime.startPreview(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      setupCacheKey: "dependencies-a",
      command: "npm run dev",
      port: 4_321,
    });
    await runtime.destroyProject(fence);

    const secondPreview = deferred<E2BCommandResult>();
    const secondSandbox = fakeSandbox(undefined, "sandbox-b");
    emulateSandboxFiles(secondSandbox);
    vi.mocked(secondSandbox.startCommand).mockImplementation(async (command) => {
      if (command === "npm install --include=dev") return completedProcess();
      return {
        pid: 43,
        wait: () => secondPreview.promise,
        kill: vi.fn(async () => true),
      };
    });
    vi.mocked(adapter.create).mockResolvedValueOnce(secondSandbox);

    await runtime.startPreview(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      setupCacheKey: "dependencies-a",
      command: "npm run dev",
      port: 4_321,
    });

    expect(
      vi
        .mocked(firstSandbox.startCommand)
        .mock.calls.filter(([command]) => command === "npm install --include=dev"),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(secondSandbox.startCommand)
        .mock.calls.filter(([command]) => command === "npm install --include=dev"),
    ).toHaveLength(1);

    firstPreview.resolve({ exitCode: 0, stdout: "", stderr: "" });
    secondPreview.resolve({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("does not cache a failed preview setup", async () => {
    const sandbox = fakeSandbox();
    const files = emulateSandboxFiles(sandbox);
    const previewDone = deferred<E2BCommandResult>();
    let setupAttempt = 0;
    vi.mocked(sandbox.startCommand).mockImplementation(async (command) => {
      if (command === "npm install --include=dev") {
        setupAttempt += 1;
        if (setupAttempt > 1) recordNpmInstallArtifact(files);
        return completedProcess(
          setupAttempt === 1
            ? { exitCode: 1, stdout: "", stderr: "install failed" }
            : { exitCode: 0, stdout: "", stderr: "" },
        );
      }
      return {
        pid: 42,
        wait: () => previewDone.promise,
        kill: vi.fn(async () => true),
      };
    });
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };
    const onSetupStart = vi.fn();
    const onSetupComplete = vi.fn();

    await expect(
      runtime.startPreview(fence, {
        localRoot,
        setupCommand: "npm install --include=dev",
        setupCacheKey: "dependencies-a",
        command: "npm run dev",
        port: 4_321,
        onSetupStart,
        onSetupComplete,
      }),
    ).rejects.toThrow("E2B preview setup failed with exit code 1");
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
    expect(onSetupComplete).not.toHaveBeenCalled();

    await runtime.startPreview(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      setupCacheKey: "dependencies-a",
      command: "npm run dev",
      port: 4_321,
      onSetupStart,
      onSetupComplete,
    });

    expect(setupAttempt).toBe(2);
    expect(onSetupStart).toHaveBeenCalledTimes(2);
    expect(onSetupComplete).toHaveBeenCalledOnce();
    expect(sandbox.writeFiles).toHaveBeenCalledOnce();

    previewDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("treats setup marker I/O failures as cache misses without blocking preview startup", async () => {
    const previewDone = deferred<E2BCommandResult>();
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.exists).mockRejectedValueOnce(new Error("marker read unavailable"));
    vi.mocked(sandbox.writeFiles).mockRejectedValueOnce(new Error("marker write unavailable"));
    vi.mocked(sandbox.startCommand)
      .mockResolvedValueOnce(completedProcess())
      .mockResolvedValueOnce({
        pid: 42,
        wait: () => previewDone.promise,
        kill: vi.fn(async () => true),
      });
    const { runtime } = runtimeFixture(sandbox);
    const onSetupStart = vi.fn();
    const onSetupComplete = vi.fn();

    await expect(
      runtime.startPreview(
        { projectId: "project-a", githubBindingGeneration: 1 },
        {
          localRoot,
          setupCommand: "npm install --include=dev",
          setupCacheKey: "dependencies-a",
          command: "npm run dev",
          port: 4_321,
          onSetupStart,
          onSetupComplete,
        },
      ),
    ).resolves.toMatchObject({ pid: 42, port: 4_321 });

    expect(onSetupStart).toHaveBeenCalledOnce();
    expect(onSetupComplete).toHaveBeenCalledOnce();
    expect(sandbox.startCommand).toHaveBeenCalledTimes(2);
    expect(sandbox.writeFiles).toHaveBeenCalledOnce();

    previewDone.resolve({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("invalidates preview setup when the resolved Node runtime changes", async () => {
    await writeFile(
      path.join(localRoot, "package.json"),
      JSON.stringify({ volta: { node: "22.23.1" } }),
    );
    const sandbox = fakeSandbox();
    const files = emulateSandboxFiles(sandbox);
    const previewResults = [deferred<E2BCommandResult>(), deferred<E2BCommandResult>()];
    let previewIndex = 0;
    vi.mocked(sandbox.startCommand).mockImplementation(async (command) => {
      if (command === "npm install --include=dev") {
        recordNpmInstallArtifact(files);
        return completedProcess();
      }
      if (command === "npm run dev") {
        const result = previewResults[previewIndex++];
        if (!result) throw new Error("unexpected preview start");
        return {
          pid: 42,
          wait: () => result.promise,
          kill: vi.fn(async () => true),
        };
      }
      return completedProcess();
    });
    const { runtime } = runtimeFixture(sandbox);
    const fence = { projectId: "project-a", githubBindingGeneration: 1 };

    await runtime.startPreview(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      setupCacheKey: "dependencies-a",
      command: "npm run dev",
      port: 4_321,
    });
    await writeFile(
      path.join(localRoot, "package.json"),
      JSON.stringify({ volta: { node: "24.18.0" } }),
    );
    await runtime.startPreview(fence, {
      localRoot,
      setupCommand: "npm install --include=dev",
      setupCacheKey: "dependencies-a",
      command: "npm run dev",
      port: 4_321,
    });

    expect(
      vi
        .mocked(sandbox.startCommand)
        .mock.calls.filter(([command]) => command === "npm install --include=dev"),
    ).toHaveLength(2);
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(2);
    const firstMarker = vi.mocked(sandbox.writeFiles).mock.calls[0]?.[0][0]?.data;
    const secondMarker = vi.mocked(sandbox.writeFiles).mock.calls[1]?.[0][0]?.data;
    expect(Buffer.from(firstMarker ?? []).toString("utf8")).not.toBe(
      Buffer.from(secondMarker ?? []).toString("utf8"),
    );

    for (const result of previewResults) {
      result.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }
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

  it("cancels only an exact-generation pending preview start without reconnecting", async () => {
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
    const { runtime, adapter } = runtimeFixture(sandbox);
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

    runtime.cancelPendingPreviewStart({
      projectId: fence.projectId,
      githubBindingGeneration: 2,
    });
    expect(setupProcess.kill).not.toHaveBeenCalled();
    runtime.cancelPendingPreviewStart(fence);

    await expect(startFailure).resolves.toMatchObject({
      name: "AbortError",
      message: "The preview start was stopped.",
    });
    expect(setupProcess.kill).toHaveBeenCalledOnce();
    expect(adapter.connect).not.toHaveBeenCalled();
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
    await expect(start).resolves.toMatchObject({ pid: 42, port: 4_321 });
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

    await expect(start).resolves.toMatchObject({ pid: 42, port: 4_321 });
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
    const upstream = {
      origin: "https://733-sandbox.e2b.app",
      headers: { "e2b-traffic-access-token": "traffic-a" },
    };
    registerPreviewUpstream(fence.projectId, 4_321, upstream);

    await expect(runtime.getPreviewAccess(fence, 4_321)).resolves.toEqual(upstream);
    expect(getPreviewUpstream(fence.projectId, 4_321)).toEqual(upstream);
    expect(sandbox.getHost).toHaveBeenCalledWith(733);
    await expect(runtime.getPreviewAccess(fence, 4_322)).rejects.toThrow(
      "requested E2B preview is not active",
    );
    expect(getPreviewUpstream(fence.projectId, 4_321)).toEqual(upstream);
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
