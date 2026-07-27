import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  E2BRemoteEntry,
  E2BRemoteTreeManifest,
  E2BRemoteTreeOptions,
  E2BSandboxHandle,
} from "./e2b-adapter.js";
import {
  E2BWorkspaceSyncError,
  E2B_WORKSPACE_ROOT,
  syncE2BWorkspaceToLocal,
  syncLocalWorkspaceToE2B,
} from "./e2b-workspace-sync.js";

type FakeNode = {
  type: "file" | "dir" | "special";
  data?: Uint8Array;
  mode: number;
  symlinkTarget?: string;
};

class FakeSandbox implements E2BSandboxHandle {
  readonly sandboxId = "sandbox-sync";
  readonly trafficAccessToken = "traffic-sync";
  readonly nodes = new Map<string, FakeNode>();
  readonly listCalls: Array<{ target: string; maxEntries: number }> = [];
  readonly scanTreeCalls: Array<{ target: string; maxEntries: number }> = [];
  readonly writeBatches: Array<Array<{ path: string; bytes: number }>> = [];
  readonly makeDirCalls: string[] = [];

  constructor() {
    this.nodes.set("/home", { type: "dir", mode: 0o755 });
    this.nodes.set("/home/quillra-project", { type: "dir", mode: 0o700 });
  }

  addDir(target: string): void {
    this.makeParents(target);
    this.nodes.set(path.posix.resolve(target), { type: "dir", mode: 0o755 });
  }

  addFile(target: string, content: string): void {
    this.makeParents(path.posix.dirname(target));
    this.nodes.set(path.posix.resolve(target), {
      type: "file",
      data: new TextEncoder().encode(content),
      mode: 0o644,
    });
  }

  addSymlink(target: string, linkTarget: string): void {
    this.makeParents(path.posix.dirname(target));
    this.nodes.set(path.posix.resolve(target), {
      type: "file",
      data: new Uint8Array(),
      mode: 0o777,
      symlinkTarget: linkTarget,
    });
  }

  addSpecial(target: string): void {
    this.makeParents(path.posix.dirname(target));
    this.nodes.set(path.posix.resolve(target), {
      type: "special",
      mode: 0o600,
    });
  }

  text(target: string): string | undefined {
    const data = this.nodes.get(path.posix.resolve(target))?.data;
    return data ? new TextDecoder().decode(data) : undefined;
  }

  async list(
    target: string,
    options: { maxEntries: number; maxOutputBytes: number },
  ): Promise<E2BRemoteEntry[]> {
    const directory = path.posix.resolve(target);
    this.listCalls.push({ target: directory, maxEntries: options.maxEntries });
    const entries = [...this.nodes.entries()]
      .filter(([entryPath]) => path.posix.dirname(entryPath) === directory)
      .map(([entryPath, node]) => this.entry(entryPath, node))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (entries.length > options.maxEntries) throw new Error("entry limit");
    return entries;
  }

