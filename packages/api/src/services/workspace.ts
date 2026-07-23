import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { simpleGit } from "simple-git";
import { createSafeChildEnv } from "./child-process-env.js";
import { detectFromManifest, getFrameworkById } from "./framework-registry.js";
import {
  getGithubAppBotIdentity,
  getInstallationTokenForRepo,
  isGithubAppConfigured,
} from "./github-app.js";
import { issuePreviewCapability, revokePreviewCapability } from "./preview-capability.js";
import { buildHostPreviewUrl, getPreviewOriginConfig } from "./preview-origin.js";
import {
  getPortByProject,
  markPreviewPortActive,
  registerPreviewPort,
  setPreviewStatus,
  unregisterPreviewPort,
} from "./preview-status.js";
import {
  beginProjectWriterReset,
  blockProjectWritersForDeletion,
  cancelAndWaitForProjectWriters,
  endProjectWriterReset,
  unblockProjectWritersAfterFailedDeletion,
} from "./project-workspace-lifecycle.js";

/**
 * Resolve a short-lived GitHub App installation token for a specific
 * repo. Returns null if the App isn't configured OR isn't installed on
 * the repo, the caller should surface "install the Quillra GitHub App
 * on this repository" in both cases. No PAT fallback: the App is the
 * only supported auth path for git operations.
 */
async function resolveRepoGitToken(githubRepoFullName: string): Promise<string | null> {
  if (!isGithubAppConfigured()) return null;
  const [owner, repo] = githubRepoFullName.split("/");
  if (!owner || !repo) return null;
  try {
    return (await getInstallationTokenForRepo(owner, repo)) ?? null;
  } catch (e) {
    console.warn(`[workspace] installation token fetch failed for ${githubRepoFullName}:`, e);
    return null;
  }
}

