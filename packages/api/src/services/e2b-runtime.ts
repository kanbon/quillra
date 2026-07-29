import { createHash } from "node:crypto";
import { rawSqlite } from "../db/index.js";
import {
  type E2BAdapter,
  type E2BCommandResult,
  type E2BProcess,
  E2BProcessMonitorError,
  type E2BProcessMonitorFailureReason,
  type E2BSandboxHandle,
  E2BSdkAdapter,
} from "./e2b-adapter.js";
import { type E2BNodeRuntimePlan, resolveProjectE2BNodeRuntime } from "./e2b-node-runtime.js";
import {
  E2BTrustedEnvironmentError,
  E2B_PREVIEW_RELAY_PORT,
  E2B_PROJECT_HOME,
  assertE2BPreviewTargetPort,
} from "./e2b-preview-relay.js";
import {
  type E2BSyncLimits,
  E2B_PREVIEW_ROOT,
  E2B_WORKSPACE_ROOT,
  syncE2BWorkspaceToLocal,
  syncLocalWorkspaceToE2B,
} from "./e2b-workspace-sync.js";
import { getInstanceSetting } from "./instance-settings.js";
import { unregisterPreviewUpstream } from "./preview-upstream.js";

const DEFAULT_TEMPLATE_ID = "base";
const SANDBOX_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MIN_COMMAND_TIMEOUT_MS = 1_000;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES_PER_STREAM = 2 * 1024 * 1024;
const NODE_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000;
const NODE_RUNTIME_BOOTSTRAP_OUTPUT_BYTES = 32 * 1024;
const NODE_RUNTIME_ERROR_DETAIL_BYTES = 4 * 1024;
const SETUP_CACHE_VERSION = 1;
const SETUP_CACHE_KEY_MAX_BYTES = 4 * 1024;
const SETUP_CACHE_MARKER_NAME = `.quillra-setup-v${SETUP_CACHE_VERSION}`;
const MIN_SANDBOX_HANDLE_CACHE_TTL_MS = 60_000;
const MAX_SANDBOX_HANDLE_CACHE_TTL_MS = 5 * 60_000;
const SANDBOX_HANDLE_TIMEOUT_SAFETY_MS = 30_000;

export type E2BProjectFence = {
  projectId: string;
  githubBindingGeneration: number;
};

export type E2BPreviewAccess = {
  origin: string;
  headers: { "e2b-traffic-access-token": string };
};

export type E2BPreviewStartResult = {
  pid: number;
  port: number;
  access: E2BPreviewAccess;
};

export type E2BPreviewMonitorFailure = {
  reason: E2BProcessMonitorFailureReason;
  message: string;
  stdout: string;
  stderr: string;
  causeName: string;
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

export class E2BActivePreviewError extends Error {
  constructor() {
    super("The active preview must be stopped before accessing the E2B project workspace.");
    this.name = "E2BActivePreviewError";
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

  withRotation<T>(operation: () => Promise<T>, beforeDrain?: () => void): Promise<T> {
    const run = async () => {
      this.barrier = new Promise<void>((resolve) => {
        this.releaseBarrier = resolve;
      });
      try {
        // The barrier must be installed before cancelling work. Otherwise a
        // new preview start can enter between cancellation and the exclusive
        // credential mutation, leaving rotation waiting on another long setup.
        beforeDrain?.();
        if (this.activeOperations > 0) {
          await new Promise<void>((resolve) => {
            this.activeOperationsDrained = resolve;
          });
        }
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

function truncateUtf8(value: string, maxBytes = MAX_OUTPUT_BYTES_PER_STREAM): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  return `${encoded.subarray(0, maxBytes).toString("utf8")}\n[output truncated by Quillra]`;
}

const PREVIEW_RAILWAY_LOG_TAIL_BYTES = 2 * 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color escapes from untrusted process output
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: removes non-printing control bytes before structured logging
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function sanitizedPreviewLogTail(value: string): string {
  const encoded = Buffer.from(value, "utf8");
  const tail =
    encoded.byteLength <= PREVIEW_RAILWAY_LOG_TAIL_BYTES
      ? value
      : encoded.subarray(encoded.byteLength - PREVIEW_RAILWAY_LOG_TAIL_BYTES).toString("utf8");
  return tail
    .replaceAll(ANSI_ESCAPE_PATTERN, "")
    .replaceAll(CONTROL_CHARACTER_PATTERN, "")
    .replaceAll(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|e2b_[A-Za-z0-9_-]{12,})\b/g, "[redacted]")
    .replaceAll(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replaceAll(
      /((?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replaceAll(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, "$1?[redacted]");
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(error.name)
    ? error.name
    : "UnknownError";
}

function logPreviewLifecycle(
  level: "info" | "error",
  event: string,
  fields: {
    projectId: string;
    sandboxId: string;
    pid: number | null;
    port: number;
    cause: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  },
): void {
  const payload = {
    event,
    projectId: fields.projectId,
    sandboxId: fields.sandboxId,
    pid: fields.pid,
    port: fields.port,
    cause: fields.cause,
    ...(fields.exitCode === undefined ? {} : { exitCode: fields.exitCode }),
    tails: {
      stdout: sanitizedPreviewLogTail(fields.stdout ?? ""),
      stderr: sanitizedPreviewLogTail(fields.stderr ?? ""),
    },
  };
  // biome-ignore lint/suspicious/noConsole: Railway captures this sanitized lifecycle event
  console[level](`[e2b-preview] ${JSON.stringify(payload)}`);
}

function normalizePreviewMonitorFailure(error: unknown): E2BPreviewMonitorFailure {
  if (error instanceof E2BProcessMonitorError) {
    return {
      reason: error.reason,
      message:
        error.reason === "process-missing"
          ? "The secure preview process stopped unexpectedly."
          : "The secure preview connection was lost.",
      stdout: error.stdout,
      stderr: error.stderr,
      causeName: error.causeName,
    };
  }
  return {
    reason: "monitor-unavailable",
    message: "The secure preview connection was lost.",
    stdout: "",
    stderr: "",
    causeName: safeErrorName(error),
  };
}

function setupFailure(result: E2BCommandResult): Error {
  return new Error(
    `E2B preview setup failed with exit code ${result.exitCode}. Check the advanced preview logs for details.`,
  );
}

function validateSetupCacheKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value || Buffer.byteLength(value, "utf8") > SETUP_CACHE_KEY_MAX_BYTES) {
    throw new Error("The E2B preview setup cache key is invalid.");
  }
  return value;
}

function setupMarkerValue(
  setupCommand: string,
  setupCacheKey: string,
  nodeRuntime: E2BNodeRuntimePlan | null,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: SETUP_CACHE_VERSION,
        setupCommand,
        setupCacheKey,
        nodeRuntimeId: nodeRuntime?.runtimeId ?? null,
      }),
    )
    .digest("hex");
}

function setupCacheMarkerPath(remoteRoot: string): string {
  return `${remoteRoot}/node_modules/${SETUP_CACHE_MARKER_NAME}`;
}

function simpleShellTokens(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let hasToken = false;

  const finishToken = () => {
    if (!hasToken) return;
    tokens.push(token);
    token = "";
    hasToken = false;
  };

  for (const character of command) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        // Double-quoted shell expansion would make this parser's view differ
        // from the executed command. Generated package-manager commands use
        // inert single-quoted tokens.
        if (quote === '"' && (character === "$" || character === "`" || character === "\\")) {
          return null;
        }
        token += character;
      }
      hasToken = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasToken = true;
      continue;
    }
    if (/\s/.test(character)) {
      finishToken();
      continue;
    }
    // Only accept the simple argv shape emitted by packageInstallCommand().
    // Shell operators or expansion make manager inference ambiguous, so the
    // optimization fails closed and setup runs normally.
    if (";&|<>$`\\".includes(character)) return null;
    token += character;
    hasToken = true;
  }
  if (quote) return null;
  finishToken();
  return tokens;
}

