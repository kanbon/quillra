import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { rawSqlite } from "../db/index.js";
import { ensureProjectDirectory, ensureProjectGitExclude } from "../lib/project-files.js";
import { createSafeChildEnv } from "./child-process-env.js";
import { type E2BProjectFence, getDefaultE2BRuntime } from "./e2b-runtime.js";
import { detectFromManifest, getFrameworkById } from "./framework-registry.js";
import {
  type GitCommitIdentity,
  gitIdentityConfig,
  sanitizeProjectGitConfig,
} from "./git-config-sanitizer.js";
import type { GithubContentsPermission } from "./github-app.js";
import { requireGithubAppBotIdentity } from "./github-app.js";
import {
  issuePreviewCapability,
  issuePreviewHandoff,
  revokePreviewCapability,
} from "./preview-capability.js";
import {
  buildHostPreviewUrl,
  getPreviewOriginConfig,
  previewHostAuthorityForProject,
} from "./preview-origin.js";
import {
  getPortByProject,
  markPreviewPortActive,
  registerPreviewPort,
  setPreviewStatus,
  unregisterPreviewPort,
} from "./preview-status.js";
import {
  previewUpstreamUrl,
  registerPreviewUpstream,
  unregisterPreviewUpstream,
} from "./preview-upstream.js";
import {
  type ProjectGithubBindingSnapshot,
  assertProjectGithubBinding,
  resolveProjectGitToken,
} from "./project-github-token.js";
import {
  beginProjectWriterReset,
  blockProjectWritersForDeletion,
  cancelAndWaitForProjectWriters,
  endProjectWriterReset,
  unblockProjectWritersAfterFailedDeletion,
} from "./project-workspace-lifecycle.js";

const previewProcesses = new Map<
  string,
  { pid: number; port: number; githubBindingGeneration: number }
>();
const previewStartQueues = new Map<string, Promise<void>>();
const previewReservationQueues = new Map<string, Promise<void>>();
const previewTerminationQueues = new Map<string, Promise<void>>();
const resettingProjects = new Map<string, number>();
const deletingProjects = new Set<string>();
const deletedWorkspaceCleanupJobs = new Map<
  string,
  {
    attempt: number;
    completion: Promise<void>;
    options: DeletedWorkspaceCleanupOptions;
    resolve: () => void;
  }
>();
const DELETED_WORKSPACE_RETRY_DELAYS_MS = [250, 1_000, 5_000, 30_000, 60_000] as const;

export type DeletedWorkspaceCleanupOptions = {
  retryDelaysMs?: readonly number[];
  writerTimeoutMs?: number;
};

/**
 * Bounded ring buffer of the last ~200 log lines per running dev server
 * so the debug modal can show the bounded output captured when the remote
 * preview process exits.
 * Wiped whenever the dev server restarts.
 */
const MAX_LOG_LINES = 200;
const previewLogs = new Map<
  string,
  Array<{ t: number; stream: "stdout" | "stderr"; line: string }>
>();

function appendLog(projectId: string, stream: "stdout" | "stderr", chunk: string) {
  const buf = previewLogs.get(projectId) ?? [];
  for (const raw of chunk.split(/\r?\n/)) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape codes from preview process output
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "");
    if (!line) continue;
    buf.push({ t: Date.now(), stream, line });
  }
  while (buf.length > MAX_LOG_LINES) buf.shift();
  previewLogs.set(projectId, buf);
}

export function getPreviewLogs(projectId: string) {
  return previewLogs.get(projectId) ?? [];
}

export function clearPreviewLogs(projectId: string) {
  previewLogs.delete(projectId);
}

export function workspaceRoot(): string {
  const dir = process.env.WORKSPACE_DIR ?? path.join(process.cwd(), "data", "workspaces");
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(path.resolve(dir));
}

function projectWorkspacePath(projectId: string): string {
  const root = path.resolve(workspaceRoot());
  const projectDir = path.resolve(root, projectId);
  if (projectDir === root || path.dirname(projectDir) !== root) {
    throw new Error("Invalid project workspace path");
  }
  return projectDir;
}

export function projectRepoPath(projectId: string): string {
  return path.join(projectWorkspacePath(projectId), "repo");
}

function projectFence(projectId: string, expectedBindingGeneration?: number): E2BProjectFence {
  if (expectedBindingGeneration !== undefined) {
    return { projectId, githubBindingGeneration: expectedBindingGeneration };
  }
  const row = rawSqlite
    .prepare("SELECT github_binding_generation FROM projects WHERE id = ?")
    .get(projectId) as { github_binding_generation: number } | undefined;
  if (!row) throw new Error("Project not found");
  return { projectId, githubBindingGeneration: row.github_binding_generation };
}

function projectWorkspaceBlocked(projectId: string): boolean {
  return (resettingProjects.get(projectId) ?? 0) > 0 || deletingProjects.has(projectId);
}

function assertProjectWorkspaceAvailable(projectId: string): void {
  if (projectWorkspaceBlocked(projectId)) {
    throw new Error(
      deletingProjects.has(projectId)
        ? "Project is being deleted"
        : "Project workspace is being reset",
    );
  }
}

