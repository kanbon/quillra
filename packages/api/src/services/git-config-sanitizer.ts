import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createSafeChildEnv } from "./child-process-env.js";

const MAX_GIT_CONFIG_BYTES = 1024 * 1024;
const MAX_HEAD_BYTES = 4 * 1024;
const MAX_GIT_METADATA_ENTRIES = 250_000;
const MAX_LEGACY_WORKTREE_ENTRIES = 250_000;
const MAX_GIT_VALIDATION_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_LEGACY_DIRECTORY_DEPTH = 128;
const LEGACY_FILESYSTEM_VALIDATION_TIMEOUT_MS = 10_000;
const GITHUB_REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const execFileAsync = promisify(execFile);

export type GitCommitIdentity = {
  name: string;
  email: string;
};

type SanitizeProjectGitConfigOptions = {
  githubRepoFullName?: string;
};

export class LegacyProjectGitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyProjectGitValidationError";
  }
}

function readRegularFileNoFollow(filePath: string, maxBytes: number): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size < 0 || info.size > maxBytes) return null;
    return fs.readFileSync(descriptor, "utf8");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertRealDirectory(directory: string, label: string): void {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist.`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function assertRealDirectoryAsync(directory: string, label: string): Promise<void> {
  let info: fs.Stats;
  try {
    info = await fs.promises.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist.`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function forEachDirectoryEntry(
  directory: string,
  operation: (name: string) => Promise<void>,
): Promise<void> {
  const handle = await fs.promises.opendir(directory);
  try {
    for (let entry = await handle.read(); entry; entry = await handle.read()) {
      await operation(entry.name);
    }
  } finally {
    await handle.close();
  }
}

function assertFilesystemValidationBudget(deadline: number, depth: number): void {
  if (Date.now() > deadline || depth > MAX_LEGACY_DIRECTORY_DEPTH) {
    throw new Error("Legacy project filesystem validation exceeded its safety bound.");
  }
}

async function assertSafeLegacyGitMetadata(gitDirectory: string, deadline: number): Promise<void> {
  const pending = [{ directory: gitDirectory, depth: 0 }];
  let entries = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const { directory, depth } = current;
    assertFilesystemValidationBudget(deadline, depth);
    await assertRealDirectoryAsync(directory, "Legacy project Git metadata directory");
    await forEachDirectoryEntry(directory, async (name) => {
      entries++;
      assertFilesystemValidationBudget(deadline, depth);
      if (entries > MAX_GIT_METADATA_ENTRIES) {
        throw new Error("Legacy project Git metadata is too large to validate safely.");
      }
      const entryPath = path.join(directory, name);
      const info = await fs.promises.lstat(entryPath);
      if (info.isSymbolicLink()) {
        throw new Error("Legacy project Git metadata contains a symbolic link.");
      }
      if (info.isDirectory()) {
        pending.push({ directory: entryPath, depth: depth + 1 });
        return;
      }
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error("Legacy project Git metadata contains an unsafe filesystem entry.");
      }
    });
  }

  await assertRealDirectoryAsync(
    path.join(gitDirectory, "objects"),
    "Legacy project Git object directory",
  );
  await assertRealDirectoryAsync(
    path.join(gitDirectory, "refs"),
    "Legacy project Git refs directory",
  );
  for (const redirect of [
    path.join(gitDirectory, "commondir"),
    path.join(gitDirectory, "gitdir"),
    path.join(gitDirectory, "modules"),
    path.join(gitDirectory, "worktrees"),
    path.join(gitDirectory, "objects", "info", "alternates"),
    path.join(gitDirectory, "objects", "info", "http-alternates"),
  ]) {
    try {
      await fs.promises.lstat(redirect);
      throw new Error("Legacy project Git metadata redirects outside the repository.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function assertNoNestedGitMetadata(repository: string, deadline: number): Promise<void> {
  const pending = [{ directory: repository, depth: 0 }];
  let entries = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const { directory, depth } = current;
    assertFilesystemValidationBudget(deadline, depth);
    await forEachDirectoryEntry(directory, async (name) => {
      if (directory === repository && name.toLowerCase() === ".git") return;
      entries++;
      assertFilesystemValidationBudget(deadline, depth);
      if (entries > MAX_LEGACY_WORKTREE_ENTRIES) {
        throw new Error("Legacy project working tree is too large to validate safely.");
      }
      if (name.toLowerCase() === ".git") {
        throw new Error("Legacy project working tree contains nested Git metadata.");
      }
      const entryPath = path.join(directory, name);
      const info = await fs.promises.lstat(entryPath);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        pending.push({ directory: entryPath, depth: depth + 1 });
      }
    });
  }
}