function setupPackageManager(setupCommand: string): "npm" | "pnpm" | null {
  const tokens = simpleShellTokens(setupCommand);
  if (!tokens) return null;
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
  if (tokens[index] === "corepack") index += 1;
  const manager = /^(npm|pnpm)(?:@[^@\s]+)?$/.exec(tokens[index] ?? "")?.[1];
  if ((manager !== "npm" && manager !== "pnpm") || tokens[index + 1] !== "install") {
    return null;
  }
  return manager;
}

function setupCacheArtifactPaths(remoteRoot: string, setupCommand: string): string[] | null {
  const manager = setupPackageManager(setupCommand);
  if (manager === "pnpm") {
    return [`${remoteRoot}/node_modules/.modules.yaml`];
  }
  if (manager === "npm") {
    return [`${remoteRoot}/node_modules/.package-lock.json`];
  }
  // Yarn/PnP and arbitrary setup commands can generate required state outside
  // node_modules. A caller-supplied key alone cannot prove those artifacts
  // survived workspace reconciliation.
  return null;
}

async function setupCacheArtifactsExist(
  sandbox: E2BSandboxHandle,
  artifactPaths: string[],
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    for (const artifactPath of artifactPaths) {
      if (!(await sandbox.exists(artifactPath, signal))) return false;
    }
    return true;
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    return false;
  }
}

/**
 * The marker is project-owned and only skips repeat dependency setup inside
 * this project's sandbox. It is never consulted for authorization, routing,
 * sandbox selection, or any trusted relay decision.
 */
async function setupCacheMatches(
  sandbox: E2BSandboxHandle,
  markerPath: string,
  markerValue: string,
  artifactPaths: string[],
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if (!(await sandbox.exists(markerPath, signal))) return false;
    if (!(await setupCacheArtifactsExist(sandbox, artifactPaths, signal))) return false;
    const expected = Buffer.from(markerValue, "utf8");
    const actual = await sandbox.readFileChunk(markerPath, 0, expected.byteLength + 1, signal);
    return actual.byteLength === expected.byteLength && Buffer.from(actual).equals(expected);
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    return false;
  }
}

async function writeSetupCacheMarker(
  sandbox: E2BSandboxHandle,
  markerPath: string,
  markerValue: string,
  artifactPaths: string[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (!(await setupCacheArtifactsExist(sandbox, artifactPaths, signal))) return;
    await sandbox.remove(markerPath, signal).catch(() => undefined);
    await sandbox.writeFiles(
      [{ path: markerPath, data: Buffer.from(markerValue, "utf8") }],
      signal,
    );
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    // This cache is only a warm-start optimization. If its project-owned
    // marker cannot be written, the next preview safely runs setup again.
  }
}

async function removeSetupCacheMarker(
  sandbox: E2BSandboxHandle,
  markerPath: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await sandbox.remove(markerPath, signal);
  } catch {
    if (signal?.aborted) throw abortReason(signal);
  }
}