/** Folder inside the cloned repo where chat attachments live until the
 *  agent either promotes them to a real asset path or leaves them be.
 *  Path is relative to the repo root, join with projectRepoPath() to
 *  get an absolute path. */
export const QUILLRA_TEMP_DIR = ".quillra-temp";

/**
 * Make sure the `.quillra-temp/` folder is hidden from git without
 * modifying the committed `.gitignore`. We use `.git/info/exclude`
 * instead, it's a local-only ignore file that git reads alongside
 * `.gitignore` but never commits. Safe to call on every clone/refresh.
 *
 * See: https://git-scm.com/docs/gitignore#_description, "Patterns
 * which a user wants git to ignore in all situations should go into
 * a file specified by core.excludesFile (...), or for repository-
 * specific ignores into `$GIT_DIR/info/exclude`".
 */
export function ensureQuillraTempIgnored(repoPath: string): void {
  try {
    ensureProjectGitExclude(repoPath, QUILLRA_TEMP_DIR);
    // Belt-and-suspenders: also make sure the directory exists so the
    // upload handler can write to it without mkdir races.
    ensureProjectDirectory(repoPath, QUILLRA_TEMP_DIR);
  } catch (e) {
    console.warn("[workspace] failed to register .quillra-temp/ with git exclude:", e);
  }
}

const PREVIEW_PORT_SLOTS = 2_000;

function previewPortBase(): number {
  const configured = Number(process.env.PREVIEW_PORT_BASE ?? 4_321);
  return Number.isInteger(configured) && configured > 0 && configured <= 65_535 - PREVIEW_PORT_SLOTS
    ? configured
    : 4_321;
}

function previewPortOffset(projectId: string): number {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return h % PREVIEW_PORT_SLOTS;
}

/**
 * Reserve a stable virtual port. The port lives inside the project's E2B
 * microVM, not in Quillra's container, so only the in-process ownership map
 * needs to be unique.
 */
async function reserveAvailablePreviewPortNow(
  projectId: string,
  _verifyExisting = false,
): Promise<number> {
  const existing = getPortByProject(projectId);
  if (existing !== undefined) {
    assertProjectWorkspaceAvailable(projectId);
    return existing;
  }

  const base = previewPortBase();
  const offset = previewPortOffset(projectId);
  for (let attempt = 0; attempt < PREVIEW_PORT_SLOTS; attempt++) {
    const port = base + ((offset + attempt) % PREVIEW_PORT_SLOTS);
    if (!registerPreviewPort(port, projectId)) continue;
    if (projectWorkspaceBlocked(projectId)) {
      unregisterPreviewPort(projectId, port);
      assertProjectWorkspaceAvailable(projectId);
    }
    return port;
  }
  throw new Error("No preview ports are available");
}

/** Serialize meta/debug/start reservations for the same project. */
export function reserveAvailablePreviewPort(
  projectId: string,
  verifyExisting = false,
): Promise<number> {
  assertProjectWorkspaceAvailable(projectId);
  const previous = previewReservationQueues.get(projectId) ?? Promise.resolve();
  const next = previous.then(
    () => {
      assertProjectWorkspaceAvailable(projectId);
      return reserveAvailablePreviewPortNow(projectId, verifyExisting);
    },
    () => {
      assertProjectWorkspaceAvailable(projectId);
      return reserveAvailablePreviewPortNow(projectId, verifyExisting);
    },
  );
  const drained = next.then(
    () => undefined,
    () => undefined,
  );
  const tracked = drained.finally(() => {
    if (previewReservationQueues.get(projectId) === tracked) {
      previewReservationQueues.delete(projectId);
    }
  });
  previewReservationQueues.set(projectId, tracked);
  return next;
}