async function runHardenedGitValidation(
  repository: string,
  args: string[],
): Promise<Buffer | null> {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  try {
    const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
      encoding: "buffer",
      env: createSafeChildEnv({
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_KEY_1: "credential.helper",
        GIT_CONFIG_KEY_2: "credential.interactive",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_VALUE_0: nullDevice,
        GIT_CONFIG_VALUE_1: "",
        GIT_CONFIG_VALUE_2: "never",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      }),
      killSignal: "SIGKILL",
      maxBuffer: MAX_GIT_VALIDATION_OUTPUT_BYTES,
      timeout: 5_000,
    });
    return Buffer.isBuffer(stdout) ? stdout : null;
  } catch {
    return null;
  }
}

function containsGitlink(output: Buffer): boolean {
  return output
    .toString("latin1")
    .split("\0")
    .some((entry) => entry.startsWith("160000 "));
}

async function hasSafeGitStructure(repository: string): Promise<boolean> {
  if (
    !(await runHardenedGitValidation(repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD^{commit}",
    ]))
  ) {
    return false;
  }
  const index = await runHardenedGitValidation(repository, ["ls-files", "--stage", "-z"]);
  const tree = await runHardenedGitValidation(repository, ["ls-tree", "-r", "-z", "HEAD"]);
  return Boolean(index && tree && !containsGitlink(index) && !containsGitlink(tree));
}

function canonicalGithubRemoteFromFullName(fullName: string): string | null {
  const normalized = fullName.trim();
  if (!GITHUB_REPOSITORY_PATTERN.test(normalized)) return null;
  return `https://github.com/${normalized}.git`;
}

function canonicalGithubRemoteFromUrl(
  rawValue: string,
  options: { allowLegacyInstallationCredentials?: boolean } = {},
): string | null {
  let value = rawValue.trim();
  if (value.startsWith('"') || value.endsWith('"')) {
    if (!value.startsWith('"') || !value.endsWith('"')) return null;
    value = value.slice(1, -1);
    // Quillra only quotes inert canonical URLs. Escape sequences and embedded
    // quotes are unnecessary here, so rejecting them keeps this parser narrow.
    if (/["\\]/.test(value)) return null;
  }
  // Quillra writes this URL itself and never needs quoted, continued, or
  // URL-rewritten values. Reject anything outside that narrow representation.
  if (!value || /[\s'\\#;]/.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const hasCredentials = Boolean(url.username || url.password);
  if (
    hasCredentials &&
    (!options.allowLegacyInstallationCredentials ||
      url.username !== "x-access-token" ||
      !url.password)
  ) {
    return null;
  }

  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length !== 2) return null;
  const owner = segments[0] ?? "";
  const repositoryWithSuffix = segments[1] ?? "";
  const repository = repositoryWithSuffix.endsWith(".git")
    ? repositoryWithSuffix.slice(0, -4)
    : repositoryWithSuffix;
  return canonicalGithubRemoteFromFullName(`${owner}/${repository}`);
}

function extractCanonicalOrigin(
  config: string | null,
  options: { allowLegacyInstallationCredentials?: boolean } = {},
): string | null {
  if (!config || config.includes("\0")) return null;
  let inOriginSection = false;
  let origin: string | null = null;
  let originUrlCount = 0;

  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inOriginSection = /^\[\s*remote\s+"origin"\s*\]$/i.test(line);
      continue;
    }
    if (!inOriginSection) continue;
    const match = /^url\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    originUrlCount++;
    if (originUrlCount > 1) return null;
    origin = canonicalGithubRemoteFromUrl(match[1] ?? "", options);
    if (!origin) return null;
  }

  return originUrlCount === 1 ? origin : null;
}

function currentBranch(gitDirectory: string): string | null {
  const head = readRegularFileNoFollow(path.join(gitDirectory, "HEAD"), MAX_HEAD_BYTES);
  const match = head ? /^ref:\s*refs\/heads\/([^\r\n]+)\r?\n?$/.exec(head) : null;
  const branch = match?.[1] ?? "";
  const hasUnsafeCharacter = [...branch].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
  });
  if (
    !branch ||
    Buffer.byteLength(branch, "utf8") > 255 ||
    hasUnsafeCharacter ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch
      .split("/")
      .some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"))
  ) {
    return null;
  }
  return branch;
}

function quotedConfigValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function safeConfig(origin: string | null, branch: string | null): string {
  const lines = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = false",
    "\tbare = false",
    "\tlogallrefupdates = true",
  ];
  if (origin) {
    lines.push(
      '[remote "origin"]',
      `\turl = ${quotedConfigValue(origin)}`,
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    );
    if (branch) {
      lines.push(
        `[branch ${quotedConfigValue(branch)}]`,
        "\tremote = origin",
        `\tmerge = ${quotedConfigValue(`refs/heads/${branch}`)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Replace repository-local Git configuration with inert data immediately
 * before and after every trusted Git invocation.
 *
 * Old Quillra releases ran package scripts and shell commands in the local
 * checkout. Such code could persist executable Git config (fsmonitor, filters,
 * external diff/merge drivers, includes, aliases, credential helpers, proxy or
 * SSH commands) that a later `git status`, checkout, add, merge, diff, fetch, or
 * push would execute in the control-plane container. Parsing an allowlist is
 * not enough because include and multi-value semantics are subtle; rebuilding
 * the file makes the complete effective local config auditable.
 */
export function sanitizeProjectGitConfig(
  repoPath: string,
  options: SanitizeProjectGitConfigOptions = {},
): void {
  const repository = path.resolve(repoPath);
  if (!fs.existsSync(repository)) return;
  assertRealDirectory(repository, "Project repository");

  const gitDirectory = path.join(repository, ".git");
  if (!fs.existsSync(gitDirectory)) return;
  assertRealDirectory(gitDirectory, "Project Git directory");

  const configPath = path.join(gitDirectory, "config");
  const existing = readRegularFileNoFollow(configPath, MAX_GIT_CONFIG_BYTES);
  const explicitOrigin =
    options.githubRepoFullName === undefined
      ? null
      : canonicalGithubRemoteFromFullName(options.githubRepoFullName);
  if (options.githubRepoFullName !== undefined && !explicitOrigin) {
    throw new Error("Invalid GitHub repository name.");
  }
  const origin = explicitOrigin ?? extractCanonicalOrigin(existing);
  const contents = safeConfig(origin, currentBranch(gitDirectory));
  const temporaryPath = path.join(gitDirectory, `.quillra-config-${randomUUID()}.tmp`);

  try {
    fs.writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, configPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function normalizedGithubRemote(remote: string): string {
  return remote.toLowerCase();
}

/**
 * Validate imported metadata without invoking Git, rebuild its local
 * configuration from inert values, then run bounded hardened Git read checks.
 * Repository names are case-insensitive on GitHub; branch names are not.
 */
export async function verifyAndSanitizeLegacyProjectGitConfig(
  repoPath: string,
  expectedGithubRepoFullName: string,
  expectedBranch: string,
): Promise<void> {
  const repository = path.resolve(repoPath);
  const gitDirectory = path.join(repository, ".git");
  const filesystemValidationDeadline = Date.now() + LEGACY_FILESYSTEM_VALIDATION_TIMEOUT_MS;
  try {
    await assertRealDirectoryAsync(repository, "Legacy project repository");
    await assertRealDirectoryAsync(gitDirectory, "Legacy project Git directory");
    await assertSafeLegacyGitMetadata(gitDirectory, filesystemValidationDeadline);
    await assertNoNestedGitMetadata(repository, filesystemValidationDeadline);
  } catch {
    throw new LegacyProjectGitValidationError(
      "The legacy working copy is incomplete or uses an unsafe filesystem entry.",
    );
  }

  const expectedOrigin = canonicalGithubRemoteFromFullName(expectedGithubRepoFullName);
  if (!expectedOrigin) {
    throw new LegacyProjectGitValidationError("The legacy project repository name is invalid.");
  }

  const config = readRegularFileNoFollow(path.join(gitDirectory, "config"), MAX_GIT_CONFIG_BYTES);
  const actualOrigin = extractCanonicalOrigin(config, {
    allowLegacyInstallationCredentials: true,
  });
  if (
    !actualOrigin ||
    normalizedGithubRemote(actualOrigin) !== normalizedGithubRemote(expectedOrigin)
  ) {
    throw new LegacyProjectGitValidationError(
      "The legacy working copy origin does not match the selected GitHub repository.",
    );
  }

  if (currentBranch(gitDirectory) !== expectedBranch) {
    throw new LegacyProjectGitValidationError(
      "The legacy working copy branch does not match the project default branch.",
    );
  }

  sanitizeProjectGitConfig(repository, {
    githubRepoFullName: expectedGithubRepoFullName,
  });
  if (!(await hasSafeGitStructure(repository))) {
    throw new LegacyProjectGitValidationError(
      "The legacy working copy does not contain a safe standalone Git checkout.",
    );
  }
}

export function gitIdentityConfig(identity: GitCommitIdentity | undefined): string[] {
  if (!identity) return [];
  const name = identity.name.trim();
  const email = identity.email.trim();
  if (
    !name ||
    !email ||
    Buffer.byteLength(name, "utf8") > 200 ||
    Buffer.byteLength(email, "utf8") > 320 ||
    /[\0\r\n]/.test(name) ||
    /[\0\r\n<>]/.test(email)
  ) {
    throw new Error("Invalid Git commit identity.");
  }
  return [`user.name=${name}`, `user.email=${email}`];
}
