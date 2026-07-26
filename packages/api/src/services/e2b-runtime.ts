import { rawSqlite } from "../db/index.js";
import {
  type E2BAdapter,
  type E2BCommandResult,
  type E2BProcess,
  type E2BSandboxHandle,
  E2BSdkAdapter,
} from "./e2b-adapter.js";
import {
  type E2BSyncLimits,
  E2B_PREVIEW_ROOT,
  E2B_WORKSPACE_ROOT,
  syncE2BWorkspaceToLocal,
  syncLocalWorkspaceToE2B,
} from "./e2b-workspace-sync.js";
import { getInstanceSetting } from "./instance-settings.js";

const DEFAULT_TEMPLATE_ID = "base";
const SANDBOX_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MIN_COMMAND_TIMEOUT_MS = 1_000;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES_PER_STREAM = 2 * 1024 * 1024;

export type E2BProjectFence = {
  projectId: string;
  githubBindingGeneration: number;
};

export type E2BRuntimeConfig = {
  apiKey: string;
  templateId: string;
  sandboxTimeoutMs: number;
  requestTimeoutMs: number;
};

export type E2BProjectSandboxRecord = {
  projectId: string;
  sandboxId: string;
  githubBindingGeneration: number;
  templateId: string;
  previewPid: number | null;
  previewPort: number | null;
};

export interface E2BProjectSandboxStore {
  assertFence(fence: E2BProjectFence): void | Promise<void>;
  get(projectId: string): E2BProjectSandboxRecord | null;
  list(): E2BProjectSandboxRecord[];
  save(record: E2BProjectSandboxRecord): void;
  setPreview(
    projectId: string,
    sandboxId: string,
    preview: { pid: number; port: number } | null,
  ): void;
  delete(projectId: string, sandboxId?: string): void;
}

export class E2BRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2BRuntimeConfigurationError";
  }
}

export class E2BProjectFenceError extends Error {
  constructor(message = "The project repository binding changed during E2B execution.") {
    super(message);
    this.name = "E2BProjectFenceError";
  }
}

function readRuntimeConfig(): E2BRuntimeConfig {
  if (getInstanceSetting("E2B_ENABLED") !== "true") {
    throw new E2BRuntimeConfigurationError(
      "Secure execution is disabled. Complete the E2B setup before running project code.",
    );
  }
  const apiKey = getInstanceSetting("E2B_API_KEY")?.trim();
  if (!apiKey) {
    throw new E2BRuntimeConfigurationError(
      "Secure execution is enabled but E2B_API_KEY is missing.",
    );
  }
  const verifiedAt = getInstanceSetting("E2B_VERIFIED_AT")?.trim();
  if (!verifiedAt || Number.isNaN(Date.parse(verifiedAt))) {
    throw new E2BRuntimeConfigurationError(
      "Secure execution has not passed the E2B live verification.",
    );
  }
  const templateId = getInstanceSetting("E2B_TEMPLATE_ID")?.trim() || DEFAULT_TEMPLATE_ID;
  if (
    Buffer.byteLength(templateId, "utf8") > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(templateId)
  ) {
    throw new E2BRuntimeConfigurationError("E2B_TEMPLATE_ID has an invalid format.");
  }
  return {
    apiKey,
    templateId,
    sandboxTimeoutMs: SANDBOX_TIMEOUT_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  };
}

export class SqliteE2BProjectSandboxStore implements E2BProjectSandboxStore {
  assertFence(fence: E2BProjectFence): void {
    const row = rawSqlite
      .prepare("SELECT github_binding_generation FROM projects WHERE id = ?")
      .get(fence.projectId) as { github_binding_generation: number } | undefined;
    if (!row || row.github_binding_generation !== fence.githubBindingGeneration) {
      throw new E2BProjectFenceError();
    }
  }

