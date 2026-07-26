import fs from "node:fs";
import path from "node:path";

export type ProjectFilePathErrorCode = "INVALID_PATH" | "NOT_FOUND";

/**
 * An expected, client-safe failure while resolving a path inside a project
 * checkout. Callers should not expose the underlying host path.
 */
export class ProjectFilePathError extends Error {
  constructor(
    readonly code: ProjectFilePathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectFilePathError";
  }
}

type RootPath = {
  real: string;
  dev: number;
  ino: number;
};

type DirectoryFingerprint = {
  path: string;
  dev: number;
  ino: number;
};

function invalidPath(message = "Invalid project file path"): ProjectFilePathError {
  return new ProjectFilePathError("INVALID_PATH", message);
}

function notFound(message = "Project file not found"): ProjectFilePathError {
  return new ProjectFilePathError("NOT_FOUND", message);
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isMissingError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function isInside(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return allowRoot;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function canonicalRoot(repoRoot: string): RootPath {
  const resolved = path.resolve(repoRoot);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(resolved);
  } catch (error) {
    if (isMissingError(error)) throw notFound("Project workspace not found");
    throw error;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw invalidPath("Project workspace is not a directory");
  }

  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch (error) {
    if (isMissingError(error)) throw notFound("Project workspace not found");
    throw error;
  }

  // Managed workspace paths are canonicalized before project paths are
  // constructed. A mismatch therefore means that either the repository or
  // one of its managed parent components has been replaced with a symlink.
  if (real !== resolved) {
    throw invalidPath("Project workspace path contains a symbolic link");
  }

  let after: fs.Stats;
  try {
    after = fs.lstatSync(resolved);
  } catch (error) {
    if (isMissingError(error)) throw notFound("Project workspace not found");
    throw error;
  }
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw invalidPath("Project workspace is not a directory");
  }
  return { real, dev: after.dev, ino: after.ino };
}

function lexicalProjectPath(root: RootPath, requestedPath: string): string {
  if (
    requestedPath.length === 0 ||
    requestedPath.includes("\0") ||
    path.isAbsolute(requestedPath) ||
    path.win32.isAbsolute(requestedPath)
  ) {
    throw invalidPath();
  }

  const candidate = path.resolve(root.real, requestedPath);
  if (!isInside(root.real, candidate)) throw invalidPath();
  return candidate;
}

function directoryFingerprint(directory: string): DirectoryFingerprint {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (isMissingError(error)) throw notFound("Project directory not found");
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw invalidPath("Project path contains a symbolic link or non-directory component");
  }
  return { path: directory, dev: stat.dev, ino: stat.ino };
}

function rootFingerprint(root: RootPath): DirectoryFingerprint {
  const fingerprint = directoryFingerprint(root.real);
  if (fingerprint.dev !== root.dev || fingerprint.ino !== root.ino) {
    throw invalidPath("Project workspace changed during access");
  }
  return fingerprint;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Resolve and fingerprint every directory component without following
 * symlinks. Node does not expose openat(2), so retaining and re-checking these
 * fingerprints immediately around the file operation is the narrowest
 * portable TOCTOU window available here.
 */
function directoryChain(
  root: RootPath,
  targetDirectory: string,
  createMissing: boolean,
): DirectoryFingerprint[] {
  if (!isInside(root.real, targetDirectory, true)) throw invalidPath();

  const chain = [rootFingerprint(root)];
  const relative = path.relative(root.real, targetDirectory);
  if (relative === "") return chain;

  let current = root.real;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (!isMissingError(error)) throw error;
      if (!createMissing) throw notFound("Project directory not found");
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        // Another in-scope operation may have created the directory. It still
        // has to pass the no-symlink check below.
        if (errnoCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw invalidPath("Project path contains a symbolic link or non-directory component");
    }

    let currentReal: string;
    try {
      currentReal = fs.realpathSync.native(current);
    } catch (error) {
      if (isMissingError(error)) throw invalidPath("Project directory changed during access");
      throw error;
    }
    if (!isInside(root.real, currentReal, true)) throw invalidPath();
    chain.push({ path: current, dev: stat.dev, ino: stat.ino });
  }

  verifyDirectoryChain(chain);
  return chain;
}