  async scanTree(target: string, options: E2BRemoteTreeOptions): Promise<E2BRemoteTreeManifest> {
    const root = path.posix.resolve(target);
    this.scanTreeCalls.push({ target: root, maxEntries: options.maxEntries });
    const rootNode = this.nodes.get(root);
    if (!rootNode) return { root: null, entries: [] };

    const entries = [...this.nodes.entries()]
      .filter(([entryPath]) => entryPath.startsWith(`${root}/`))
      .filter(([entryPath]) => {
        const segments = path.posix.relative(root, entryPath).split("/");
        const excludedIndex = segments.findIndex((segment) =>
          options.excludedSegments.includes(segment),
        );
        return excludedIndex === -1 || excludedIndex === segments.length - 1;
      })
      .map(([entryPath, node]) => {
        const entry = this.entry(entryPath, node);
        const segments = path.posix.relative(root, entryPath).split("/");
        return {
          ...entry,
          sha256:
            node.type === "file" &&
            node.symlinkTarget === undefined &&
            !segments.some((segment) => options.excludedSegments.includes(segment))
              ? createHash("sha256")
                  .update(node.data ?? new Uint8Array())
                  .digest("hex")
              : undefined,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    if (entries.length > options.maxEntries) throw new Error("entry limit");
    if (Buffer.byteLength(JSON.stringify(entries), "utf8") > options.maxOutputBytes) {
      throw new Error("output limit");
    }
    return {
      root: this.entry(root, rootNode),
      entries,
    };
  }

  async getInfo(target: string): Promise<E2BRemoteEntry> {
    const resolved = path.posix.resolve(target);
    const node = this.nodes.get(resolved);
    if (!node) throw new Error("not found");
    return this.entry(resolved, node);
  }

  async readFileChunk(target: string, offset: number, length: number): Promise<Uint8Array> {
    const node = this.nodes.get(path.posix.resolve(target));
    if (!node?.data) throw new Error("not a file");
    return Uint8Array.from(node.data.subarray(offset, offset + length));
  }

  async writeFiles(files: Array<{ path: string; data: Uint8Array; mode?: number }>): Promise<void> {
    this.writeBatches.push(files.map((file) => ({ path: file.path, bytes: file.data.byteLength })));
    for (const file of files) {
      this.addFile(file.path, new TextDecoder().decode(file.data));
      const node = this.nodes.get(path.posix.resolve(file.path));
      if (node && file.mode !== undefined) {
        node.mode = file.mode & 0o111 ? 0o755 : 0o644;
      }
    }
  }

  async makeDir(target: string): Promise<void> {
    this.makeDirCalls.push(path.posix.resolve(target));
    this.addDir(target);
  }

  async exists(target: string): Promise<boolean> {
    return this.nodes.has(path.posix.resolve(target));
  }

  async remove(target: string): Promise<void> {
    const resolved = path.posix.resolve(target);
    for (const entryPath of [...this.nodes.keys()]) {
      if (entryPath === resolved || entryPath.startsWith(`${resolved}/`)) {
        this.nodes.delete(entryPath);
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = path.posix.resolve(from);
    const destination = path.posix.resolve(to);
    const moved = [...this.nodes.entries()].filter(
      ([entryPath]) => entryPath === source || entryPath.startsWith(`${source}/`),
    );
    for (const [entryPath] of moved) this.nodes.delete(entryPath);
    for (const [entryPath, node] of moved) {
      this.nodes.set(`${destination}${entryPath.slice(source.length)}`, node);
    }
  }

  prepareExecutionEnvironment = vi.fn(async () => undefined);
  quiesceProjectProcesses = vi.fn(async () => undefined);
  startPreviewRelay = vi.fn(async () => undefined);
  stopPreviewRelay = vi.fn(async () => undefined);
  startCommand = vi.fn();
  killProcess = vi.fn(async () => false);
  getHost = vi.fn(() => "sandbox.e2b.app");
  pause = vi.fn(async () => true);
  kill = vi.fn(async () => true);

  private makeParents(target: string): void {
    const resolved = path.posix.resolve(target);
    const segments = resolved.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      if (!this.nodes.has(current)) {
        this.nodes.set(current, { type: "dir", mode: 0o755 });
      }
    }
  }

  private entry(entryPath: string, node: FakeNode): E2BRemoteEntry {
    return {
      name: path.posix.basename(entryPath),
      path: entryPath,
      type: node.type,
      size: node.data?.byteLength ?? 0,
      mode: node.mode,
      symlinkTarget: node.symlinkTarget,
    };
  }
}

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quillra-e2b-sync-test-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("E2B workspace sync", () => {
  it("preserves nested dependency caches while mirroring source in place", async () => {
    const sandbox = new FakeSandbox();
    sandbox.addDir(E2B_WORKSPACE_ROOT);
    sandbox.addDir(`${E2B_WORKSPACE_ROOT}/packages/app/node_modules/cache`);
    sandbox.addFile(`${E2B_WORKSPACE_ROOT}/packages/app/node_modules/cache/keep`, "cached");
    sandbox.addFile(`${E2B_WORKSPACE_ROOT}/packages/app/stale.ts`, "stale");

    await fs.mkdir(path.join(tempRoot, "packages/app"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "packages/app/index.ts"), "export const ok = true");
    await fs.mkdir(path.join(tempRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, ".git/config"), "control-plane-only");

    await syncLocalWorkspaceToE2B({ sandbox, localRoot: tempRoot });

    expect(sandbox.text(`${E2B_WORKSPACE_ROOT}/packages/app/node_modules/cache/keep`)).toBe(
      "cached",
    );
    expect(sandbox.text(`${E2B_WORKSPACE_ROOT}/packages/app/index.ts`)).toBe(
      "export const ok = true",
    );
    expect(await sandbox.exists(`${E2B_WORKSPACE_ROOT}/packages/app/stale.ts`)).toBe(false);
    expect(await sandbox.exists(`${E2B_WORKSPACE_ROOT}/.git/config`)).toBe(false);
    expect(sandbox.scanTreeCalls).toEqual([{ target: E2B_WORKSPACE_ROOT, maxEntries: 20_000 }]);
    expect(sandbox.listCalls).toHaveLength(0);
  });

  it("uploads zero files and bytes when a second sync is unchanged", async () => {
    const sandbox = new FakeSandbox();
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src/index.ts"), "same");

    const first = await syncLocalWorkspaceToE2B({ sandbox, localRoot: tempRoot });
    const batchesAfterFirst = sandbox.writeBatches.length;
    const directoriesAfterFirst = sandbox.makeDirCalls.length;
    const second = await syncLocalWorkspaceToE2B({ sandbox, localRoot: tempRoot });

    expect(first.bytes).toBe(4);
    expect(second.bytes).toBe(0);
    expect(sandbox.writeBatches).toHaveLength(batchesAfterFirst);
    expect(sandbox.makeDirCalls).toHaveLength(directoriesAfterFirst);
    expect(sandbox.listCalls).toHaveLength(0);
    expect(sandbox.scanTreeCalls).toHaveLength(2);
  });

  it("uploads a same-size content change and ignores no project-writable marker", async () => {
    const sandbox = new FakeSandbox();
    await fs.writeFile(path.join(tempRoot, "index.ts"), "first");
    await syncLocalWorkspaceToE2B({ sandbox, localRoot: tempRoot });
    sandbox.addFile(`${E2B_WORKSPACE_ROOT}/index.ts`, "other");
    sandbox.addFile(`${E2B_WORKSPACE_ROOT}/.quillra-sync-marker`, "unchanged");

    const result = await syncLocalWorkspaceToE2B({ sandbox, localRoot: tempRoot });

    expect(result.bytes).toBe(5);
    expect(sandbox.text(`${E2B_WORKSPACE_ROOT}/index.ts`)).toBe("first");
    expect(await sandbox.exists(`${E2B_WORKSPACE_ROOT}/.quillra-sync-marker`)).toBe(false);
  });

  it("reapplies executable mode changes even when file content is unchanged", async () => {
    const sandbox = new FakeSandbox();
    const script = path.join(tempRoot, "script.sh");
    await fs.writeFile(script, "#!/bin/sh\n");
    await fs.chmod(script, 0o644);
    await syncLocalWorkspaceToE2B({ sandbox, localRoot: tempRoot });
    await fs.chmod(script, 0o755);

    const result = await syncLocalWorkspaceToE2B({ sandbox, localRoot: tempRoot });

    expect(result.bytes).toBe(10);
    expect(sandbox.nodes.get(`${E2B_WORKSPACE_ROOT}/script.sh`)?.mode).toBe(0o755);
  });

  it("reconciles deletions and file-directory type changes while preserving dependencies", async () => {
    const sandbox = new FakeSandbox();
    sandbox.addDir(E2B_WORKSPACE_ROOT);
    sandbox.addFile(`${E2B_WORKSPACE_ROOT}/deleted.ts`, "remove");
    sandbox.addFile(`${E2B_WORKSPACE_ROOT}/to-directory`, "old file");
    sandbox.addDir(`${E2B_WORKSPACE_ROOT}/to-file/child`);
    sandbox.addFile(`${E2B_WORKSPACE_ROOT}/to-file/child/old.ts`, "old");
    sandbox.addDir(`${E2B_WORKSPACE_ROOT}/node_modules/cache`);
    sandbox.addFile(`${E2B_WORKSPACE_ROOT}/node_modules/cache/keep`, "dependency");
    await fs.mkdir(path.join(tempRoot, "to-directory"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "to-directory/new.ts"), "new");
    await fs.writeFile(path.join(tempRoot, "to-file"), "replacement");

    await syncLocalWorkspaceToE2B({ sandbox, localRoot: tempRoot });

    expect(await sandbox.exists(`${E2B_WORKSPACE_ROOT}/deleted.ts`)).toBe(false);
    expect(sandbox.text(`${E2B_WORKSPACE_ROOT}/to-directory/new.ts`)).toBe("new");
    expect(sandbox.text(`${E2B_WORKSPACE_ROOT}/to-file`)).toBe("replacement");
    expect(await sandbox.exists(`${E2B_WORKSPACE_ROOT}/to-file/child/old.ts`)).toBe(false);
    expect(sandbox.text(`${E2B_WORKSPACE_ROOT}/node_modules/cache/keep`)).toBe("dependency");
  });

  it("rejects local symbolic links instead of following them", async () => {
    const sandbox = new FakeSandbox();
    sandbox.addDir(E2B_WORKSPACE_ROOT);
    const outside = path.join(path.dirname(tempRoot), "outside-secret");
    await fs.writeFile(outside, "secret");
    await fs.symlink(outside, path.join(tempRoot, "escape"));

    await expect(syncLocalWorkspaceToE2B({ sandbox, localRoot: tempRoot })).rejects.toThrow(
      E2BWorkspaceSyncError,
    );
    expect(await sandbox.exists(`${E2B_WORKSPACE_ROOT}/escape`)).toBe(false);
    await fs.rm(outside, { force: true });
  });

  it("stops local directory iteration at the global entry cap before remote writes", async () => {
    const sandbox = new FakeSandbox();
    sandbox.addDir(E2B_WORKSPACE_ROOT);
    await fs.writeFile(path.join(tempRoot, "one"), "1");
    await fs.writeFile(path.join(tempRoot, "two"), "2");
    await fs.writeFile(path.join(tempRoot, "three"), "3");

    await expect(
      syncLocalWorkspaceToE2B({
        sandbox,
        localRoot: tempRoot,
        limits: {
          maxEntries: 2,
          maxDepth: 40,
          maxPathBytes: 1_024,
          maxFileBytes: 64 * 1024 * 1024,
          maxTotalBytes: 512 * 1024 * 1024,
        },
      }),
    ).rejects.toThrow("entry limit");
    expect(sandbox.listCalls).toHaveLength(0);
  });

  it("rejects remote symbolic links before writing anything locally", async () => {
    const sandbox = new FakeSandbox();
    sandbox.addDir(E2B_WORKSPACE_ROOT);
    sandbox.addSymlink(`${E2B_WORKSPACE_ROOT}/escape`, "/etc/passwd");
    await fs.writeFile(path.join(tempRoot, "untouched"), "yes");

    await expect(syncE2BWorkspaceToLocal({ sandbox, localRoot: tempRoot })).rejects.toThrow(
      E2BWorkspaceSyncError,
    );
    await expect(fs.readFile(path.join(tempRoot, "untouched"), "utf8")).resolves.toBe("yes");
  });

  it("rejects remote special files before writing anything locally", async () => {
    const sandbox = new FakeSandbox();
    sandbox.addDir(E2B_WORKSPACE_ROOT);
    sandbox.addSpecial(`${E2B_WORKSPACE_ROOT}/socket`);
    await fs.writeFile(path.join(tempRoot, "untouched"), "yes");

    await expect(syncE2BWorkspaceToLocal({ sandbox, localRoot: tempRoot })).rejects.toThrow(
      "special E2B filesystem entry",
    );
    await expect(fs.readFile(path.join(tempRoot, "untouched"), "utf8")).resolves.toBe("yes");
  });

  it("rejects an oversized remote path before writing anything locally", async () => {
    const sandbox = new FakeSandbox();
    sandbox.addDir(E2B_WORKSPACE_ROOT);
    sandbox.addFile(`${E2B_WORKSPACE_ROOT}/${"a".repeat(200)}`, "too-long");
    await fs.writeFile(path.join(tempRoot, "untouched"), "yes");

    await expect(
      syncE2BWorkspaceToLocal({
        sandbox,
        localRoot: tempRoot,
        limits: {
          maxEntries: 20_000,
          maxDepth: 40,
          maxPathBytes: 128,
          maxFileBytes: 64 * 1024 * 1024,
          maxTotalBytes: 512 * 1024 * 1024,
        },
      }),
    ).rejects.toThrow("path is too long");
    await expect(fs.readFile(path.join(tempRoot, "untouched"), "utf8")).resolves.toBe("yes");
  });
});