  get(projectId: string): E2BProjectSandboxRecord | null {
    const row = rawSqlite
      .prepare(
        `SELECT project_id, sandbox_id, github_binding_generation, template_id,
                preview_pid, preview_port
           FROM project_sandboxes
          WHERE project_id = ?`,
      )
      .get(projectId) as
      | {
          project_id: string;
          sandbox_id: string;
          github_binding_generation: number;
          template_id: string;
          preview_pid: number | null;
          preview_port: number | null;
        }
      | undefined;
    return row
      ? {
          projectId: row.project_id,
          sandboxId: row.sandbox_id,
          githubBindingGeneration: row.github_binding_generation,
          templateId: row.template_id,
          previewPid: row.preview_pid,
          previewPort: row.preview_port,
        }
      : null;
  }

  list(): E2BProjectSandboxRecord[] {
    return (
      rawSqlite
        .prepare(
          `SELECT project_id, sandbox_id, github_binding_generation, template_id,
                  preview_pid, preview_port
             FROM project_sandboxes
            ORDER BY project_id`,
        )
        .all() as Array<{
        project_id: string;
        sandbox_id: string;
        github_binding_generation: number;
        template_id: string;
        preview_pid: number | null;
        preview_port: number | null;
      }>
    ).map((row) => ({
      projectId: row.project_id,
      sandboxId: row.sandbox_id,
      githubBindingGeneration: row.github_binding_generation,
      templateId: row.template_id,
      previewPid: row.preview_pid,
      previewPort: row.preview_port,
    }));
  }