export function getPackageManager(repoPath: string): "yarn" | "pnpm" | "npm" {
  const declared = readPkgJson(repoPath)
    ?.packageManager?.match(/^(yarn|pnpm|npm)@/i)?.[1]
    ?.toLowerCase();
  if (declared === "yarn" || declared === "pnpm" || declared === "npm") return declared;
  if (fs.existsSync(path.join(repoPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

function packageInstallCommand(repoPath: string): string | null {
  if (!fs.existsSync(path.join(repoPath, "package.json"))) return null;
  const environment = "NODE_ENV=development NPM_CONFIG_PRODUCTION=false";
  switch (getPackageManager(repoPath)) {
    case "yarn":
      return `${environment} sh -c 'command -v yarn >/dev/null 2>&1 || corepack enable; yarn install'`;
    case "pnpm":
      return `${environment} sh -c 'command -v pnpm >/dev/null 2>&1 || corepack enable; pnpm install --prod=false'`;
    default:
      return `${environment} npm install --include=dev`;
  }
}

export async function installDependenciesIfNeeded(
  repoPath: string,
  projectId: string,
  expectedBindingGeneration?: number,
): Promise<void> {
  const command = packageInstallCommand(repoPath);
  if (!command) return;
  const pm = getPackageManager(repoPath);
  setPreviewStatus(projectId, "installing", `Running ${pm} install in E2B`);
  const result = await getDefaultE2BRuntime().runCommand(
    projectFence(projectId, expectedBindingGeneration),
    {
      localRoot: repoPath,
      command,
      timeoutMs: 30 * 60_000,
    },
  );
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).slice(-800);
    throw new Error(`${pm} install failed in the secure sandbox: ${detail}`);
  }
}

type DevCmd = { command: string; args: string[]; label: string };

function readPkgJson(repoPath: string) {
  const p = path.join(repoPath, "package.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as {
      packageManager?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
  } catch {
    return null;
  }
}

export function resolveDevCommand(
  repoPath: string,
  port: number,
  override: string | null | undefined,
): DevCmd {
  // 1) Project-level override always wins
  const interpolated = (override?.trim() ?? "")
    .replace(/\{port\}/g, String(port))
    .replace(/\$PORT/g, String(port))
    .replace(/127\.0\.0\.1/g, "0.0.0.0");
  if (interpolated) {
    if (process.platform === "win32") {
      return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", interpolated],
        label: "Custom",
      };
    }
    return { command: "sh", args: ["-c", interpolated], label: "Custom" };
  }

  // 2) Detect via the central framework registry
  const pkg = readPkgJson(repoPath);
  const def = detectFromManifest({ packageJson: pkg });
  if (def) {
    return {
      command: def.devCommand.binary,
      args: def.devCommand.args.map((a) =>
        a.replace(/\{port\}/g, String(port)).replace(/127\.0\.0\.1/g, "0.0.0.0"),
      ),
      label: def.label,
    };
  }

  // 3) Fall back to whatever `dev` script is in package.json
  const pm = getPackageManager(repoPath);
  if (pkg?.scripts?.dev) {
    if (pm === "yarn") return { command: "yarn", args: ["run", "dev"], label: "yarn dev" };
    if (pm === "pnpm") return { command: "pnpm", args: ["run", "dev"], label: "pnpm dev" };
    return { command: "npm", args: ["run", "dev"], label: "npm run dev" };
  }

  // 4) Last-resort default
  return {
    command: "npx",
    args: ["vite", "--host", "0.0.0.0", "--port", String(port), "--strictPort"],
    label: "Static site",
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function shellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

// Re-exported so other modules can resolve a framework by id without importing the registry directly
export { getFrameworkById };

/** Returns non-sensitive metadata about the remote preview process. */
export function getPreviewProcessInfo(projectId: string): {
  running: boolean;
  pid: number | null;
  exitCode: number | null;
  signalCode: string | null;
} {
  const process = previewProcesses.get(projectId);
  if (!process) return { running: false, pid: null, exitCode: null, signalCode: null };
  return {
    running: true,
    pid: process.pid,
    exitCode: null,
    signalCode: null,
  };
}

async function removeManagedProjectPath(target: string): Promise<void> {
  await fs.promises.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

/**
 * Mark a project as permanently unavailable before its database row is
 * removed. Every queued clone, Git operation, and preview start re-checks this
 * marker when it gets to the front of its queue.
 */
export function beginProjectDeletion(projectId: string): void {
  deletingProjects.add(projectId);
  blockProjectWritersForDeletion(projectId);
  clearPreviewLogs(projectId);
  stopPreview(projectId);
}

/** Undo the in-memory deletion marker when the database delete itself fails. */
export function cancelProjectDeletion(projectId: string): void {
  deletingProjects.delete(projectId);
  unblockProjectWritersAfterFailedDeletion(projectId);
}

/** Destroy all project-controlled remote state before rebind or DB deletion. */
export async function destroyProjectExecution(
  projectId: string,
  expectedBindingGeneration: number,
): Promise<void> {
  await stopPreviewAndWait(projectId, expectedBindingGeneration);
  await getDefaultE2BRuntime().destroyProject(projectFence(projectId, expectedBindingGeneration));
  previewProcesses.delete(projectId);
  unregisterPreviewUpstream(projectId);
}

/**
 * Remove the whole managed project directory after its database row has been
 * deleted. The deletion marker intentionally remains for the lifetime of this
 * process so an already-authorized in-flight request cannot recreate the
 * workspace after cleanup.
 */
export async function removeDeletedProjectWorkspace(
  projectId: string,
  writerTimeoutMs?: number,
): Promise<void> {
  deletingProjects.add(projectId);
  blockProjectWritersForDeletion(projectId);
  const writersStopped = await cancelAndWaitForProjectWriters(projectId, writerTimeoutMs);
  if (!writersStopped) {
    console.warn(
      `[workspace] project writers did not stop before cleanup timeout for ${projectId}; cleanup will be retried`,
    );
  }
  await stopPreviewAndWait(projectId);
  await (previewStartQueues.get(projectId) ?? Promise.resolve());
  await stopPreviewAndWait(projectId);
  await withRepoLock(projectId, async () => {
    await removeManagedProjectPath(projectWorkspacePath(projectId));
  });
  if (!writersStopped) {
    // The timed-out writer may still recreate files after this attempt. Force
    // the scheduler to make another pass until the writer lease is released.
    throw new Error(`Project writers are still active for deleted project ${projectId}`);
  }
}

function deletedWorkspaceRetryDelay(
  attempt: number,
  configuredDelays: readonly number[] = DELETED_WORKSPACE_RETRY_DELAYS_MS,
): number {
  const delays = configuredDelays.length > 0 ? configuredDelays : DELETED_WORKSPACE_RETRY_DELAYS_MS;
  return (
    delays[Math.min(attempt, delays.length - 1)] ??
    DELETED_WORKSPACE_RETRY_DELAYS_MS[DELETED_WORKSPACE_RETRY_DELAYS_MS.length - 1]
  );
}

/**
 * Keep retrying a deleted project's physical cleanup without holding the HTTP
 * response open. Each attempt has a bounded writer-cancellation wait, and the
 * unref'd retry timer does not prevent a clean process shutdown.
 */
export function scheduleDeletedProjectWorkspaceCleanup(
  projectId: string,
  options: DeletedWorkspaceCleanupOptions = {},
): Promise<void> {
  const existing = deletedWorkspaceCleanupJobs.get(projectId);
  if (existing) return existing.completion;

  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const job = {
    attempt: 0,
    completion,
    options,
    resolve: () => resolveCompletion?.(),
  };
  deletedWorkspaceCleanupJobs.set(projectId, job);

  const runAttempt = async (): Promise<void> => {
    try {
      await removeDeletedProjectWorkspace(projectId, job.options.writerTimeoutMs);
      if (deletedWorkspaceCleanupJobs.get(projectId) === job) {
        deletedWorkspaceCleanupJobs.delete(projectId);
      }
      job.resolve();
    } catch (error) {
      const delayMs = deletedWorkspaceRetryDelay(job.attempt, job.options.retryDelaysMs);
      job.attempt += 1;
      console.warn(
        `[workspace] cleanup attempt ${job.attempt} failed for deleted project ${projectId}; retrying in ${delayMs}ms:`,
        error,
      );
      const timer = setTimeout(() => {
        void runAttempt();
      }, delayMs);
      timer.unref();
    }
  };

  void runAttempt();
  return completion;
}

/**
 * Find workspace directories that no longer have a project row. Running this
 * at boot recovers cleanup work lost to a process/container restart.
 */
export function sweepOrphanedProjectWorkspaces(
  activeProjectIds: Iterable<string>,
): Promise<void>[] {
  const active = new Set(activeProjectIds);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspaceRoot(), { withFileTypes: true });
  } catch (error) {
    console.warn("[workspace] failed to scan for orphaned project workspaces:", error);
    return [];
  }

  return entries
    .filter((entry) => !active.has(entry.name))
    .map((entry) => scheduleDeletedProjectWorkspaceCleanup(entry.name));
}

/** Remove cloned workspace so the next ensureRepoCloned does a fresh clone (repo or branch change). */
export async function clearProjectRepoClone(
  projectId: string,
  writerTimeoutMs?: number,
  afterClear?: () => Promise<void>,
): Promise<void> {
  resettingProjects.set(projectId, (resettingProjects.get(projectId) ?? 0) + 1);
  beginProjectWriterReset(projectId);
  try {
    if (!(await cancelAndWaitForProjectWriters(projectId, writerTimeoutMs))) {
      throw new Error(`Project writers are still active for ${projectId}`);
    }
    await stopPreviewAndWait(projectId);
    await (previewStartQueues.get(projectId) ?? Promise.resolve());
    await stopPreviewAndWait(projectId);
    await getDefaultE2BRuntime().destroyProject(projectFence(projectId));
    await withRepoLock(projectId, async () => {
      await removeManagedProjectPath(projectRepoPath(projectId));
      await afterClear?.();
    });
  } finally {
    const remaining = (resettingProjects.get(projectId) ?? 1) - 1;
    if (remaining > 0) resettingProjects.set(projectId, remaining);
    else resettingProjects.delete(projectId);
    endProjectWriterReset(projectId);
  }
}

/**
 * Wipe node_modules + lockfile-fresh reinstall without re-cloning the repo.
 * Used when a previous install was broken (e.g. ran with NODE_ENV=production
 * and skipped devDependencies) and you want to heal without losing local
 * edits or re-downloading the whole repo.
 */
export async function reinstallProjectDependencies(
  projectId: string,
  writerTimeoutMs?: number,
): Promise<void> {
  resettingProjects.set(projectId, (resettingProjects.get(projectId) ?? 0) + 1);
  beginProjectWriterReset(projectId);
  try {
    if (!(await cancelAndWaitForProjectWriters(projectId, writerTimeoutMs))) {
      throw new Error(`Project writers are still active for ${projectId}`);
    }
    await stopPreviewAndWait(projectId);
    await withRepoLock(projectId, async () => {
      const dir = projectRepoPath(projectId);
      if (!fs.existsSync(dir)) throw new Error("Workspace not cloned");
      const fence = projectFence(projectId);
      await getDefaultE2BRuntime().destroyProject(fence);
      await installDependenciesIfNeeded(dir, projectId, fence.githubBindingGeneration);
    });
  } finally {
    const remaining = (resettingProjects.get(projectId) ?? 1) - 1;
    if (remaining > 0) resettingProjects.set(projectId, remaining);
    else resettingProjects.delete(projectId);
    endProjectWriterReset(projectId);
  }
}

/**
 * Remove any stale `.git/index.lock` left behind by a previous crashed
 * git operation. A container OOM-kill or process restart mid-`git
 * commit` can leave this file, after which every subsequent checkout /
 * pull fails with "Another git process seems to be running". This is
 * safe to delete unconditionally, simple-git operations are sequential
 * within a single repo dir, so if the file exists AND we're about to
 * start a new operation, nobody else is holding it.
 */
function sweepStaleGitLocks(repoPath: string): void {
  const lockPath = path.join(repoPath, ".git", "index.lock");
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
      console.warn(`[workspace] removed stale .git/index.lock in ${repoPath}`);
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Per-project in-process mutex for anything touching `.git/`. Concurrent
 * chat turns on the same project used to race on git-fetch/pull and
 * die with `fatal: Unable to create ... index.lock: File exists.`. Git
 * itself locks at the filesystem level, so the cleanest fix is to
 * serialise the operations before they reach git at all.
 *
 * Keyed by projectId. The map holds the *tail* promise of each
 * project's queue; new operations chain `.then(op)` and replace the
 * tail. The chain never retains old resolved promises, GC frees them
 * as soon as the next op attaches.
 */
const repoOpQueue = new Map<string, Promise<unknown>>();
type RepoLockContext = {
  projectId: string;
  active: boolean;
  parent?: RepoLockContext;
};
const heldRepoLocks = new AsyncLocalStorage<RepoLockContext>();

function contextHoldsRepoLock(context: RepoLockContext | undefined, projectId: string): boolean {
  for (let current = context; current; current = current.parent) {
    if (current.active && current.projectId === projectId) return true;
  }
  return false;
}

/**
 * Run an async operation while holding the per-project git lock. Exposed
 * so the sync service (pull, merge, conflict-resolver) shares the same
 * serialisation as the chat turn, avoiding `.git/index.lock` races when
 * a remote-sync fetch collides with an in-flight chat.
 */
export function runInProjectLock<T>(
  projectId: string,
  op: () => Promise<T>,
  expectedBinding?: ProjectGithubBindingSnapshot,
): Promise<T> {
  assertProjectWorkspaceAvailable(projectId);
  return withRepoLock(projectId, async () => {
    assertProjectWorkspaceAvailable(projectId);
    if (expectedBinding) await assertProjectGithubBinding(projectId, expectedBinding);
    return op();
  });
}

function withRepoLock<T>(projectId: string, op: () => Promise<T>): Promise<T> {
  const held = heldRepoLocks.getStore();
  if (contextHoldsRepoLock(held, projectId)) {
    return op();
  }

  const prev = repoOpQueue.get(projectId) ?? Promise.resolve();
  const start = () => {
    const context: RepoLockContext = { projectId, active: true, parent: held };
    return heldRepoLocks.run(context, async () => {
      try {
        return await op();
      } finally {
        // Async resources created by op retain this context. Marking the
        // lease inactive prevents fire-and-forget work from bypassing the
        // queue after the actual critical section has finished.
        context.active = false;
      }
    });
  };
  const next = prev.then(start, start); // run op whether prev resolved or rejected
  // Store the "drained" version so errors don't poison the chain for
  // subsequent ops on this project.
  repoOpQueue.set(
    projectId,
    next.catch(() => undefined),
  );
  return next;
}

function credentialFreeGithubUrl(githubRepoFullName: string): string {
  return `https://github.com/${githubRepoFullName}.git`;
}

function gitEnvironment(token?: string | null): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const config: Array<[string, string]> = [
    ["core.hooksPath", nullDevice],
    ["credential.helper", ""],
    ["credential.interactive", "never"],
  ];
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    config.push(["http.https://github.com/.extraHeader", `Authorization: Basic ${basic}`]);
  }

  const overrides: Record<string, string> = {
    GIT_CONFIG_COUNT: String(config.length),
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  config.forEach(([key, value], index) => {
    overrides[`GIT_CONFIG_KEY_${index}`] = key;
    overrides[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return createSafeChildEnv(overrides);
}

// simple-git 3.36 blocks security-sensitive Git config by default. These four
// exceptions apply only to the fixed environment assembled above: no caller or
// repository can add config keys through this object. Protocol overrides,
// custom binaries, pack helpers, templates, and all other unsafe categories
// remain blocked.
const CONTROLLED_GIT_UNSAFE_OPTIONS = {
  allowUnsafeConfigEnvCount: true,
  allowUnsafeConfigPaths: true,
  allowUnsafeCredentialHelper: true,
  allowUnsafeHooksPath: true,
} as const;

function simpleGitForClone(token?: string | null) {
  return simpleGit({ unsafe: CONTROLLED_GIT_UNSAFE_OPTIONS }).env(gitEnvironment(token));
}

function sanitizedProjectGit(
  repoPath: string,
  token?: string | null,
  identity?: GitCommitIdentity,
) {
  const git = simpleGit({
    baseDir: repoPath,
    config: gitIdentityConfig(identity),
    maxConcurrentProcesses: 1,
    unsafe: CONTROLLED_GIT_UNSAFE_OPTIONS,
  }).env(gitEnvironment(token));

  const guarded = new Proxy(git, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        sanitizeProjectGitConfig(repoPath);
        const result: unknown = Reflect.apply(value, target, args);
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          "then" in result &&
          typeof result.then === "function"
        ) {
          return Promise.resolve(result).finally(() => sanitizeProjectGitConfig(repoPath));
        }
        return result === target ? receiver : result;
      };
    },
  });
  return guarded;
}

/**
 * Every project Git command gets a small environment and a disabled hooks
 * path. Before and after each invocation, repository-local config is rebuilt
 * from inert data so a legacy project cannot persist an executable fsmonitor,
 * filter, diff/merge driver, include, alias, helper, proxy, or SSH command.
 */
export function simpleGitForProject(repoPath: string, identity?: GitCommitIdentity) {
  return sanitizedProjectGit(repoPath, null, identity);
}

function simpleGitForNetwork(repoPath: string, token: string) {
  return sanitizedProjectGit(repoPath, token);
}

export async function scrubGitRemoteCredentials(
  repoPath: string,
  githubRepoFullName: string,
): Promise<void> {
  sanitizeProjectGitConfig(repoPath, { githubRepoFullName });
}

export async function authenticatedGitForProject(
  projectId: string,
  repoPath: string,
  _githubRepoFullName: string,
  contents: GithubContentsPermission = "read",
) {
  const access = await resolveProjectGitToken(projectId, contents);
  // Also scrubs credentials persisted by releases that embedded the token in
  // origin. Authentication for network commands is injected only in env.
  await scrubGitRemoteCredentials(repoPath, access.fullName);
  return simpleGitForNetwork(repoPath, access.token);
}

export async function ensureRepoCloned(
  projectId: string,
  githubRepoFullName: string,
  branch: string,
  opts: {
    /** Monotonic binding epoch captured with the caller's project row. */
    expectedBindingGeneration: number;
    /** Skip running npm/yarn/pnpm install on the cloned repo. Set
     *  when the caller is about to rewrite package.json (migration)
     *  so we don't waste minutes installing a dep tree the agent
     *  will just throw away, or worse, OOM the container on an
     *  ancient CRA / Gatsby dep graph before the agent even runs. */
    skipInstall?: boolean;
    /** Called when the install step fails (missing version, ETARGET,
     *  peer-dep conflict, OOM, etc). Called INSTEAD of throwing so the
     *  chat turn can still run and the agent can see + fix the cause.
     *  File ops don't require node_modules. When this callback is not
     *  supplied, install failures still throw, the old behaviour. */
    onInstallFailed?: (error: string) => void;
  },
): Promise<string> {
  assertProjectWorkspaceAvailable(projectId);
  const dir = projectRepoPath(projectId);
  const gitDir = path.join(dir, ".git");

  const runInstall = async () => {
    if (opts.skipInstall) return;
    try {
      await installDependenciesIfNeeded(dir, projectId, opts.expectedBindingGeneration);
    } catch (e) {
      if (opts.onInstallFailed) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          `[workspace] install failed for ${projectId}; continuing so the chat can debug:`,
          msg.slice(0, 200),
        );
        opts.onInstallFailed(msg);
        return;
      }
      throw e;
    }
  };

  // Serialise every git touch per-project. Concurrent chat turns on
  // the same project would otherwise race on `.git/index.lock` and
  // one of them would die with a cryptic `File exists` message.
  await withRepoLock(projectId, async () => {
    assertProjectWorkspaceAvailable(projectId);
    await assertProjectGithubBinding(projectId, {
      githubRepoFullName,
      defaultBranch: branch,
      githubBindingGeneration: opts.expectedBindingGeneration,
    });
    const access = await resolveProjectGitToken(projectId, "read");
    const url = credentialFreeGithubUrl(access.fullName);
    if (!fs.existsSync(gitDir)) {
      // A killed clone or an interrupted workspace reset can leave regular
      // files behind after `.git/` is already gone. Git refuses to clone into
      // that non-empty destination, so discard only this managed repo clone
      // before retrying. The per-project lock keeps a concurrent clone from
      // being mistaken for stale state.
      if (fs.existsSync(dir)) {
        console.warn(`[workspace] removing incomplete clone for ${projectId}`);
        await removeManagedProjectPath(dir);
      }
      setPreviewStatus(projectId, "cloning", `Cloning ${access.fullName}`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await simpleGitForClone(access.token).clone(url, dir, [
        "--branch",
        branch,
        "--single-branch",
        "--depth",
        "1",
      ]);
      await runInstall();
    } else {
      sweepStaleGitLocks(dir);
      await scrubGitRemoteCredentials(dir, access.fullName);
      const networkGit = simpleGitForNetwork(dir, access.token);
      await networkGit.fetch("origin", branch);
      const localGit = simpleGitForProject(dir);
      await localGit.checkout(branch);
      await localGit.raw(["merge", "--ff-only", `origin/${branch}`]).catch(() => undefined);
      await runInstall();
    }
    // Register .quillra-temp/ with git's local exclude so chat
    // attachments never show up in a diff, a status, or a commit.
    ensureQuillraTempIgnored(dir);
  });
  return dir;
}