const previewChildren = new Map<string, ChildProcess>();
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
 * so the debug modal can show what the framework is printing in real time.
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
  return dir;
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
    const excludePath = path.join(repoPath, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const line = `${QUILLRA_TEMP_DIR}/`;
    let content = "";
    if (fs.existsSync(excludePath)) {
      content = fs.readFileSync(excludePath, "utf-8");
    }
    const already = content
      .split("\n")
      .map((l) => l.trim())
      .some((l) => l === line || l === QUILLRA_TEMP_DIR);
    if (!already) {
      const suffix = content === "" || content.endsWith("\n") ? "" : "\n";
      fs.appendFileSync(
        excludePath,
        `${suffix}# Quillra scratch space for chat attachments, never committed\n${line}\n`,
      );
    }
    // Belt-and-suspenders: also make sure the directory exists so the
    // upload handler can write to it without mkdir races.
    fs.mkdirSync(path.join(repoPath, QUILLRA_TEMP_DIR), { recursive: true });
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

function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Reserve a unique slot that is also free at the OS level. The map claim is
 * made before the asynchronous probe, so concurrent preview starts cannot
 * race each other onto the same port.
 */
async function reserveAvailablePreviewPortNow(
  projectId: string,
  verifyExisting = false,
): Promise<number> {
  const existing = getPortByProject(projectId);
  if (existing !== undefined && (!verifyExisting || (await isLoopbackPortAvailable(existing)))) {
    assertProjectWorkspaceAvailable(projectId);
    return existing;
  }
  if (existing !== undefined) unregisterPreviewPort(projectId, existing);

  const base = previewPortBase();
  const offset = previewPortOffset(projectId);
  for (let attempt = 0; attempt < PREVIEW_PORT_SLOTS; attempt++) {
    const port = base + ((offset + attempt) % PREVIEW_PORT_SLOTS);
    if (!registerPreviewPort(port, projectId)) continue;
    if ((await isLoopbackPortAvailable(port)) && getPortByProject(projectId) === port) {
      if (projectWorkspaceBlocked(projectId)) {
        unregisterPreviewPort(projectId, port);
        assertProjectWorkspaceAvailable(projectId);
      }
      return port;
    }
    unregisterPreviewPort(projectId, port);
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

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  envOverride?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "pipe",
      shell: process.platform === "win32",
      env: createSafeChildEnv(envOverride),
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.slice(-400)}`));
    });
  });
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

export async function installDependenciesIfNeeded(
  repoPath: string,
  projectId?: string,
): Promise<void> {
  const pkg = path.join(repoPath, "package.json");
  if (!fs.existsSync(pkg)) return;
  if (fs.existsSync(path.join(repoPath, "node_modules"))) return;

  const pm = getPackageManager(repoPath);
  if (projectId) setPreviewStatus(projectId, "installing", `Running ${pm} install`);

  // CRITICAL: Quillra's own container runs with NODE_ENV=production, and
  // npm respects that by default (skips devDependencies). User projects
  // NEED their devDeps to run dev servers (autoprefixer, postcss, vite
  // plugins, etc.), so we force NODE_ENV=development for the install and
  // also pass the explicit "include dev" flags per package manager.
  const installEnv = { NODE_ENV: "development", NPM_CONFIG_PRODUCTION: "false" };

  if (pm === "yarn") {
    await runCommand("yarn", ["install", "--non-interactive"], repoPath, installEnv);
  } else if (pm === "pnpm") {
    await runCommand("pnpm", ["install", "--prod=false"], repoPath, installEnv);
  } else {
    await runCommand("npm", ["install", "--include=dev"], repoPath, installEnv);
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
    .replace(/\$PORT/g, String(port));
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
      args: def.devCommand.args.map((a) => a.replace(/\{port\}/g, String(port))),
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
    args: ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    label: "Static site",
  };
}

// Re-exported so other modules can resolve a framework by id without importing the registry directly
export { getFrameworkById };

/** Returns metadata about the running (or not) preview child for a project */
export function getPreviewProcessInfo(projectId: string): {
  running: boolean;
  pid: number | null;
  exitCode: number | null;
  signalCode: string | null;
} {
  const child = previewChildren.get(projectId);
  if (!child) return { running: false, pid: null, exitCode: null, signalCode: null };
  return {
    running: child.exitCode === null && !child.killed,
    pid: child.pid ?? null,
    exitCode: child.exitCode,
    signalCode: child.signalCode ?? null,
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
    await withRepoLock(projectId, async () => {
      await removeManagedProjectPath(projectRepoPath(projectId));
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
      await removeManagedProjectPath(path.join(dir, "node_modules"));
      await installDependenciesIfNeeded(dir, projectId);
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

/**
 * Run an async operation while holding the per-project git lock. Exposed
 * so the sync service (pull, merge, conflict-resolver) shares the same
 * serialisation as the chat turn, avoiding `.git/index.lock` races when
 * a remote-sync fetch collides with an in-flight chat.
 */
export function runInProjectLock<T>(projectId: string, op: () => Promise<T>): Promise<T> {
  assertProjectWorkspaceAvailable(projectId);
  return withRepoLock(projectId, async () => {
    assertProjectWorkspaceAvailable(projectId);
    return op();
  });
}

function withRepoLock<T>(projectId: string, op: () => Promise<T>): Promise<T> {
  const prev = repoOpQueue.get(projectId) ?? Promise.resolve();
  const next = prev.then(op, op); // run op whether prev resolved or rejected
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

function simpleGitForClone(token?: string | null) {
  return simpleGit().env(gitEnvironment(token));
}

/**
 * Every project Git command gets a small environment and a disabled hooks
 * path. This keeps repository-installed hooks from executing with Quillra's
 * control-plane environment.
 */
export function simpleGitForProject(repoPath: string, token?: string | null) {
  return simpleGit(repoPath).env(gitEnvironment(token));
}

export async function scrubGitRemoteCredentials(
  repoPath: string,
  githubRepoFullName: string,
): Promise<void> {
  await simpleGitForProject(repoPath).remote([
    "set-url",
    "origin",
    credentialFreeGithubUrl(githubRepoFullName),
  ]);
}

export async function authenticatedGitForProject(repoPath: string, githubRepoFullName: string) {
  const token = await resolveRepoGitToken(githubRepoFullName);
  // Also scrubs credentials persisted by releases that embedded the token in
  // origin. Authentication for network commands is injected only in env.
  await scrubGitRemoteCredentials(repoPath, githubRepoFullName);
  return simpleGitForProject(repoPath, token);
}

export async function ensureRepoCloned(
  projectId: string,
  githubRepoFullName: string,
  branch: string,
  opts: {
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
  } = {},
): Promise<string> {
  assertProjectWorkspaceAvailable(projectId);
  const dir = projectRepoPath(projectId);
  const gitDir = path.join(dir, ".git");
  const token = await resolveRepoGitToken(githubRepoFullName);
  const url = credentialFreeGithubUrl(githubRepoFullName);

  const runInstall = async () => {
    if (opts.skipInstall) return;
    try {
      await installDependenciesIfNeeded(dir, projectId);
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
      setPreviewStatus(projectId, "cloning", `Cloning ${githubRepoFullName}`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await simpleGitForClone(token).clone(url, dir, [
        "--branch",
        branch,
        "--single-branch",
        "--depth",
        "1",
      ]);
      await runInstall();
    } else {
      sweepStaleGitLocks(dir);
      await scrubGitRemoteCredentials(dir, githubRepoFullName);
      const g = simpleGitForProject(dir, token);
      await g.fetch("origin", branch);
      await g.checkout(branch);
      await g.pull("origin", branch).catch(() => undefined);
      await runInstall();
    }
    // Register .quillra-temp/ with git's local exclude so chat
    // attachments never show up in a diff, a status, or a commit.
    ensureQuillraTempIgnored(dir);
  });
  return dir;
}

function previewChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForPreviewChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (previewChildExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(previewChildExited(child)), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onExit);
  });
}

function signalPreviewProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      // Preview commands run in their own process group. Signalling the group
      // also stops shell/npm wrappers and compiler helpers such as esbuild.
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

async function stopPreviewAndWait(projectId: string): Promise<void> {
  revokePreviewCapability(projectId);
  unregisterPreviewPort(projectId);

  const existingTermination = previewTerminationQueues.get(projectId);
  if (existingTermination) {
    await existingTermination;
    return;
  }

  const child = previewChildren.get(projectId);
  if (!child) return;
  previewChildren.delete(projectId);

  const termination = (async () => {
    if (previewChildExited(child)) return;
    signalPreviewProcess(child, "SIGTERM");
    if (await waitForPreviewChildExit(child, 1_500)) return;

    console.warn(`[workspace] preview ${projectId} did not exit after SIGTERM; sending SIGKILL`);
    signalPreviewProcess(child, "SIGKILL");
    if (!(await waitForPreviewChildExit(child, 1_000))) {
      console.warn(`[workspace] preview ${projectId} still appears to be running after SIGKILL`);
    }
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
): Promise<{ port: number; label: string }> {
  assertProjectWorkspaceAvailable(projectId);
  const previous = previewChildren.get(projectId);
  if (previous) {
    await stopPreviewAndWait(projectId);
  }
  assertProjectWorkspaceAvailable(projectId);
  const port = await reserveAvailablePreviewPort(projectId, true);
  assertProjectWorkspaceAvailable(projectId);
  setPreviewStatus(projectId, "starting", "Launching dev server");
  const { command, args, label } = resolveDevCommand(repoPath, port, previewCommandOverride);
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: repoPath,
      stdio: "pipe",
      env: createSafeChildEnv({
        PORT: String(port),
        HOST: "127.0.0.1",
        NODE_ENV: "development",
        FORCE_COLOR: "0",
      }),
      shell: false,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    revokePreviewCapability(projectId);
    unregisterPreviewPort(projectId);
    throw error;
  }
  // Reset logs whenever the dev server (re)starts
  clearPreviewLogs(projectId);
  previewChildren.set(projectId, child);
  const markReady = () => {
    if (previewChildren.get(projectId) !== child) return;
    if (markPreviewPortActive(projectId, port)) setPreviewStatus(projectId, "ready");
  };
  // Watch dev server output for "ready" indicators so we can flip status,
  // and buffer the lines for the debug modal.
  child.stdout?.on("data", (buf: Buffer) => {
    const s = buf.toString();
    appendLog(projectId, "stdout", s);
  });
  child.stderr?.on("data", (buf: Buffer) => {
    const s = buf.toString();
    appendLog(projectId, "stderr", s);
  });
  child.on("error", (error) => {
    if (previewChildren.get(projectId) !== child) return;
    setPreviewStatus(projectId, "error", `Dev server failed to start: ${error.message}`);
    previewChildren.delete(projectId);
    revokePreviewCapability(projectId);
    unregisterPreviewPort(projectId);
  });
  child.on("exit", (code) => {
    if (previewChildren.get(projectId) !== child) return;
    if (code !== 0) setPreviewStatus(projectId, "error", `Dev server exited with code ${code}`);
    previewChildren.delete(projectId);
    revokePreviewCapability(projectId);
    unregisterPreviewPort(projectId);
  });
  // Some custom servers are silent. Probe only while this exact child owns the
  // reservation; a successful response promotes reserved -> active.
  void (async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (previewChildren.get(projectId) !== child) return;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
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
  return { port, label };
}

/** Serialize restarts so two editor tabs cannot spawn competing servers. */
export function startDevPreview(
  projectId: string,
  repoPath: string,
  previewCommandOverride: string | null | undefined,
): Promise<{ port: number; label: string }> {
  assertProjectWorkspaceAvailable(projectId);
  const previous = previewStartQueues.get(projectId) ?? Promise.resolve();
  const next = previous.then(() => {
    assertProjectWorkspaceAvailable(projectId);
    return startDevPreviewNow(projectId, repoPath, previewCommandOverride);
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
    return {
      url: buildHostPreviewUrl(projectId, capability.token, hostConfig),
      mode: "host",
    };
  }
  return { url: `${base}/__preview/${port}/${capability.token}/`, mode: "path" };
}

export function getPreviewUrl(projectId: string, port: number): string {
  return getPreviewAddress(projectId, port).url;
}

export async function pushToGitHub(
  repoPath: string,
  branch: string,
  githubRepoFullName: string,
  author?: { name: string | null; email: string | null } | null,
  commitMessage?: string | null,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  // Always resolve a short-lived installation token via the GitHub App. We used
  // to accept an explicit `userToken` parameter here and the publish
  // route was passing the signed-in user's OAuth access token, which
  // (a) meant pushes happened under the human's credentials instead
  // of the App's bot identity and (b) leaked the user's PAT-level
  // scope into repos they didn't necessarily intend to push. The App
  // installation token is always the right credential for a push.
  const token = await resolveRepoGitToken(githubRepoFullName);
  if (!token) {
    throw new Error(
      "Quillra GitHub App is not installed on this repository. Open Organization Settings → Integrations and install it, then try again.",
    );
  }

  await scrubGitRemoteCredentials(repoPath, githubRepoFullName);
  const g = simpleGitForProject(repoPath, token);

  // Committer identity. When GitHub exposes the App's bot account, commits are
  // *committed by* the App's bot (`<slug>[bot]`, shows on github.com
  // with the robot icon). The human who drove the change is attached
  // as the git `author` via `--author=` so attribution stays visible
  // in `git log` and the GitHub UI ("<name> authored, <slug>[bot]
  // committed"). If GitHub cannot resolve the bot account, fall back to the
  // human identity rather than inventing an invalid bot email address.
  const botIdentity = await getGithubAppBotIdentity();
  let botCommitter = false;
  if (botIdentity) {
    await g.addConfig("user.name", botIdentity.name);
    await g.addConfig("user.email", botIdentity.email);
    botCommitter = true;
  } else if (author?.name) {
    await g.addConfig("user.name", author.name);
    if (author.email) await g.addConfig("user.email", author.email);
  }

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
    // When the App bot is the committer, attribute authorship to the
    // human who triggered the publish so `git log` shows who actually
    // drove the edit.
    if (botCommitter && author?.name && author?.email) {
      commitArgs.push(`--author=${author.name} <${author.email}>`);
    }
    await g.commit(message, commitArgs);
  }

  const branches = await g.branch(["-r"]);
  const hasRemote = branches.all.includes(`origin/${branch}`);

  if (!hasRemote) {
    try {
      await g.push(["--set-upstream", "origin", branch]);
    } catch {
      await g.push("origin", branch);
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
    await g.push("origin", branch);
  } catch {
    await g.push(["--set-upstream", "origin", branch]);
  }
  return {
    ok: true,
    message: `Published ${log.total} commit(s) to GitHub.`,
  };
}