function verifyDirectoryChain(chain: readonly DirectoryFingerprint[]): void {
  for (const expected of chain) {
    let actual: fs.Stats;
    try {
      actual = fs.lstatSync(expected.path);
    } catch (error) {
      if (isMissingError(error)) throw invalidPath("Project directory changed during access");
      throw error;
    }
    if (
      actual.isSymbolicLink() ||
      !actual.isDirectory() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino
    ) {
      throw invalidPath("Project directory changed during access");
    }
  }
}

function openNoFollow(filePath: string, flags: number, mode?: number): number {
  if (typeof fs.constants.O_NOFOLLOW !== "number" || fs.constants.O_NOFOLLOW === 0) {
    throw invalidPath("This platform cannot safely open project files");
  }
  try {
    return fs.openSync(filePath, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, mode);
  } catch (error) {
    if (isMissingError(error)) throw notFound();
    if (errnoCode(error) === "ELOOP")
      throw invalidPath("Symbolic-link file targets are not writable");
    throw error;
  }
}

function assertOpenDescriptorInsideRoot(root: RootPath, fd: number): void {
  // Linux exposes the kernel-resolved path for an open descriptor. Checking it
  // catches a parent-directory swap that happened between lstat and open. On
  // other platforms the directory fingerprints remain the best portable
  // defense Node currently exposes.
  if (process.platform !== "linux") return;
  let openedPath: string;
  try {
    openedPath = fs.realpathSync.native(`/proc/self/fd/${fd}`);
  } catch {
    throw invalidPath("Project file changed during access");
  }
  if (!isInside(root.real, openedPath)) throw invalidPath();
}

function lstatFile(filePath: string): fs.Stats {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isMissingError(error)) throw notFound();
    throw error;
  }
}

function assertDescriptorMatchesPath(
  root: RootPath,
  filePath: string,
  fd: number,
  chain: readonly DirectoryFingerprint[],
  options: { singleLink?: boolean } = {},
): fs.Stats {
  const descriptorStat = fs.fstatSync(fd);
  if (!descriptorStat.isFile() || (options.singleLink && descriptorStat.nlink !== 1)) {
    throw invalidPath("Project file is not a safe regular file");
  }

  verifyDirectoryChain(chain);
  const pathStat = lstatFile(filePath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameFile(descriptorStat, pathStat)) {
    throw invalidPath("Project file changed during access");
  }
  assertOpenDescriptorInsideRoot(root, fd);
  return descriptorStat;
}

/**
 * Read a regular file from a project checkout.
 *
 * A committed symlink is allowed only when its canonical target remains
 * inside the same checkout. The final target is opened with O_NOFOLLOW and
 * read through the verified descriptor, never by re-opening the user path.
 */