async function stopPreviewAndWait(
  projectId: string,
  expectedBindingGeneration?: number,
): Promise<void> {
  revokePreviewCapability(projectId);
  unregisterPreviewPort(projectId);
  unregisterPreviewUpstream(projectId);

  const existingTermination = previewTerminationQueues.get(projectId);
  if (existingTermination) {
    await existingTermination;
    return;
  }

  const termination = (async () => {
    const process = previewProcesses.get(projectId);
    let fence: E2BProjectFence | null = null;
    try {
      fence = projectFence(
        projectId,
        expectedBindingGeneration ?? process?.githubBindingGeneration,
      );
    } catch {
      // A successful project deletion destroys the sandbox before deleting
      // its row. Post-delete filesystem cleanup therefore has nothing remote
      // left to stop.
    }
    if (fence) {
      await getDefaultE2BRuntime().stopPreview(fence);
    }
    previewProcesses.delete(projectId);
  })();
  previewTerminationQueues.set(projectId, termination);
  try {
    await termination;
  } finally {
    if (previewTerminationQueues.get(projectId) === termination) {
      previewTerminationQueues.delete(projectId);
    }
  }
}

export function stopPreview(projectId: string): void {
  void stopPreviewAndWait(projectId).catch((error) => {
    console.warn(`[workspace] failed to stop preview ${projectId}:`, error);
  });
}

