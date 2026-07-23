import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.hoisted(() => ({
  to: vi.fn(async () => ({ entries: 1, bytes: 1 })),
  from: vi.fn(async () => ({ entries: 1, bytes: 1 })),
}));

vi.mock("./e2b-workspace-sync.js", () => ({
  E2B_WORKSPACE_ROOT: "/home/user/quillra-workspace",
  E2B_PREVIEW_ROOT: "/home/user/quillra-preview",
  syncLocalWorkspaceToE2B: sync.to,
  syncE2BWorkspaceToLocal: sync.from,
}));

import type { E2BAdapter, E2BCommandResult, E2BProcess, E2BSandboxHandle } from "./e2b-adapter.js";
import {
  type E2BProjectFence,
  E2BProjectFenceError,
  type E2BProjectSandboxRecord,
  type E2BProjectSandboxStore,
  E2BRuntime,
} from "./e2b-runtime.js";

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
    getHost: vi.fn(() => "4321-sandbox.e2b.app"),
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
      expect.objectContaining({ remoteRoot: "/home/user/quillra-preview" }),
    );
    expect(sync.from).not.toHaveBeenCalled();
    expect(sandbox.startCommand).toHaveBeenCalledWith(
      "npm run dev",
      expect.objectContaining({
        cwd: "/home/user/quillra-preview",
        envs: { HOST: "0.0.0.0", PORT: "4321" },
      }),
    );

    const result = { exitCode: 2, stdout: "", stderr: "failed" };
    previewDone.resolve(result);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(result));
    expect(sync.from).not.toHaveBeenCalled();
  });

  it("returns only the protected E2B upstream credential", async () => {
    const { runtime } = runtimeFixture();
    await expect(
      runtime.getPreviewAccess({ projectId: "project-a", githubBindingGeneration: 1 }, 4_321),
    ).resolves.toEqual({
      origin: "https://4321-sandbox.e2b.app",
      headers: { "e2b-traffic-access-token": "traffic-a" },
    });
  });
});
