import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { E2BRemoteEntry, E2BSandboxHandle } from "./e2b-adapter.js";

export const E2B_WORKSPACE_ROOT = "/home/user/quillra-workspace";
export const E2B_PREVIEW_ROOT = "/home/user/quillra-preview";

export type E2BSyncLimits = {
  maxEntries: number;
  maxDepth: number;
  maxPathBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export const DEFAULT_E2B_SYNC_LIMITS: Readonly<E2BSyncLimits> = {
  maxEntries: 20_000,
  maxDepth: 40,
  maxPathBytes: 1_024,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", ".quillra-temp"]);
const WRITE_BATCH_FILE_LIMIT = 64;
const WRITE_BATCH_BYTE_LIMIT = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const DIRECTORY_LIST_OUTPUT_BYTES = 2 * 1024 * 1024;

type SnapshotDirectory = {
  relativePath: string;
  mode: number;
};

type LocalSnapshotFile = {
  relativePath: string;
  absolutePath: string;
  size: number;
  mode: number;
};

type LocalSnapshot = {
  directories: SnapshotDirectory[];
  files: LocalSnapshotFile[];
  /** Included ancestors that contain an excluded directory at any depth. */
  protectedAncestors: Set<string>;
};

type RemoteInventoryEntry = E2BRemoteEntry & {
  relativePath: string;
};

type RemoteInventory = {
  entries: RemoteInventoryEntry[];
  protectedAncestors: Set<string>;
};

type RemoteSnapshotFile = {
  relativePath: string;
  remotePath: string;
  size: number;
  mode: number;
};

type RemoteSnapshot = {
  directories: SnapshotDirectory[];
  files: RemoteSnapshotFile[];
};

export class E2BWorkspaceSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2BWorkspaceSyncError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}

function validateRelativePath(relativePath: string, limits: E2BSyncLimits): string[] {
  if (!relativePath || relativePath === ".") {
    throw new E2BWorkspaceSyncError("Workspace sync received an empty relative path.");
  }
  if (
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    throw new E2BWorkspaceSyncError(`Workspace path is not relative: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    throw new E2BWorkspaceSyncError(`Workspace path contains an unsafe segment: ${relativePath}`);
  }
  if (segments.length > limits.maxDepth) {
    throw new E2BWorkspaceSyncError(`Workspace path exceeds maximum depth: ${relativePath}`);
  }
  if (Buffer.byteLength(relativePath, "utf8") > limits.maxPathBytes) {
    throw new E2BWorkspaceSyncError(`Workspace path is too long: ${relativePath}`);
  }
  return segments;
}

function isExcluded(segments: string[]): boolean {
  return segments.some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function addAncestorPaths(target: Set<string>, segments: string[]): void {
  for (let length = 1; length < segments.length; length += 1) {
    target.add(segments.slice(0, length).join("/"));
  }
}

function assertEntryBudget(
  state: { entries: number; totalBytes: number },
  relativePath: string,
  size: number,
  limits: E2BSyncLimits,
): void {
  state.entries += 1;
  if (state.entries > limits.maxEntries) {
    throw new E2BWorkspaceSyncError(
      `Workspace exceeds the ${limits.maxEntries.toLocaleString("en-US")} entry limit.`,
    );
  }
  assertByteBudget(state, relativePath, size, limits);
}

function assertByteBudget(
  state: { totalBytes: number },
  relativePath: string,
  size: number,
  limits: E2BSyncLimits,
): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
    throw new E2BWorkspaceSyncError(`Workspace file exceeds the size limit: ${relativePath}`);
  }
  state.totalBytes += size;
  if (!Number.isSafeInteger(state.totalBytes) || state.totalBytes > limits.maxTotalBytes) {
    throw new E2BWorkspaceSyncError("Workspace exceeds the total sync size limit.");
  }
}

async function assertLocalRoot(localRoot: string): Promise<string> {
  const absoluteRoot = path.resolve(localRoot);
  const rootInfo = await fs.lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new E2BWorkspaceSyncError("The local project workspace must be a real directory.");
  }
  return absoluteRoot;
}

async function collectLocalSnapshot(
  localRoot: string,
  limits: E2BSyncLimits,
  signal?: AbortSignal,
): Promise<LocalSnapshot> {
  const directories: SnapshotDirectory[] = [];
  const files: LocalSnapshotFile[] = [];
  const protectedAncestors = new Set<string>();
  const budget = { entries: 0, totalBytes: 0 };

  const visit = async (absoluteDirectory: string, parentSegments: string[]): Promise<void> => {
    throwIfAborted(signal);
    const directory = await fs.opendir(absoluteDirectory);
    try {
      for await (const entry of directory) {
        throwIfAborted(signal);
        budget.entries += 1;
        if (budget.entries > limits.maxEntries) {
          throw new E2BWorkspaceSyncError(
            `Workspace exceeds the ${limits.maxEntries.toLocaleString("en-US")} entry limit.`,
          );
        }
        const segments = [...parentSegments, entry.name];
        const relativePath = segments.join("/");
        validateRelativePath(relativePath, limits);
        if (isExcluded(segments)) {
          addAncestorPaths(protectedAncestors, segments);
          continue;
        }

        const absolutePath = path.join(absoluteDirectory, entry.name);
        const info = await fs.lstat(absolutePath);
        if (info.isSymbolicLink()) {
          throw new E2BWorkspaceSyncError(`Workspace sync refuses symbolic links: ${relativePath}`);
        }
        if (info.isDirectory()) {
          directories.push({ relativePath, mode: info.mode });
          await visit(absolutePath, segments);
          continue;
        }
        if (!info.isFile()) {
          throw new E2BWorkspaceSyncError(
            `Workspace sync refuses special filesystem entries: ${relativePath}`,
          );
        }
        assertByteBudget(budget, relativePath, info.size, limits);
        files.push({
          relativePath,
          absolutePath,
          size: info.size,
          mode: info.mode,
        });
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  };

  await visit(localRoot, []);
  return { directories, files, protectedAncestors };
}

async function safelyReadLocalFile(
  file: LocalSnapshotFile,
  limits: E2BSyncLimits,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const handle = await fs.open(file.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== file.size || info.size > limits.maxFileBytes) {
      throw new E2BWorkspaceSyncError(`Workspace file changed during sync: ${file.relativePath}`);
    }
    const data = await handle.readFile();
    throwIfAborted(signal);
    if (data.byteLength !== file.size) {
      throw new E2BWorkspaceSyncError(`Workspace file changed during sync: ${file.relativePath}`);
    }
    return data;
  } finally {
    await handle.close();
  }
}

function remoteRelativePath(
  remoteRoot: string,
  entry: E2BRemoteEntry,
  limits: E2BSyncLimits,
): { relativePath: string; segments: string[] } {
  const normalizedRoot = path.posix.resolve(remoteRoot);
  const normalizedEntry = path.posix.resolve(entry.path);
  const relativePath = path.posix.relative(normalizedRoot, normalizedEntry);
  const segments = validateRelativePath(relativePath, limits);
  if (normalizedEntry !== path.posix.join(normalizedRoot, ...segments)) {
    throw new E2BWorkspaceSyncError(`E2B returned a path outside the workspace: ${entry.path}`);
  }
  return { relativePath, segments };
}

async function collectRemoteInventory(options: {
  sandbox: E2BSandboxHandle;
  remoteRoot: string;
  limits: E2BSyncLimits;
  signal?: AbortSignal;
  rejectSymlinks: boolean;
}): Promise<RemoteInventory> {
  const entries: RemoteInventoryEntry[] = [];
  const protectedAncestors = new Set<string>();
  const budget = { entries: 0, totalBytes: 0 };

  const visit = async (remoteDirectory: string): Promise<void> => {
    throwIfAborted(options.signal);
    const remainingEntries = options.limits.maxEntries - budget.entries;
    const children = await options.sandbox.list(remoteDirectory, {
      maxEntries: remainingEntries,
      maxOutputBytes: DIRECTORY_LIST_OUTPUT_BYTES,
      signal: options.signal,
    });
    for (const child of children) {
      const { relativePath, segments } = remoteRelativePath(
        options.remoteRoot,
        child,
        options.limits,
      );
      assertEntryBudget(
        budget,
        relativePath,
        child.type === "file" ? child.size : 0,
        options.limits,
      );
      if (isExcluded(segments)) {
        addAncestorPaths(protectedAncestors, segments);
        continue;
      }
      if (child.symlinkTarget !== undefined && options.rejectSymlinks) {
        throw new E2BWorkspaceSyncError(
          `Workspace sync refuses an E2B symbolic link: ${relativePath}`,
        );
      }
      entries.push({ ...child, relativePath });
      if (child.type === "dir" && child.symlinkTarget === undefined) {
        await visit(child.path);
      }
    }
  };

  if (await options.sandbox.exists(options.remoteRoot, options.signal)) {
    const rootInfo = await options.sandbox.getInfo(options.remoteRoot, options.signal);
    if (rootInfo.type !== "dir" || rootInfo.symlinkTarget !== undefined) {
      throw new E2BWorkspaceSyncError("The E2B workspace root must be a real directory.");
    }
    await visit(options.remoteRoot);
  }
  return { entries, protectedAncestors };
}

function remoteSnapshotFromInventory(inventory: RemoteInventory): RemoteSnapshot {
  const directories: SnapshotDirectory[] = [];
  const files: RemoteSnapshotFile[] = [];
  for (const entry of inventory.entries) {
    if (entry.symlinkTarget !== undefined) {
      throw new E2BWorkspaceSyncError(
        `Workspace sync refuses an E2B symbolic link: ${entry.relativePath}`,
      );
    }
    if (entry.type === "dir") {
      directories.push({ relativePath: entry.relativePath, mode: entry.mode });
    } else if (entry.type === "file") {
      files.push({
        relativePath: entry.relativePath,
        remotePath: entry.path,
        size: entry.size,
        mode: entry.mode,
      });
    } else {
      throw new E2BWorkspaceSyncError(
        `Workspace sync refuses a special E2B filesystem entry: ${entry.relativePath}`,
      );
    }
  }
  directories.sort(
    (left, right) =>
      left.relativePath.split("/").length - right.relativePath.split("/").length ||
      left.relativePath.localeCompare(right.relativePath),
  );
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { directories, files };
}

function desiredTypes(snapshot: {
  directories: SnapshotDirectory[];
  files: Array<{ relativePath: string }>;
}): Map<string, "dir" | "file"> {
  return new Map<string, "dir" | "file">([
    ...snapshot.directories.map((entry) => [entry.relativePath, "dir"] as const),
    ...snapshot.files.map((entry) => [entry.relativePath, "file"] as const),
  ]);
}

async function reconcileRemoteWorkspace(options: {
  sandbox: E2BSandboxHandle;
  snapshot: LocalSnapshot;
  inventory: RemoteInventory;
  remoteRoot: string;
  limits: E2BSyncLimits;
  signal?: AbortSignal;
}): Promise<number> {
  const desired = desiredTypes(options.snapshot);
  const existing = new Map(options.inventory.entries.map((entry) => [entry.relativePath, entry]));

  const removals = [...options.inventory.entries].sort((left, right) => {
    if (left.type !== right.type) return left.type === "file" ? -1 : 1;
    return right.relativePath.split("/").length - left.relativePath.split("/").length;
  });
  for (const entry of removals) {
    const desiredType = desired.get(entry.relativePath);
    const needsRemoval =
      entry.symlinkTarget !== undefined || desiredType === undefined || desiredType !== entry.type;
    if (!needsRemoval) continue;
    if (entry.type === "dir" && options.inventory.protectedAncestors.has(entry.relativePath)) {
      if (desiredType === "file") {
        throw new E2BWorkspaceSyncError(
          `Cannot replace ${entry.relativePath}; it contains an excluded dependency directory.`,
        );
      }
      continue;
    }
    await options.sandbox.remove(entry.path, options.signal);
    existing.delete(entry.relativePath);
  }

  await options.sandbox.makeDir(options.remoteRoot, options.signal);
  for (const directory of options.snapshot.directories) {
    const entry = existing.get(directory.relativePath);
    if (entry?.type === "dir" && entry.symlinkTarget === undefined) continue;
    await options.sandbox.makeDir(
      path.posix.join(options.remoteRoot, directory.relativePath),
      options.signal,
    );
  }

  let uploadedBytes = 0;
  let batch: Array<{ path: string; data: Uint8Array }> = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await options.sandbox.writeFiles(batch, options.signal);
    batch = [];
    batchBytes = 0;
  };
  for (const file of options.snapshot.files) {
    const data = await safelyReadLocalFile(file, options.limits, options.signal);
    if (
      batch.length >= WRITE_BATCH_FILE_LIMIT ||
      (batch.length > 0 && batchBytes + data.byteLength > WRITE_BATCH_BYTE_LIMIT)
    ) {
      await flush();
    }
    batch.push({
      path: path.posix.join(options.remoteRoot, file.relativePath),
      data,
    });
    batchBytes += data.byteLength;
    uploadedBytes += data.byteLength;
  }
  await flush();
  return uploadedBytes;
}

/**
 * Mirror a credential-free local checkout into E2B. It is a manifest-based
 * in-place merge: dependency directories at any depth stay in E2B, while no
 * `.git`, `node_modules`, or `.quillra-temp` content crosses the boundary.
 * No archive is extracted and symbolic links and special files are rejected.
 */
export async function syncLocalWorkspaceToE2B(options: {
  sandbox: E2BSandboxHandle;
  localRoot: string;
  remoteRoot?: string;
  limits?: E2BSyncLimits;
  signal?: AbortSignal;
}): Promise<{ entries: number; bytes: number }> {
  const limits = options.limits ?? DEFAULT_E2B_SYNC_LIMITS;
  const localRoot = await assertLocalRoot(options.localRoot);
  const remoteRoot = path.posix.resolve(options.remoteRoot ?? E2B_WORKSPACE_ROOT);
  const snapshot = await collectLocalSnapshot(localRoot, limits, options.signal);
  const inventory = await collectRemoteInventory({
    sandbox: options.sandbox,
    remoteRoot,
    limits,
    signal: options.signal,
    rejectSymlinks: false,
  });
  const bytes = await reconcileRemoteWorkspace({
    sandbox: options.sandbox,
    snapshot,
    inventory,
    remoteRoot,
    limits,
    signal: options.signal,
  });
  return {
    entries: snapshot.directories.length + snapshot.files.length,
    bytes,
  };
}

async function writeRemoteSnapshotToLocalStage(options: {
  sandbox: E2BSandboxHandle;
  snapshot: RemoteSnapshot;
  stageRoot: string;
  limits: E2BSyncLimits;
  signal?: AbortSignal;
}): Promise<number> {
  for (const directory of options.snapshot.directories) {
    throwIfAborted(options.signal);
    const target = path.join(options.stageRoot, ...directory.relativePath.split("/"));
    await fs.mkdir(target, { recursive: true, mode: directory.mode & 0o777 });
  }

  let downloadedBytes = 0;
  for (const file of options.snapshot.files) {
    throwIfAborted(options.signal);
    const target = path.join(options.stageRoot, ...file.relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    const handle = await fs.open(target, "wx", file.mode & 0o111 ? 0o755 : 0o644);
    try {
      let offset = 0;
      while (offset < file.size) {
        throwIfAborted(options.signal);
        const expected = Math.min(READ_CHUNK_BYTES, file.size - offset);
        const chunk = await options.sandbox.readFileChunk(
          file.remotePath,
          offset,
          expected,
          options.signal,
        );
        if (chunk.byteLength !== expected) {
          throw new E2BWorkspaceSyncError(`E2B file changed during sync: ${file.relativePath}`);
        }
        await handle.write(chunk, 0, chunk.byteLength, offset);
        offset += chunk.byteLength;
        downloadedBytes += chunk.byteLength;
        if (downloadedBytes > options.limits.maxTotalBytes) {
          throw new E2BWorkspaceSyncError("Workspace exceeds the total sync size limit.");
        }
      }
    } finally {
      await handle.close();
    }
  }
  return downloadedBytes;
}

async function reconcileLocalWorkspace(options: {
  localRoot: string;
  stageRoot: string;
  snapshot: RemoteSnapshot;
  existing: LocalSnapshot;
  limits: E2BSyncLimits;
}): Promise<void> {
  const desired = desiredTypes(options.snapshot);
  const existingTypes = desiredTypes(options.existing);
  const existingPaths = [
    ...options.existing.files.map((entry) => ({
      relativePath: entry.relativePath,
      type: "file" as const,
    })),
    ...options.existing.directories.map((entry) => ({
      relativePath: entry.relativePath,
      type: "dir" as const,
    })),
  ].sort((left, right) => {
    if (left.type !== right.type) return left.type === "file" ? -1 : 1;
    return right.relativePath.split("/").length - left.relativePath.split("/").length;
  });

  for (const entry of existingPaths) {
    const desiredType = desired.get(entry.relativePath);
    if (desiredType === entry.type) continue;
    if (entry.type === "dir" && options.existing.protectedAncestors.has(entry.relativePath)) {
      if (desiredType === "file") {
        throw new E2BWorkspaceSyncError(
          `Cannot replace ${entry.relativePath}; it contains an excluded dependency directory.`,
        );
      }
      continue;
    }
    await fs.rm(path.join(options.localRoot, ...entry.relativePath.split("/")), {
      recursive: true,
      force: true,
    });
    existingTypes.delete(entry.relativePath);
  }

  for (const directory of options.snapshot.directories) {
    if (existingTypes.get(directory.relativePath) === "dir") continue;
    await fs.mkdir(path.join(options.localRoot, ...directory.relativePath.split("/")), {
      recursive: true,
      mode: directory.mode & 0o777,
    });
  }

  for (const file of options.snapshot.files) {
    const target = path.join(options.localRoot, ...file.relativePath.split("/"));
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(path.join(options.stageRoot, ...file.relativePath.split("/")), target);
  }
}

/**
 * Mirror command changes back to the local credential-free checkout. Preview
 * workspaces deliberately never call this function. All remote paths are
 * validated before download; files first land in a fresh sibling directory,
 * and excluded directories are preserved at every nesting depth.
 */
export async function syncE2BWorkspaceToLocal(options: {
  sandbox: E2BSandboxHandle;
  localRoot: string;
  remoteRoot?: string;
  limits?: E2BSyncLimits;
  signal?: AbortSignal;
}): Promise<{ entries: number; bytes: number }> {
  const limits = options.limits ?? DEFAULT_E2B_SYNC_LIMITS;
  const localRoot = await assertLocalRoot(options.localRoot);
  const remoteRoot = path.posix.resolve(options.remoteRoot ?? E2B_WORKSPACE_ROOT);
  const inventory = await collectRemoteInventory({
    sandbox: options.sandbox,
    remoteRoot,
    limits,
    signal: options.signal,
    rejectSymlinks: true,
  });
  const snapshot = remoteSnapshotFromInventory(inventory);
  const existing = await collectLocalSnapshot(localRoot, limits, options.signal);

  const stageRoot = await fs.mkdtemp(
    path.join(path.dirname(localRoot), `.quillra-e2b-sync-${randomUUID()}-`),
  );
  try {
    const bytes = await writeRemoteSnapshotToLocalStage({
      sandbox: options.sandbox,
      snapshot,
      stageRoot,
      limits,
      signal: options.signal,
    });
    await assertLocalRoot(localRoot);
    await reconcileLocalWorkspace({
      localRoot,
      stageRoot,
      snapshot,
      existing,
      limits,
    });
    return {
      entries: snapshot.directories.length + snapshot.files.length,
      bytes,
    };
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}
