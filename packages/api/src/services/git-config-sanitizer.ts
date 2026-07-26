import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_GIT_CONFIG_BYTES = 1024 * 1024;
const MAX_HEAD_BYTES = 4 * 1024;
const GITHUB_REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export type GitCommitIdentity = {
  name: string;
  email: string;
};

type SanitizeProjectGitConfigOptions = {
  githubRepoFullName?: string;
};

function readRegularFileNoFollow(filePath: string, maxBytes: number): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
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

function canonicalGithubRemoteFromFullName(fullName: string): string | null {
  const normalized = fullName.trim();
  if (!GITHUB_REPOSITORY_PATTERN.test(normalized)) return null;
  return `https://github.com/${normalized}.git`;
}

function canonicalGithubRemoteFromUrl(rawValue: string): string | null {
  const value = rawValue.trim();
  // Quillra writes this URL itself and never needs quoted, continued, or
  // URL-rewritten values. Reject anything outside that narrow representation.
  if (!value || /[\s"'\\#;]/.test(value)) return null;

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

  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length !== 2) return null;
  const owner = segments[0] ?? "";
  const repositoryWithSuffix = segments[1] ?? "";
  const repository = repositoryWithSuffix.endsWith(".git")
    ? repositoryWithSuffix.slice(0, -4)
    : repositoryWithSuffix;
  return canonicalGithubRemoteFromFullName(`${owner}/${repository}`);
}

function extractCanonicalOrigin(config: string | null): string | null {
  if (!config || config.includes("\0")) return null;
  let inOriginSection = false;
  let origin: string | null = null;

  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inOriginSection = /^\[\s*remote\s+"origin"\s*\]$/i.test(line);
      continue;
    }
    if (!inOriginSection) continue;
    const match = /^url\s*=\s*(.*)$/i.exec(line);
    if (match) origin = canonicalGithubRemoteFromUrl(match[1] ?? "");
  }

  return origin;
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