export function readProjectFile(repoRoot: string, requestedPath: string): Buffer {
  const root = canonicalRoot(repoRoot);
  const lexicalPath = lexicalProjectPath(root, requestedPath);

  let canonicalFile: string;
  try {
    canonicalFile = fs.realpathSync.native(lexicalPath);
  } catch (error) {
    if (isMissingError(error)) throw notFound();
    if (errnoCode(error) === "ELOOP") throw invalidPath("Symbolic-link loop in project path");
    throw error;
  }
  if (!isInside(root.real, canonicalFile)) {
    throw invalidPath("Project file resolves outside the project workspace");
  }

  const chain = directoryChain(root, path.dirname(canonicalFile), false);
  const fd = openNoFollow(canonicalFile, fs.constants.O_RDONLY);
  try {
    assertDescriptorMatchesPath(root, canonicalFile, fd, chain);

    // Re-resolve the originally requested path after open so a swapped
    // in-repository symlink cannot redirect the read.
    let currentCanonical: string;
    try {
      currentCanonical = fs.realpathSync.native(lexicalPath);
    } catch {
      throw invalidPath("Project file changed during access");
    }
    if (currentCanonical !== canonicalFile || !isInside(root.real, currentCanonical)) {
      throw invalidPath("Project file changed during access");
    }

    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Assert that an existing project-relative directory has no symlink component. */
export function assertProjectDirectory(repoRoot: string, requestedPath: string): string {
  const root = canonicalRoot(repoRoot);
  const target = lexicalProjectPath(root, requestedPath);
  directoryChain(root, target, false);
  return target;
}

/** Create a project-relative directory one component at a time without following symlinks. */
export function ensureProjectDirectory(repoRoot: string, requestedPath: string): string {
  const root = canonicalRoot(repoRoot);
  const target = lexicalProjectPath(root, requestedPath);
  directoryChain(root, target, true);
  return target;
}

/**
 * Write a regular project file without following a final symlink.
 *
 * The descriptor is validated before truncation, so a failed race check
 * cannot overwrite an existing file outside the project.
 */
export function writeProjectFile(
  repoRoot: string,
  requestedPath: string,
  contents: string | NodeJS.ArrayBufferView,
): void {
  const root = canonicalRoot(repoRoot);
  const target = lexicalProjectPath(root, requestedPath);
  const chain = directoryChain(root, path.dirname(target), false);

  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(target);
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
    throw invalidPath("Project file is not a safe regular file");
  }

  const fd = openNoFollow(
    target,
    existing
      ? fs.constants.O_WRONLY
      : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    assertDescriptorMatchesPath(root, target, fd, chain, { singleLink: true });
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Remove a regular file. Parent and final symlinks are rejected.
 */
export function deleteProjectFile(repoRoot: string, requestedPath: string): boolean {
  const root = canonicalRoot(repoRoot);
  const target = lexicalProjectPath(root, requestedPath);
  const chain = directoryChain(root, path.dirname(target), false);

  let first: fs.Stats;
  try {
    first = fs.lstatSync(target);
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
  if (!first.isFile() || first.isSymbolicLink()) {
    throw invalidPath("Only project files can be deleted");
  }

  verifyDirectoryChain(chain);
  let second: fs.Stats;
  try {
    second = fs.lstatSync(target);
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
  if (
    second.dev !== first.dev ||
    second.ino !== first.ino ||
    second.isSymbolicLink() ||
    !second.isFile()
  ) {
    throw invalidPath("Project file changed during access");
  }

  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
  return true;
}

/**
 * Register the scratch directory in .git/info/exclude without letting a
 * malicious checkout redirect the append through a symlink.
 */
export function ensureProjectGitExclude(repoRoot: string, ignoredDirectory: string): void {
  if (
    ignoredDirectory.length === 0 ||
    ignoredDirectory.includes("\0") ||
    ignoredDirectory.includes("\n") ||
    ignoredDirectory.includes("\r") ||
    ignoredDirectory.includes("/") ||
    ignoredDirectory.includes("\\")
  ) {
    throw invalidPath("Invalid git-exclude directory");
  }

  assertProjectDirectory(repoRoot, ".git");
  ensureProjectDirectory(repoRoot, ".git/info");

  const root = canonicalRoot(repoRoot);
  const target = lexicalProjectPath(root, ".git/info/exclude");
  const chain = directoryChain(root, path.dirname(target), false);
  const fd = openNoFollow(
    target,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND,
    0o600,
  );
  try {
    const stat = assertDescriptorMatchesPath(root, target, fd, chain, { singleLink: true });
    if (stat.size > 4 * 1024 * 1024) {
      throw invalidPath("Git exclude file is unexpectedly large");
    }

    const content = fs.readFileSync(fd, "utf8");
    const line = `${ignoredDirectory}/`;
    const alreadyIgnored = content
      .split("\n")
      .map((entry) => entry.trim())
      .some((entry) => entry === line || entry === ignoredDirectory);
    if (alreadyIgnored) return;

    verifyDirectoryChain(chain);
    assertDescriptorMatchesPath(root, target, fd, chain, { singleLink: true });
    const separator = content === "" || content.endsWith("\n") ? "" : "\n";
    fs.writeSync(
      fd,
      `${separator}# Quillra scratch space for chat attachments, never committed\n${line}\n`,
    );
  } finally {
    fs.closeSync(fd);
  }
}
