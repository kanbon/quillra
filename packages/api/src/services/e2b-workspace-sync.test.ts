import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { E2BRemoteEntry, E2BSandboxHandle } from "./e2b-adapter.js";
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

  constructor() {
    this.nodes.set("/home", { type: "dir", mode: 0o755 });
    this.nodes.set("/home/user", { type: "dir", mode: 0o755 });
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

  async writeFiles(files: Array<{ path: string; data: Uint8Array }>): Promise<void> {
    for (const file of files) {
      this.addFile(file.path, new TextDecoder().decode(file.data));
    }
  }

  async makeDir(target: string): Promise<void> {
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
    expect(sandbox.listCalls[0]?.maxEntries).toBe(20_000);
    expect(
      sandbox.listCalls.some(
        (call, index) => index > 0 && call.maxEntries < (sandbox.listCalls[0]?.maxEntries ?? 0),
      ),
    ).toBe(true);
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