async function startDevPreviewNow(
  projectId: string,
  repoPath: string,
  previewCommandOverride: string | null | undefined,
  expectedBindingGeneration?: number,
): Promise<{ port: number; label: string }> {
  assertProjectWorkspaceAvailable(projectId);
  const previous = previewProcesses.get(projectId);
  if (previous) {
    await stopPreviewAndWait(projectId, previous.githubBindingGeneration);
  }
  assertProjectWorkspaceAvailable(projectId);
  const port = await reserveAvailablePreviewPort(projectId, true);
  assertProjectWorkspaceAvailable(projectId);
  setPreviewStatus(projectId, "starting", "Launching dev server");
  const fence = projectFence(projectId, expectedBindingGeneration);
  const dev = resolveDevCommand(repoPath, port, previewCommandOverride);
  const install = packageInstallCommand(repoPath);
  const command = [
    "export HOST=0.0.0.0",
    `export PORT=${port}`,
    "export NODE_ENV=development",
    "export FORCE_COLOR=0",
    "export BROWSER=none",
    install,
    `exec ${shellCommand(dev.command, dev.args)}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("; ");

  clearPreviewLogs(projectId);
  let exited = false;
  let startedPid: number | null = null;
  try {
    const remote = await getDefaultE2BRuntime().startPreview(fence, {
      localRoot: repoPath,
      command,
      port,
      timeoutMs: 30 * 60_000,
      onStdout: (chunk) => appendLog(projectId, "stdout", chunk),
      onStderr: (chunk) => appendLog(projectId, "stderr", chunk),
      onExit: (result) => {
        exited = true;
        const current = previewProcesses.get(projectId);
        if (!current || current.pid !== startedPid) return;
        previewProcesses.delete(projectId);
        unregisterPreviewUpstream(projectId, port);
        revokePreviewCapability(projectId);
        unregisterPreviewPort(projectId, port);
        if (result.exitCode !== 0) {
          setPreviewStatus(projectId, "error", `Dev server exited with code ${result.exitCode}`);
        }
      },
    });
    startedPid = remote.pid;
    if (exited) throw new Error("The E2B dev server exited during startup.");
    const upstream = await getDefaultE2BRuntime().getPreviewAccess(fence, port);
    registerPreviewUpstream(projectId, port, upstream);
    previewProcesses.set(projectId, {
      pid: remote.pid,
      port,
      githubBindingGeneration: fence.githubBindingGeneration,
    });
  } catch (error) {
    revokePreviewCapability(projectId);
    unregisterPreviewPort(projectId);
    unregisterPreviewUpstream(projectId, port);
    await getDefaultE2BRuntime()
      .stopPreview(fence)
      .catch(() => undefined);
    throw error;
  }

  const markReady = () => {
    if (previewProcesses.get(projectId)?.pid !== startedPid) return;
    if (markPreviewPortActive(projectId, port)) setPreviewStatus(projectId, "ready");
  };

  // Probe through the same authenticated E2B route used by the gateway. No
  // loopback request or project process ever runs inside Quillra's container.
  void (async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (previewProcesses.get(projectId)?.pid !== startedPid) return;
      const upstream = previewUpstreamUrl(projectId, port, "/");
      if (!upstream) return;
      try {
        const response = await fetch(upstream.url, {
          headers: upstream.headers,
          signal: AbortSignal.timeout(500),
          redirect: "manual",
        });
        if (response.status > 0) {
          markReady();
          return;
        }
      } catch {
        // Still booting.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  })();
  return { port, label: dev.label };
}

/** Serialize restarts so two editor tabs cannot spawn competing servers. */
export function startDevPreview(
  projectId: string,
  repoPath: string,
  previewCommandOverride: string | null | undefined,
  expectedBindingGeneration?: number,
): Promise<{ port: number; label: string }> {
  assertProjectWorkspaceAvailable(projectId);
  const previous = previewStartQueues.get(projectId) ?? Promise.resolve();
  const next = previous.then(() => {
    assertProjectWorkspaceAvailable(projectId);
    return startDevPreviewNow(
      projectId,
      repoPath,
      previewCommandOverride,
      expectedBindingGeneration,
    );
  });
  const drained = next.then(
    () => undefined,
    () => undefined,
  );
  const tracked = drained.finally(() => {
    if (previewStartQueues.get(projectId) === tracked) previewStartQueues.delete(projectId);
  });
  previewStartQueues.set(projectId, tracked);
  return next;
}

export type PreviewAddress = { url: string; mode: "host" | "path" };

export function getPreviewAddress(projectId: string, port: number): PreviewAddress {
  const base = (
    process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
  ).replace(/\/+$/, "");
  const capability = issuePreviewCapability(projectId, port);
  const hostConfig = getPreviewOriginConfig();
  if (hostConfig) {
    const host = previewHostAuthorityForProject(projectId, hostConfig);
    const handoff = issuePreviewHandoff(projectId, port, host);
    return {
      url: buildHostPreviewUrl(projectId, handoff.token, hostConfig),
      mode: "host",
    };
  }
  return { url: `${base}/__preview/${port}/${capability.token}/`, mode: "path" };
}

export function getPreviewUrl(projectId: string, port: number): string {
  return getPreviewAddress(projectId, port).url;
}

export async function pushToGitHub(
  projectId: string,
  repoPath: string,
  branch: string,
  _githubRepoFullName: string,
  author?: { name: string | null; email: string | null } | null,
  commitMessage?: string | null,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  // Always resolve a short-lived installation token via the GitHub App. We used
  // to accept an explicit `userToken` parameter here and the publish
  // route was passing the signed-in user's OAuth access token, which
  // (a) meant pushes happened under the human's credentials instead
  // of the App's bot identity and (b) exposed the user's broader
  // authorization to repos they didn't necessarily intend to push.
  // The exact-repository installation token is the right credential.
  const access = await resolveProjectGitToken(projectId, "write");

  await scrubGitRemoteCredentials(repoPath, access.fullName);
  const networkGit = simpleGitForNetwork(repoPath, access.token);

  // Commits are always committed by the App's bot (`<slug>[bot]`, shown on
  // github.com with the robot icon). The human who drove the change remains the
  // git author. Fail closed when GitHub cannot verify the bot identity instead
  // of silently creating a human-committed publish.
  const committer: GitCommitIdentity = await requireGithubAppBotIdentity(access.token);
  const g = simpleGitForProject(repoPath, committer);

  const status = await g.status();
  if (!status.isClean()) {
    await g.add("-A");
    // Fall back to a filename-listing message only when no AI-generated
    // message was supplied. The caller (routes/projects.ts publish)
    // generates a real subject + body with Claude Haiku before calling
    // pushToGitHub, so this branch is rarely hit in practice.
    let message = commitMessage?.trim();
    if (!message) {
      const changed = [
        ...status.modified,
        ...status.created,
        ...status.not_added,
        ...status.deleted,
      ];
      const list =
        changed.length <= 3
          ? changed.join(", ")
          : `${changed.slice(0, 3).join(", ")} and ${changed.length - 3} more`;
      message = `Update ${list}`;
    }
    const commitArgs: string[] = [];
    // Attribute authorship to the human who triggered the publish while the
    // verified App bot remains the committer.
    if (author?.name && author?.email) {
      commitArgs.push(`--author=${author.name} <${author.email}>`);
    }
    await g.commit(message, commitArgs);
  }

  const branches = await g.branch(["-r"]);
  const hasRemote = branches.all.includes(`origin/${branch}`);

  if (!hasRemote) {
    try {
      await networkGit.push(["--set-upstream", "origin", branch]);
    } catch {
      await networkGit.push("origin", branch);
    }
    return {
      ok: true,
      message: `Published ${branch} to GitHub. Your host can deploy from this branch.`,
    };
  }

  const log = await g.log({ from: `origin/${branch}`, to: "HEAD", maxCount: 100 });
  if (log.total === 0) {
    return { ok: false, message: "Nothing new to push, already in sync with GitHub." };
  }

  try {
    await networkGit.push("origin", branch);
  } catch {
    await networkGit.push(["--set-upstream", "origin", branch]);
  }
  return {
    ok: true,
    message: `Published ${log.total} commit(s) to GitHub.`,
  };
}