async function runSetupCommand(
  sandbox: E2BSandboxHandle,
  options: {
    remoteRoot: string;
    setupCommand: string;
    setupCacheKey?: string;
    nodeRuntime: E2BNodeRuntimePlan | null;
    timeoutMs: number;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void | Promise<void>;
    onStderr?: (chunk: string) => void | Promise<void>;
    onSetupStart?: () => void | Promise<void>;
    onSetupComplete?: () => void | Promise<void>;
  },
): Promise<void> {
  const artifactPaths =
    options.setupCacheKey === undefined
      ? null
      : setupCacheArtifactPaths(options.remoteRoot, options.setupCommand);
  const markerPath = setupCacheMarkerPath(options.remoteRoot);
  const markerValue =
    options.setupCacheKey === undefined || artifactPaths === null
      ? undefined
      : setupMarkerValue(options.setupCommand, options.setupCacheKey, options.nodeRuntime);
  const cacheHit =
    markerValue !== undefined &&
    artifactPaths !== null &&
    (await setupCacheMatches(sandbox, markerPath, markerValue, artifactPaths, options.signal));
  if (!cacheHit) {
    // An uncacheable setup (for example Yarn/PnP) can replace dependencies
    // while leaving an older npm/pnpm marker and artifact behind. Always
    // invalidate the prior proof before any setup run, regardless of whether
    // this particular command is eligible to write a replacement marker.
    await removeSetupCacheMarker(sandbox, markerPath, options.signal);
    await options.onSetupStart?.();
    const setupProcess = await sandbox.startCommand(options.setupCommand, {
      cwd: options.remoteRoot,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxOutputBytes: MAX_OUTPUT_BYTES_PER_STREAM,
      envs: options.nodeRuntime?.environment,
      projectPathPrefix: options.nodeRuntime?.pathPrefix,
      onStdout: cappedForwarder(options.onStdout),
      onStderr: cappedForwarder(options.onStderr),
    });
    const setupResult = await waitForProcess(setupProcess, options.signal);
    if (setupResult.exitCode !== 0) throw setupFailure(setupResult);
    if (markerValue !== undefined && artifactPaths !== null) {
      await writeSetupCacheMarker(sandbox, markerPath, markerValue, artifactPaths, options.signal);
    }
  }
  await options.onSetupComplete?.();
}

function previewAccessForSandbox(sandbox: E2BSandboxHandle): E2BPreviewAccess {
  if (!sandbox.trafficAccessToken) {
    throw new Error("E2B did not return a protected public-traffic token.");
  }
  return {
    origin: `https://${sandbox.getHost(E2B_PREVIEW_RELAY_PORT)}`,
    headers: {
      "e2b-traffic-access-token": sandbox.trafficAccessToken,
    },
  };
}

async function forwardNodeRuntimeFailure(
  callback: ((chunk: string) => void | Promise<void>) | undefined,
  output: string,
): Promise<void> {
  if (!callback || !output) return;
  await Promise.resolve(callback(output)).catch(() => undefined);
}

async function bootstrapNodeRuntime(
  sandbox: E2BSandboxHandle,
  runtime: E2BNodeRuntimePlan,
  options: {
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void | Promise<void>;
    onStderr?: (chunk: string) => void | Promise<void>;
  },
): Promise<void> {
  const process = await sandbox.startCommand(runtime.bootstrapCommand, {
    cwd: E2B_PROJECT_HOME,
    timeoutMs: NODE_RUNTIME_BOOTSTRAP_TIMEOUT_MS,
    signal: options.signal,
    maxOutputBytes: NODE_RUNTIME_BOOTSTRAP_OUTPUT_BYTES,
  });
  const result = await waitForProcess(process, options.signal);
  if (result.exitCode === 0) return;

  const stdout = truncateUtf8(result.stdout, NODE_RUNTIME_ERROR_DETAIL_BYTES);
  const stderr = truncateUtf8(result.stderr, NODE_RUNTIME_ERROR_DETAIL_BYTES);
  await Promise.all([
    forwardNodeRuntimeFailure(options.onStdout, stdout),
    forwardNodeRuntimeFailure(options.onStderr, stderr),
  ]);
  const details = [
    stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
    stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
  ].filter(Boolean);
  throw new Error(
    details.length > 0
      ? `Quillra could not prepare the project's Node.js runtime.\n${details.join("\n")}`
      : "Quillra could not prepare the project's Node.js runtime.",
  );
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

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

async function waitForProcess(
  process: E2BProcess,
  signal?: AbortSignal,
): Promise<E2BCommandResult> {
  if (!signal) return process.wait();
  if (signal.aborted) {
    await process.kill().catch(() => undefined);
    throw abortReason(signal);
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
        rejectAbort?.(abortReason(signal));
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

type CachedSandboxHandle = {
  sandbox: E2BSandboxHandle;
  sandboxId: string;
  githubBindingGeneration: number;
  templateId: string;
  configFingerprint: string;
  connectedAt: number;
};

function sandboxConnectionConfigFingerprint(config: E2BRuntimeConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        apiKey: config.apiKey,
        sandboxTimeoutMs: config.sandboxTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
      }),
    )
    .digest("hex");
}