  save(record: E2BProjectSandboxRecord): void {
    rawSqlite
      .prepare(
        `INSERT INTO project_sandboxes (
           project_id, sandbox_id, github_binding_generation, template_id,
           preview_pid, preview_port, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           sandbox_id = excluded.sandbox_id,
           github_binding_generation = excluded.github_binding_generation,
           template_id = excluded.template_id,
           preview_pid = excluded.preview_pid,
           preview_port = excluded.preview_port,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.projectId,
        record.sandboxId,
        record.githubBindingGeneration,
        record.templateId,
        record.previewPid,
        record.previewPort,
        Date.now(),
        Date.now(),
      );
  }

  setPreview(
    projectId: string,
    sandboxId: string,
    preview: { pid: number; port: number } | null,
  ): void {
    rawSqlite
      .prepare(
        `UPDATE project_sandboxes
            SET preview_pid = ?, preview_port = ?, updated_at = ?
          WHERE project_id = ? AND sandbox_id = ?`,
      )
      .run(preview?.pid ?? null, preview?.port ?? null, Date.now(), projectId, sandboxId);
  }

  delete(projectId: string, sandboxId?: string): void {
    if (sandboxId) {
      rawSqlite
        .prepare("DELETE FROM project_sandboxes WHERE project_id = ? AND sandbox_id = ?")
        .run(projectId, sandboxId);
      return;
    }
    rawSqlite.prepare("DELETE FROM project_sandboxes WHERE project_id = ?").run(projectId);
  }
}

class CredentialGate {
  private barrier: Promise<void> | null = null;
  private releaseBarrier: (() => void) | null = null;
  private activeOperations = 0;
  private activeOperationsDrained: (() => void) | null = null;
  private rotationTail: Promise<void> = Promise.resolve();

  async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    while (true) {
      const currentBarrier = this.barrier;
      if (currentBarrier) {
        await currentBarrier;
        continue;
      }
      this.activeOperations += 1;
      if (this.barrier) {
        this.leaveOperation();
        continue;
      }
      try {
        return await operation();
      } finally {
        this.leaveOperation();
      }
    }
  }

  withRotation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.barrier = new Promise<void>((resolve) => {
        this.releaseBarrier = resolve;
      });
      if (this.activeOperations > 0) {
        await new Promise<void>((resolve) => {
          this.activeOperationsDrained = resolve;
        });
      }
      try {
        return await operation();
      } finally {
        const release = this.releaseBarrier;
        this.releaseBarrier = null;
        this.barrier = null;
        release?.();
      }
    };
    const result = this.rotationTail.then(run, run);
    this.rotationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private leaveOperation(): void {
    this.activeOperations -= 1;
    if (this.activeOperations === 0) {
      const drained = this.activeOperationsDrained;
      this.activeOperationsDrained = null;
      drained?.();
    }
  }
}

function validateCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("E2B command must not be empty.");
  if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
    throw new Error("E2B command exceeds the maximum length.");
  }
  return command;
}

function validateCommandTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_COMMAND_TIMEOUT_MS ||
    value > MAX_COMMAND_TIMEOUT_MS
  ) {
    throw new Error(
      `E2B command timeout must be between ${MIN_COMMAND_TIMEOUT_MS} and ${MAX_COMMAND_TIMEOUT_MS} milliseconds.`,
    );
  }
  return value;
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Preview port must be an integer between 1 and 65535.");
  }
}

function truncateUtf8(value: string, maxBytes = MAX_OUTPUT_BYTES_PER_STREAM): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  return `${encoded.subarray(0, maxBytes).toString("utf8")}\n[output truncated by Quillra]`;
}

function cappedForwarder(
  callback: ((chunk: string) => void | Promise<void>) | undefined,
): (chunk: string) => void | Promise<void> {
  let forwardedBytes = 0;
  let notified = false;
  return async (chunk) => {
    if (!callback || forwardedBytes >= MAX_OUTPUT_BYTES_PER_STREAM) return;
    const remaining = MAX_OUTPUT_BYTES_PER_STREAM - forwardedBytes;
    const bytes = Buffer.from(chunk, "utf8");
    const forwarded = bytes.subarray(0, remaining).toString("utf8");
    forwardedBytes += Math.min(bytes.byteLength, remaining);
    if (forwarded) await callback(forwarded);
    if (bytes.byteLength > remaining && !notified) {
      notified = true;
      await callback("\n[output truncated by Quillra]");
    }
  };
}

async function waitForProcess(
  process: E2BProcess,
  signal?: AbortSignal,
): Promise<E2BCommandResult> {
  if (!signal) return process.wait();
  if (signal.aborted) {
    await process.kill().catch(() => undefined);
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }

  let rejectAbort: ((reason: unknown) => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    void process
      .kill()
      .catch(() => undefined)
      .finally(() => {
        rejectAbort?.(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted.", "AbortError"),
        );
      });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([process.wait(), abort]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

type RuntimeDependencies = {
  adapter?: E2BAdapter;
  store?: E2BProjectSandboxStore;
  config?: E2BRuntimeConfig | (() => E2BRuntimeConfig);
  gate?: CredentialGate;
  syncLimits?: E2BSyncLimits;
};

/**
 * E2B execution boundary. Callers still hold Quillra's existing project lock;
 * this class adds its own project queue so an accidental direct caller cannot
 * create two sandboxes or overlap source synchronization.
 */
export class E2BRuntime {
  private readonly adapter: E2BAdapter;
  private readonly store: E2BProjectSandboxStore;
  private readonly configProvider: () => E2BRuntimeConfig;
  private readonly gate: CredentialGate;
  private readonly syncLimits?: E2BSyncLimits;
  private readonly projectTails = new Map<string, Promise<unknown>>();

  constructor(dependencies: RuntimeDependencies = {}) {
    this.adapter = dependencies.adapter ?? new E2BSdkAdapter();
    this.store = dependencies.store ?? new SqliteE2BProjectSandboxStore();
    const suppliedConfig = dependencies.config;
    if (typeof suppliedConfig === "function") {
      this.configProvider = suppliedConfig;
    } else {
      this.configProvider = () => suppliedConfig ?? readRuntimeConfig();
    }
    this.gate = dependencies.gate ?? new CredentialGate();
    this.syncLimits = dependencies.syncLimits;
  }

  ensureProject(
    fence: E2BProjectFence,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ sandboxId: string }> {
    return this.runProjectOperation(fence, async () => {
      const { sandbox } = await this.ensureConnected(fence, options.signal);
      return { sandboxId: sandbox.sandboxId };
    });
  }

  syncToSandbox(
    fence: E2BProjectFence,
    localRoot: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ entries: number; bytes: number }> {
    return this.runProjectOperation(fence, async () => {
      const { sandbox } = await this.ensureConnected(fence, options.signal);
      return syncLocalWorkspaceToE2B({
        sandbox,
        localRoot,
        remoteRoot: E2B_WORKSPACE_ROOT,
        limits: this.syncLimits,
        signal: options.signal,
      });
    });
  }

  syncFromSandbox(
    fence: E2BProjectFence,
    localRoot: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ entries: number; bytes: number }> {
    return this.runProjectOperation(fence, async () => {
      const { sandbox } = await this.ensureConnected(fence, options.signal);
      return syncE2BWorkspaceToLocal({
        sandbox,
        localRoot,
        remoteRoot: E2B_WORKSPACE_ROOT,
        limits: this.syncLimits,
        signal: options.signal,
      });
    });
  }

  runCommand(
    fence: E2BProjectFence,
    options: {
      localRoot: string;
      command: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      onStdout?: (chunk: string) => void | Promise<void>;
      onStderr?: (chunk: string) => void | Promise<void>;
    },
  ): Promise<E2BCommandResult> {
    return this.runProjectOperation(fence, async () => {
      const command = validateCommand(options.command);
      const timeoutMs = validateCommandTimeout(options.timeoutMs);
      const { sandbox } = await this.ensureConnected(fence, options.signal);
      await syncLocalWorkspaceToE2B({
        sandbox,
        localRoot: options.localRoot,
        remoteRoot: E2B_WORKSPACE_ROOT,
        limits: this.syncLimits,
        signal: options.signal,
      });

      const process = await sandbox.startCommand(command, {
        cwd: E2B_WORKSPACE_ROOT,
        timeoutMs,
        signal: options.signal,
        maxOutputBytes: MAX_OUTPUT_BYTES_PER_STREAM,
        onStdout: cappedForwarder(options.onStdout),
        onStderr: cappedForwarder(options.onStderr),
      });
      let result: E2BCommandResult | undefined;
      let executionError: unknown;
      try {
        result = await waitForProcess(process, options.signal);
      } catch (error) {
        executionError = error;
      }

      // Commands are the only remote primitive allowed to write back. Even a
      // non-zero/aborted command may have made useful edits.
      // Reassert after process-group quiescence and immediately before reading
      // remote bytes so a concurrent repository rebind cannot write stale
      // sandbox content into the replacement checkout.
      await this.store.assertFence(fence);
      await syncE2BWorkspaceToLocal({
        sandbox,
        localRoot: options.localRoot,
        remoteRoot: E2B_WORKSPACE_ROOT,
        limits: this.syncLimits,
        signal: options.signal?.aborted ? undefined : options.signal,
      });
      if (executionError) throw executionError;
      if (!result) throw new Error("E2B command finished without a result.");
      return {
        ...result,
        stdout: truncateUtf8(result.stdout),
        stderr: truncateUtf8(result.stderr),
      };
    });
  }

  startPreview(
    fence: E2BProjectFence,
    options: {
      localRoot: string;
      command: string;
      port: number;
      timeoutMs?: number;
      signal?: AbortSignal;
      onStdout?: (chunk: string) => void | Promise<void>;
      onStderr?: (chunk: string) => void | Promise<void>;
      onExit?: (result: E2BCommandResult) => void | Promise<void>;
    },
  ): Promise<{ pid: number; port: number }> {
    return this.runProjectOperation(fence, async () => {
      const command = validateCommand(options.command);
      const timeoutMs = validateCommandTimeout(options.timeoutMs);
      validatePort(options.port);
      const { sandbox, record } = await this.ensureConnected(fence, options.signal);
      if (record.previewPid !== null) {
        await sandbox.killProcess(record.previewPid, options.signal).catch(() => false);
        this.store.setPreview(fence.projectId, sandbox.sandboxId, null);
      }

      // Preview has its own copy and dependency tree. It can never be synced
      // back into the control-plane checkout.
      await syncLocalWorkspaceToE2B({
        sandbox,
        localRoot: options.localRoot,
        remoteRoot: E2B_PREVIEW_ROOT,
        limits: this.syncLimits,
        signal: options.signal,
      });
      const process = await sandbox.startCommand(command, {
        cwd: E2B_PREVIEW_ROOT,
        timeoutMs,
        signal: options.signal,
        maxOutputBytes: MAX_OUTPUT_BYTES_PER_STREAM,
        envs: {
          HOST: "0.0.0.0",
          PORT: String(options.port),
        },
        onStdout: cappedForwarder(options.onStdout),
        onStderr: cappedForwarder(options.onStderr),
      });
      this.store.setPreview(fence.projectId, sandbox.sandboxId, {
        pid: process.pid,
        port: options.port,
      });
      void process
        .wait()
        .catch(
          (): E2BCommandResult => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
            error: "The E2B preview process ended unexpectedly.",
          }),
        )
        .then(async (result) => {
          await options.onExit?.(result);
          await this.runProjectOperation(fence, async () => {
            const current = this.store.get(fence.projectId);
            if (current?.sandboxId === sandbox.sandboxId && current.previewPid === process.pid) {
              this.store.setPreview(fence.projectId, sandbox.sandboxId, null);
            }
          });
        })
        .catch(() => undefined);
      return { pid: process.pid, port: options.port };
    });
  }

  stopPreview(fence: E2BProjectFence, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.runProjectOperation(fence, async () => {
      await this.store.assertFence(fence);
      const record = this.store.get(fence.projectId);
      if (!record?.previewPid) return;
      const config = this.configProvider();
      try {
        const sandbox = await this.adapter.connect(record.sandboxId, {
          apiKey: config.apiKey,
          timeoutMs: config.sandboxTimeoutMs,
          requestTimeoutMs: config.requestTimeoutMs,
          signal: options.signal,
        });
        await sandbox.killProcess(record.previewPid, options.signal).catch(() => false);
      } catch (error) {
        if (!this.adapter.isNotFound(error)) throw error;
        this.store.delete(record.projectId, record.sandboxId);
        return;
      }
      this.store.setPreview(record.projectId, record.sandboxId, null);
    });
  }

  getPreviewAccess(
    fence: E2BProjectFence,
    port: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ origin: string; headers: { "e2b-traffic-access-token": string } }> {
    return this.runProjectOperation(fence, async () => {
      validatePort(port);
      const { sandbox } = await this.ensureConnected(fence, options.signal);
      if (!sandbox.trafficAccessToken) {
        throw new Error("E2B did not return a protected public-traffic token.");
      }
      return {
        origin: `https://${sandbox.getHost(port)}`,
        headers: {
          "e2b-traffic-access-token": sandbox.trafficAccessToken,
        },
      };
    });
  }

  pauseProject(fence: E2BProjectFence, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.runProjectOperation(fence, async () => {
      const { sandbox } = await this.ensureConnected(fence, options.signal);
      await sandbox.pause(options.signal);
    });
  }

  destroyProject(fence: E2BProjectFence, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.runProjectOperation(fence, async () => {
      await this.store.assertFence(fence);
      const record = this.store.get(fence.projectId);
      if (!record) return;
      const config = this.configProvider();
      try {
        await this.adapter.destroy(record.sandboxId, {
          apiKey: config.apiKey,
          requestTimeoutMs: config.requestTimeoutMs,
          signal: options.signal,
        });
      } catch (error) {
        if (!this.adapter.isNotFound(error)) throw error;
      }
      this.store.delete(record.projectId, record.sandboxId);
    });
  }

  /** Used only while CredentialGate holds its exclusive rotation barrier. */
  async destroyAllWithApiKey(options: {
    apiKey?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const records = this.store.list();
    if (records.length === 0) return;
    const apiKey = options.apiKey?.trim() || getInstanceSetting("E2B_API_KEY")?.trim();
    if (!apiKey) {
      throw new E2BRuntimeConfigurationError(
        "Cannot destroy active E2B sandboxes without the previous API key.",
      );
    }
    const failures: Error[] = [];
    for (const record of records) {
      try {
        await this.adapter.destroy(record.sandboxId, {
          apiKey,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          signal: options.signal,
        });
        this.store.delete(record.projectId, record.sandboxId);
      } catch (error) {
        if (this.adapter.isNotFound(error)) {
          this.store.delete(record.projectId, record.sandboxId);
        } else {
          failures.push(
            error instanceof Error ? error : new Error("Unknown E2B sandbox cleanup failure."),
          );
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more E2B project sandboxes could not be removed.");
    }
  }

  private runProjectOperation<T>(fence: E2BProjectFence, operation: () => Promise<T>): Promise<T> {
    return this.gate.withOperation(() => this.withProjectQueue(fence.projectId, operation));
  }

  private withProjectQueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectTails.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const drained = result.then(
      () => undefined,
      () => undefined,
    );
    this.projectTails.set(projectId, drained);
    void drained.finally(() => {
      if (this.projectTails.get(projectId) === drained) this.projectTails.delete(projectId);
    });
    return result;
  }

  private async ensureConnected(
    fence: E2BProjectFence,
    signal?: AbortSignal,
  ): Promise<{ sandbox: E2BSandboxHandle; record: E2BProjectSandboxRecord }> {
    await this.store.assertFence(fence);
    const config = this.configProvider();
    let record = this.store.get(fence.projectId);

    if (
      record &&
      (record.githubBindingGeneration !== fence.githubBindingGeneration ||
        record.templateId !== config.templateId)
    ) {
      try {
        await this.adapter.destroy(record.sandboxId, {
          apiKey: config.apiKey,
          requestTimeoutMs: config.requestTimeoutMs,
          signal,
        });
      } catch (error) {
        if (!this.adapter.isNotFound(error)) throw error;
      }
      this.store.delete(record.projectId, record.sandboxId);
      record = null;
    }

    if (record) {
      try {
        const sandbox = await this.adapter.connect(record.sandboxId, {
          apiKey: config.apiKey,
          timeoutMs: config.sandboxTimeoutMs,
          requestTimeoutMs: config.requestTimeoutMs,
          signal,
        });
        await this.ensureRemoteRoots(sandbox, signal);
        return { sandbox, record };
      } catch (error) {
        if (!this.adapter.isNotFound(error)) throw error;
        this.store.delete(record.projectId, record.sandboxId);
      }
    }

    const sandbox = await this.adapter.create({
      apiKey: config.apiKey,
      templateId: config.templateId,
      projectId: fence.projectId,
      timeoutMs: config.sandboxTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      signal,
    });
    const createdRecord: E2BProjectSandboxRecord = {
      projectId: fence.projectId,
      sandboxId: sandbox.sandboxId,
      githubBindingGeneration: fence.githubBindingGeneration,
      templateId: config.templateId,
      previewPid: null,
      previewPort: null,
    };
    try {
      await this.store.assertFence(fence);
      await this.ensureRemoteRoots(sandbox, signal);
      this.store.save(createdRecord);
      return { sandbox, record: createdRecord };
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
  }

  private async ensureRemoteRoots(sandbox: E2BSandboxHandle, signal?: AbortSignal): Promise<void> {
    await sandbox.makeDir(E2B_WORKSPACE_ROOT, signal);
    await sandbox.makeDir(E2B_PREVIEW_ROOT, signal);
  }
}

const defaultCredentialGate = new CredentialGate();
const defaultRuntime = new E2BRuntime({ gate: defaultCredentialGate });

export function getDefaultE2BRuntime(): E2BRuntime {
  return defaultRuntime;
}

export function destroyAllE2BProjectSandboxes(
  options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<void> {
  return defaultCredentialGate.withRotation(() => defaultRuntime.destroyAllWithApiKey(options));
}

/**
 * Race-free credential replacement/reset. The barrier is installed before the
 * first await, drains active operations, destroys every old sandbox with the
 * old key, commits settings, and only then admits new execution.
 */
export function rotateE2BRuntimeCredentials(options: {
  oldApiKey?: string;
  signal?: AbortSignal;
  commit: () => void | Promise<void>;
}): Promise<void> {
  return defaultCredentialGate.withRotation(async () => {
    await defaultRuntime.destroyAllWithApiKey({
      apiKey: options.oldApiKey,
      signal: options.signal,
    });
    await options.commit();
  });
}