function sandboxHandleCacheTtlMs(config: E2BRuntimeConfig): number {
  const desiredTtl = Math.min(
    MAX_SANDBOX_HANDLE_CACHE_TTL_MS,
    Math.max(MIN_SANDBOX_HANDLE_CACHE_TTL_MS, Math.floor(config.sandboxTimeoutMs / 3)),
  );
  return Math.max(
    0,
    Math.min(desiredTtl, config.sandboxTimeoutMs - SANDBOX_HANDLE_TIMEOUT_SAFETY_MS),
  );
}

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
  private readonly sandboxHandles = new Map<string, CachedSandboxHandle>();
  private readonly previewLaunches = new Map<
    string,
    { token: symbol; sandboxId: string; pid: number }
  >();
  private readonly previewStartControllers = new Map<
    string,
    Set<{
      token: symbol;
      githubBindingGeneration: number;
      controller: AbortController;
    }>
  >();

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
      await this.assertNoActivePreview(fence);
      const { sandbox, record } = await this.ensureConnected(fence, options.signal);
      await this.prepareForWorkspaceAccess(record, sandbox);
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
      await this.assertNoActivePreview(fence);
      const { sandbox, record } = await this.ensureConnected(fence, options.signal);
      await this.prepareForWorkspaceAccess(record, sandbox);
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
      setupCommand?: string;
      setupCacheKey?: string;
      onSetupStart?: () => void | Promise<void>;
      onSetupComplete?: () => void | Promise<void>;
    },
  ): Promise<E2BCommandResult> {
    return this.runProjectOperation(fence, async () => {
      const command = validateCommand(options.command);
      const setupCommand =
        options.setupCommand === undefined ? undefined : validateCommand(options.setupCommand);
      const setupCacheKey = validateSetupCacheKey(options.setupCacheKey);
      const timeoutMs = validateCommandTimeout(options.timeoutMs);
      const nodeRuntime = await resolveProjectE2BNodeRuntime(options.localRoot);
      await this.assertNoActivePreview(fence);
      const { sandbox, record } = await this.ensureConnected(fence, options.signal);

      // A previous finite command or preview may have daemonized descendants.
      // Never replace workspace bytes while any project-owned process can race
      // the sync, and never leave the trusted ingress relay active for a
      // command that is not an explicitly managed preview.
      await this.prepareForWorkspaceAccess(record, sandbox);
      await syncLocalWorkspaceToE2B({
        sandbox,
        localRoot: options.localRoot,
        remoteRoot: E2B_WORKSPACE_ROOT,
        limits: this.syncLimits,
        signal: options.signal,
      });

      let result: E2BCommandResult | undefined;
      let executionError: unknown;
      try {
        if (nodeRuntime) {
          await bootstrapNodeRuntime(sandbox, nodeRuntime, {
            signal: options.signal,
            onStdout: options.onStdout,
            onStderr: options.onStderr,
          });
        }
        if (setupCommand) {
          await runSetupCommand(sandbox, {
            remoteRoot: E2B_WORKSPACE_ROOT,
            setupCommand,
            setupCacheKey,
            nodeRuntime,
            timeoutMs,
            signal: options.signal,
            onStdout: options.onStdout,
            onStderr: options.onStderr,
            onSetupStart: options.onSetupStart,
            onSetupComplete: options.onSetupComplete,
          });
        }
        const process = await sandbox.startCommand(command, {
          cwd: E2B_WORKSPACE_ROOT,
          timeoutMs,
          signal: options.signal,
          envs: nodeRuntime?.environment,
          projectPathPrefix: nodeRuntime?.pathPrefix,
          maxOutputBytes: MAX_OUTPUT_BYTES_PER_STREAM,
          onStdout: cappedForwarder(options.onStdout),
          onStderr: cappedForwarder(options.onStderr),
        });
        result = await waitForProcess(process, options.signal);
      } catch (error) {
        executionError = error;
      }

      // Commands are the only remote primitive allowed to write back. Even a
      // non-zero/aborted command may have made useful edits.
      // Kill every project-UID process, including descendants that escaped the
      // foreground process group, before inventory or writeback. A failure
      // quarantines the sandbox and skips all remote reads.
      await this.quiesceBeforeWriteback(record, sandbox);

      // Reassert immediately before reading remote bytes so a concurrent
      // repository rebind cannot write stale sandbox content into the
      // replacement checkout.
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
      setupTimeoutMs?: number;
      signal?: AbortSignal;
      onStdout?: (chunk: string) => void | Promise<void>;
      onStderr?: (chunk: string) => void | Promise<void>;
      onExit?: (result: E2BCommandResult) => void | Promise<void>;
      onMonitorFailure?: (failure: E2BPreviewMonitorFailure) => void | Promise<void>;
      setupCommand?: string;
      setupCacheKey?: string;
      onSetupStart?: () => void | Promise<void>;
      onSetupComplete?: () => void | Promise<void>;
      defaultNodeRuntime?: boolean;
    },
  ): Promise<E2BPreviewStartResult> {
    const pendingStart = {
      token: Symbol(fence.projectId),
      githubBindingGeneration: fence.githubBindingGeneration,
      controller: new AbortController(),
    };
    const projectStarts = this.previewStartControllers.get(fence.projectId) ?? new Set();
    projectStarts.add(pendingStart);
    this.previewStartControllers.set(fence.projectId, projectStarts);
    const signal = options.signal
      ? AbortSignal.any([options.signal, pendingStart.controller.signal])
      : pendingStart.controller.signal;

    return this.runProjectOperation(fence, async () => {
      if (signal.aborted) throw abortReason(signal);
      const command = validateCommand(options.command);
      const setupCommand =
        options.setupCommand === undefined ? undefined : validateCommand(options.setupCommand);
      const setupCacheKey = validateSetupCacheKey(options.setupCacheKey);
      const setupTimeoutMs = validateCommandTimeout(options.setupTimeoutMs);
      const nodeRuntime = await resolveProjectE2BNodeRuntime(options.localRoot, {
        defaultWhenMissing: options.defaultNodeRuntime,
      });
      assertE2BPreviewTargetPort(options.port);
      const { sandbox, record } = await this.ensureConnected(fence, signal);
      let process: E2BProcess;
      let access: E2BPreviewAccess;
      try {
        access = previewAccessForSandbox(sandbox);
        this.previewLaunches.delete(fence.projectId);
        // Kill every process owned by project code, including descendants that
        // escaped the previously recorded process group, before any trusted
        // public port is rebound.
        await sandbox.quiesceProjectProcesses(signal);
        if (record.previewPid !== null) {
          this.store.setPreview(fence.projectId, sandbox.sandboxId, null);
        }

        // Preview has its own copy and dependency tree. It can never be synced
        // back into the control-plane checkout.
        await syncLocalWorkspaceToE2B({
          sandbox,
          localRoot: options.localRoot,
          remoteRoot: E2B_PREVIEW_ROOT,
          limits: this.syncLimits,
          signal,
        });
        if (nodeRuntime) {
          await bootstrapNodeRuntime(sandbox, nodeRuntime, {
            signal,
            onStdout: options.onStdout,
            onStderr: options.onStderr,
          });
        }
        if (setupCommand) {
          await runSetupCommand(sandbox, {
            remoteRoot: E2B_PREVIEW_ROOT,
            setupCommand,
            setupCacheKey,
            nodeRuntime,
            timeoutMs: setupTimeoutMs,
            signal,
            onStdout: options.onStdout,
            onStderr: options.onStderr,
            onSetupStart: options.onSetupStart,
            onSetupComplete: options.onSetupComplete,
          });
        } else {
          await options.onSetupComplete?.();
        }
        await sandbox.startPreviewRelay(options.port, signal);
        process = await sandbox.startCommand(command, {
          cwd: E2B_PREVIEW_ROOT,
          // E2B's command timeout is also the lifetime of the SDK event
          // stream. A dev server is intentionally long-lived, so keep that
          // stream unlimited and recover it by PID if the transport drops.
          timeoutMs: 0,
          signal,
          maxOutputBytes: MAX_OUTPUT_BYTES_PER_STREAM,
          envs: {
            ...nodeRuntime?.environment,
            HOST: "127.0.0.1",
            PORT: String(options.port),
          },
          projectPathPrefix: nodeRuntime?.pathPrefix,
          onStdout: cappedForwarder(options.onStdout),
          onStderr: cappedForwarder(options.onStderr),
        });
      } catch (error) {
        if (
          error instanceof E2BTrustedEnvironmentError &&
          (error.stage === "relay-start" || error.stage === "relay-ready")
        ) {
          const cleanupStatus = await this.discardUnsafeSandbox(record, sandbox);
          throw new E2BTrustedEnvironmentError(error.stage, cleanupStatus);
        }
        await this.quarantinePreviewFailure(record, sandbox);
        throw error;
      }
      this.store.setPreview(fence.projectId, sandbox.sandboxId, {
        pid: process.pid,
        port: options.port,
      });
      const launchToken = Symbol(fence.projectId);
      this.previewLaunches.set(fence.projectId, {
        token: launchToken,
        sandboxId: sandbox.sandboxId,
        pid: process.pid,
      });
      logPreviewLifecycle("info", "started", {
        projectId: fence.projectId,
        sandboxId: sandbox.sandboxId,
        pid: process.pid,
        port: options.port,
        cause: "preview-started",
      });
      void process
        .wait()
        .then(
          (result) => ({ kind: "exit" as const, result }),
          (error) => ({
            kind: "monitor-failure" as const,
            failure: normalizePreviewMonitorFailure(error),
          }),
        )
        .then(async (termination) => {
          const launch = this.previewLaunches.get(fence.projectId);
          if (
            launch?.token !== launchToken ||
            launch.sandboxId !== sandbox.sandboxId ||
            launch.pid !== process.pid
          ) {
            return;
          }
          const exited = this.store.get(fence.projectId);
          if (exited?.sandboxId === sandbox.sandboxId && exited.previewPid === process.pid) {
            // Revoke the traffic token route before user callbacks or remote
            // cleanup can block.
            unregisterPreviewUpstream(fence.projectId);
          }
          if (termination.kind === "exit") {
            logPreviewLifecycle("error", "stopped", {
              projectId: fence.projectId,
              sandboxId: sandbox.sandboxId,
              pid: process.pid,
              port: options.port,
              cause: "process-exit",
              exitCode: termination.result.exitCode,
              stdout: termination.result.stdout,
              stderr: termination.result.stderr,
            });
          } else {
            logPreviewLifecycle("error", "monitor-failed", {
              projectId: fence.projectId,
              sandboxId: sandbox.sandboxId,
              pid: process.pid,
              port: options.port,
              cause: `${termination.failure.reason}:${termination.failure.causeName}`,
              stdout: termination.failure.stdout,
              stderr: termination.failure.stderr,
            });
          }
          try {
            if (termination.kind === "exit") {
              await options.onExit?.(termination.result);
            } else {
              await options.onMonitorFailure?.(termination.failure);
            }
          } finally {
            await this.runProjectOperation(fence, async () => {
              if (this.previewLaunches.get(fence.projectId)?.token !== launchToken) return;
              this.previewLaunches.delete(fence.projectId);
              const current = this.store.get(fence.projectId);
              if (current?.sandboxId !== sandbox.sandboxId || current.previewPid !== process.pid) {
                return;
              }
              try {
                await sandbox.quiesceProjectProcesses();
                await sandbox.stopPreviewRelay();
                this.store.setPreview(fence.projectId, sandbox.sandboxId, null);
              } catch (error) {
                logPreviewLifecycle("error", "cleanup-failed", {
                  projectId: fence.projectId,
                  sandboxId: sandbox.sandboxId,
                  pid: process.pid,
                  port: options.port,
                  cause: safeErrorName(error),
                });
                await this.quarantinePreviewFailure(current, sandbox);
              }
            });
          }
        })
        .catch(() => undefined);
      return { pid: process.pid, port: options.port, access };
    }).finally(() => {
      const currentStarts = this.previewStartControllers.get(fence.projectId);
      currentStarts?.delete(pendingStart);
      if (currentStarts?.size === 0) this.previewStartControllers.delete(fence.projectId);
    });
  }

  /**
   * Synchronously supersede only starts for this exact repository binding.
   * This intentionally performs no provider call and can therefore run before
   * a replacement start enters the per-project queue.
   */
  cancelPendingPreviewStart(fence: E2BProjectFence): void {
    const pendingStarts = this.previewStartControllers.get(fence.projectId);
    if (!pendingStarts) return;
    for (const pendingStart of pendingStarts) {
      if (pendingStart.githubBindingGeneration === fence.githubBindingGeneration) {
        pendingStart.controller.abort(
          new DOMException("The preview start was stopped.", "AbortError"),
        );
      }
    }
  }

  stopPreview(fence: E2BProjectFence, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.cancelPendingPreviewStart(fence);
    return this.runProjectOperation(fence, async () => {
      await this.store.assertFence(fence);
      // Invalidate only after the queued operation proves that this fence is
      // still current. An obsolete caller must never suppress cleanup for the
      // project's active preview.
      this.previewLaunches.delete(fence.projectId);
      const record = this.store.get(fence.projectId);
      if (!record) return;
      // Revocation is synchronous and must precede any provider call: a failed
      // reconnect can itself block while attempting cleanup.
      unregisterPreviewUpstream(record.projectId);
      const config = this.configProvider();
      let sandbox: E2BSandboxHandle;
      try {
        const cached = this.getCachedSandboxHandle(record, config);
        if (cached) {
          sandbox = cached;
        } else {
          sandbox = await this.adapter.connect(record.sandboxId, {
            apiKey: config.apiKey,
            timeoutMs: config.sandboxTimeoutMs,
            requestTimeoutMs: config.requestTimeoutMs,
            signal: options.signal,
          });
          await this.ensureRemoteRoots(sandbox, options.signal);
          await this.store.assertFence(fence);
          this.rememberSandboxHandle(record, config, sandbox);
        }
      } catch (error) {
        if (this.adapter.isNotFound(error)) {
          this.forgetSandboxHandle(record.projectId, record);
          this.store.delete(record.projectId, record.sandboxId);
          return;
        }
        if (error instanceof E2BTrustedEnvironmentError) {
          this.forgetSandboxHandle(record.projectId, record);
          if (error.cleanupStatus === "confirmed") {
            this.store.delete(record.projectId, record.sandboxId);
            return;
          }
          // The adapter could not confirm that its failed bootstrap sandbox is
          // gone. Retain the record so a later cleanup can retry it.
          this.store.setPreview(record.projectId, record.sandboxId, null);
          throw error;
        }
        throw error;
      }

      try {
        await sandbox.quiesceProjectProcesses(options.signal);
      } catch (error) {
        const cleanupStatus = await this.discardUnsafeSandbox(record, sandbox);
        if (cleanupStatus === "confirmed") return;
        throw new E2BTrustedEnvironmentError(
          error instanceof E2BTrustedEnvironmentError ? error.stage : "project-quiesce",
          "failed",
        );
      }
      try {
        await sandbox.stopPreviewRelay(options.signal);
      } catch (error) {
        const cleanupStatus = await this.discardUnsafeSandbox(record, sandbox);
        if (cleanupStatus === "confirmed") return;
        throw new E2BTrustedEnvironmentError(
          error instanceof E2BTrustedEnvironmentError ? error.stage : "relay-stop",
          "failed",
        );
      }
      this.store.setPreview(record.projectId, record.sandboxId, null);
    });
  }

  getPreviewAccess(
    fence: E2BProjectFence,
    port: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<E2BPreviewAccess> {
    return this.runProjectOperation(fence, async () => {
      assertE2BPreviewTargetPort(port);
      const { sandbox, record } = await this.ensureConnected(fence, options.signal);
      if (record.previewPid === null || record.previewPort !== port) {
        throw new Error("The requested E2B preview is not active.");
      }
      return previewAccessForSandbox(sandbox);
    });
  }

  pauseProject(fence: E2BProjectFence, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.runProjectOperation(fence, async () => {
      const { sandbox, record } = await this.ensureConnected(fence, options.signal);
      // A paused sandbox must reconnect so E2B can resume it and return fresh
      // envd/public-traffic credentials.
      this.forgetSandboxHandle(record.projectId, record);
      await sandbox.pause(options.signal);
    });
  }

  destroyProject(fence: E2BProjectFence, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.runProjectOperation(fence, async () => {
      await this.store.assertFence(fence);
      // Keep the same fence boundary as the persistent sandbox mutation.
      this.previewLaunches.delete(fence.projectId);
      const record = this.store.get(fence.projectId);
      if (!record) {
        this.forgetSandboxHandle(fence.projectId, {
          githubBindingGeneration: fence.githubBindingGeneration,
        });
        return;
      }
      this.forgetSandboxHandle(record.projectId, record);
      unregisterPreviewUpstream(record.projectId);
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
    this.sandboxHandles.clear();
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
      this.previewLaunches.delete(record.projectId);
      unregisterPreviewUpstream(record.projectId);
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

  /**
   * Run an exclusive credential mutation after cancelling preview starts that
   * are still syncing, bootstrapping, or installing. Finite project commands
   * retain their existing drain semantics because they may be writing changes
   * back to the control-plane checkout.
   */
  withCredentialRotation<T>(operation: () => Promise<T>): Promise<T> {
    return this.gate.withRotation(
      async () => {
        // The gate has drained every operation at this point. Drop handles
        // before old credentials or their sandboxes can be mutated.
        this.sandboxHandles.clear();
        return operation();
      },
      () => {
        const reason = new DOMException("The E2B runtime is being reconfigured.", "AbortError");
        for (const pendingStarts of this.previewStartControllers.values()) {
          for (const pendingStart of pendingStarts) {
            pendingStart.controller.abort(reason);
          }
        }
      },
    );
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

  /**
   * Called only from inside the per-project queue. The persistent sandbox row
   * remains authoritative; this cache merely avoids repeating E2B connect and
   * trusted bootstrap for a short, bounded interval in this runtime process.
   */
  private getCachedSandboxHandle(
    record: E2BProjectSandboxRecord,
    config: E2BRuntimeConfig,
  ): E2BSandboxHandle | null {
    const cached = this.sandboxHandles.get(record.projectId);
    if (!cached) return null;
    const ageMs = Date.now() - cached.connectedAt;
    const matches =
      cached.sandboxId === record.sandboxId &&
      cached.sandbox.sandboxId === record.sandboxId &&
      cached.githubBindingGeneration === record.githubBindingGeneration &&
      cached.templateId === record.templateId &&
      cached.templateId === config.templateId &&
      cached.configFingerprint === sandboxConnectionConfigFingerprint(config) &&
      ageMs >= 0 &&
      ageMs < sandboxHandleCacheTtlMs(config);
    if (matches) return cached.sandbox;
    this.sandboxHandles.delete(record.projectId);
    return null;
  }

  private rememberSandboxHandle(
    record: E2BProjectSandboxRecord,
    config: E2BRuntimeConfig,
    sandbox: E2BSandboxHandle,
  ): void {
    if (
      sandbox.sandboxId !== record.sandboxId ||
      record.templateId !== config.templateId ||
      sandboxHandleCacheTtlMs(config) <= 0
    ) {
      return;
    }
    this.sandboxHandles.set(record.projectId, {
      sandbox,
      sandboxId: record.sandboxId,
      githubBindingGeneration: record.githubBindingGeneration,
      templateId: record.templateId,
      configFingerprint: sandboxConnectionConfigFingerprint(config),
      connectedAt: Date.now(),
    });
  }

  /**
   * Conditional invalidation prevents an obsolete async cleanup from evicting
   * a newer binding's handle. Omitting identity is reserved for the credential
   * gate after all active operations have drained.
   */
  private forgetSandboxHandle(
    projectId: string,
    expected: {
      sandboxId?: string;
      githubBindingGeneration?: number;
    },
  ): void {
    const cached = this.sandboxHandles.get(projectId);
    if (!cached) return;
    if (expected.sandboxId !== undefined && cached.sandboxId !== expected.sandboxId) return;
    if (
      expected.githubBindingGeneration !== undefined &&
      cached.githubBindingGeneration !== expected.githubBindingGeneration
    ) {
      return;
    }
    this.sandboxHandles.delete(projectId);
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
      this.forgetSandboxHandle(record.projectId, record);
      unregisterPreviewUpstream(record.projectId);
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
        const cached = this.getCachedSandboxHandle(record, config);
        if (cached) return { sandbox: cached, record };
        // `connect()` re-runs the trusted bootstrap and may wait for a failed
        // sandbox cleanup. Remove the in-memory token route only when entering
        // that provider operation; a healthy cached preview must stay routed.
        unregisterPreviewUpstream(record.projectId);
        const sandbox = await this.adapter.connect(record.sandboxId, {
          apiKey: config.apiKey,
          timeoutMs: config.sandboxTimeoutMs,
          requestTimeoutMs: config.requestTimeoutMs,
          signal,
        });
        await this.ensureRemoteRoots(sandbox, signal);
        await this.store.assertFence(fence);
        this.rememberSandboxHandle(record, config, sandbox);
        return { sandbox, record };
      } catch (error) {
        if (error instanceof E2BTrustedEnvironmentError) {
          this.forgetSandboxHandle(record.projectId, record);
          if (error.cleanupStatus === "confirmed") {
            this.store.delete(record.projectId, record.sandboxId);
            if (signal?.aborted) throw abortReason(signal);
          } else {
            // A failed cleanup is materially different from a confirmed
            // provider "not found". Keep the identifier for a later retry.
            this.store.setPreview(record.projectId, record.sandboxId, null);
          }
          throw error;
        }
        if (!this.adapter.isNotFound(error)) throw error;
        this.forgetSandboxHandle(record.projectId, record);
        this.store.delete(record.projectId, record.sandboxId);
      }
    }

    let provisionalRecord: E2BProjectSandboxRecord | undefined;
    const rememberCreatedSandbox = (sandboxId: string) => {
      provisionalRecord = {
        projectId: fence.projectId,
        sandboxId,
        githubBindingGeneration: fence.githubBindingGeneration,
        templateId: config.templateId,
        previewPid: null,
        previewPort: null,
      };
      // Persist before trusted bootstrap. A process crash or failed provider
      // cleanup must never turn a persistent sandbox into an untracked orphan.
      this.store.save(provisionalRecord);
    };

    let sandbox: E2BSandboxHandle;
    try {
      sandbox = await this.adapter.create({
        apiKey: config.apiKey,
        templateId: config.templateId,
        projectId: fence.projectId,
        timeoutMs: config.sandboxTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        allowInternetAccess: true,
        onSandboxCreated: rememberCreatedSandbox,
        signal,
      });
    } catch (error) {
      if (error instanceof E2BTrustedEnvironmentError) {
        const sandboxId = provisionalRecord?.sandboxId ?? error.sandboxId;
        if (sandboxId && error.cleanupStatus === "confirmed") {
          this.store.delete(fence.projectId, sandboxId);
        } else if (sandboxId) {
          // Keep the provisional row so credential rotation or the next
          // project operation can retry removal with the same provider ID.
          this.store.setPreview(fence.projectId, sandboxId, null);
        }
        if (error.cleanupStatus === "confirmed" && signal?.aborted) {
          throw abortReason(signal);
        }
      }
      throw error;
    }
    const createdRecord =
      provisionalRecord ??
      ({
        projectId: fence.projectId,
        sandboxId: sandbox.sandboxId,
        githubBindingGeneration: fence.githubBindingGeneration,
        templateId: config.templateId,
        previewPid: null,
        previewPort: null,
      } satisfies E2BProjectSandboxRecord);
    if (createdRecord.sandboxId !== sandbox.sandboxId) {
      let cleanupStatus: "confirmed" | "failed";
      try {
        await sandbox.kill();
        cleanupStatus = "confirmed";
        this.store.delete(createdRecord.projectId, createdRecord.sandboxId);
      } catch {
        cleanupStatus = "failed";
        // The handle's id is the only identifier known to address the sandbox
        // that could not be killed. Replace the provisional callback value so
        // a later credential rotation can retry provider cleanup.
        this.store.delete(createdRecord.projectId, createdRecord.sandboxId);
        this.store.save({
          ...createdRecord,
          sandboxId: sandbox.sandboxId,
          previewPid: null,
          previewPort: null,
        });
      }
      throw new E2BTrustedEnvironmentError(
        "bootstrap",
        cleanupStatus,
        cleanupStatus === "failed" ? sandbox.sandboxId : undefined,
      );
    }
    try {
      await this.store.assertFence(fence);
      await this.ensureRemoteRoots(sandbox, signal);
      this.store.save(createdRecord);
      this.rememberSandboxHandle(createdRecord, config, sandbox);
      return { sandbox, record: createdRecord };
    } catch (error) {
      this.forgetSandboxHandle(createdRecord.projectId, createdRecord);
      try {
        await sandbox.kill();
        this.store.delete(createdRecord.projectId, createdRecord.sandboxId);
      } catch {
        this.store.setPreview(createdRecord.projectId, createdRecord.sandboxId, null);
      }
      throw error;
    }
  }

  private async ensureRemoteRoots(sandbox: E2BSandboxHandle, signal?: AbortSignal): Promise<void> {
    await sandbox.makeDir(E2B_WORKSPACE_ROOT, signal);
    await sandbox.makeDir(E2B_PREVIEW_ROOT, signal);
  }

  private async assertNoActivePreview(fence: E2BProjectFence): Promise<void> {
    await this.store.assertFence(fence);
    const record = this.store.get(fence.projectId);
    if (record && (record.previewPid !== null || record.previewPort !== null)) {
      throw new E2BActivePreviewError();
    }
  }

  private async quarantinePreviewFailure(
    record: E2BProjectSandboxRecord,
    sandbox: E2BSandboxHandle,
  ): Promise<void> {
    this.previewLaunches.delete(record.projectId);
    unregisterPreviewUpstream(record.projectId);
    try {
      await sandbox.quiesceProjectProcesses();
      await sandbox.stopPreviewRelay();
      this.store.setPreview(record.projectId, record.sandboxId, null);
      record.previewPid = null;
      record.previewPort = null;
    } catch {
      await this.discardUnsafeSandbox(record, sandbox);
    }
  }

  /**
   * Establishes a stable workspace snapshot boundary. Mandatory containment
   * deliberately ignores the caller's AbortSignal: cancellation must not be
   * able to leave project processes racing a trusted filesystem operation.
   */
  private async prepareForWorkspaceAccess(
    record: E2BProjectSandboxRecord,
    sandbox: E2BSandboxHandle,
  ): Promise<void> {
    if (record.previewPid !== null || record.previewPort !== null) {
      throw new E2BActivePreviewError();
    }
    this.previewLaunches.delete(record.projectId);
    unregisterPreviewUpstream(record.projectId);
    try {
      await sandbox.quiesceProjectProcesses();
    } catch (error) {
      await this.throwContainedFailure(record, sandbox, "project-quiesce", error);
    }
    try {
      await sandbox.stopPreviewRelay();
    } catch (error) {
      await this.throwContainedFailure(record, sandbox, "relay-stop", error);
    }
    this.store.setPreview(record.projectId, record.sandboxId, null);
    record.previewPid = null;
    record.previewPort = null;
  }

  private async quiesceBeforeWriteback(
    record: E2BProjectSandboxRecord,
    sandbox: E2BSandboxHandle,
  ): Promise<void> {
    try {
      await sandbox.quiesceProjectProcesses();
    } catch (error) {
      await this.throwContainedFailure(record, sandbox, "project-quiesce", error);
    }
  }

  private async throwContainedFailure(
    record: E2BProjectSandboxRecord,
    sandbox: E2BSandboxHandle,
    fallbackStage: "project-quiesce" | "relay-stop",
    error: unknown,
  ): Promise<never> {
    const cleanupStatus = await this.discardUnsafeSandbox(record, sandbox);
    throw new E2BTrustedEnvironmentError(
      error instanceof E2BTrustedEnvironmentError ? error.stage : fallbackStage,
      cleanupStatus,
    );
  }

  /**
   * E2B documents both `true` (killed) and `false` (already absent) as
   * confirmed terminal outcomes. Only a rejected kill is unconfirmed.
   */
  private async discardUnsafeSandbox(
    record: E2BProjectSandboxRecord,
    sandbox: E2BSandboxHandle,
  ): Promise<"confirmed" | "failed"> {
    this.previewLaunches.delete(record.projectId);
    this.forgetSandboxHandle(record.projectId, record);
    // This must happen before `kill()`: provider cleanup can time out or reject,
    // but no request may continue carrying the sandbox traffic token.
    unregisterPreviewUpstream(record.projectId);
    try {
      await sandbox.kill();
      this.store.delete(record.projectId, record.sandboxId);
      return "confirmed";
    } catch {
      // Disable routing immediately, but retain the sandbox id so cleanup can
      // be retried rather than losing track of a potentially live sandbox.
      this.store.setPreview(record.projectId, record.sandboxId, null);
      return "failed";
    }
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
  return defaultRuntime.withCredentialRotation(() => defaultRuntime.destroyAllWithApiKey(options));
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
  return defaultRuntime.withCredentialRotation(async () => {
    await defaultRuntime.destroyAllWithApiKey({
      apiKey: options.oldApiKey,
      signal: options.signal,
    });
    await options.commit();
  });
}
