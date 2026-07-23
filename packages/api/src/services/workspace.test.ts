import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolvePreviewCapability,
  resolvePreviewCapabilityToken,
  revokePreviewCapability,
} from "./preview-capability.js";
import { unregisterPreviewPort } from "./preview-status.js";
import {
  getPackageManager,
  getPreviewUrl,
  reserveAvailablePreviewPort,
  scrubGitRemoteCredentials,
  simpleGitForProject,
} from "./workspace.js";

const tempDirectories: string[] = [];

function createRepo(packageManager?: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quillra-package-manager-"));
  tempDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "fixture", private: true, packageManager }),
  );
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  revokePreviewCapability("project-preview-url");
  unregisterPreviewPort("project-preview-url");
  unregisterPreviewPort("project-0");
  unregisterPreviewPort("project-275");
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("getPreviewUrl", () => {
  it("mints a project-and-port-scoped capability path", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://quillra.example/");

    const url = new URL(getPreviewUrl("project-preview-url", 4_321));
    const capability = url.pathname.split("/")[3] ?? "";

    expect(url.origin).toBe("https://quillra.example");
    expect(url.pathname).toMatch(/^\/__preview\/4321\/[A-Za-z0-9_-]{32}\/$/);
    expect(resolvePreviewCapability("4321", capability)).toMatchObject({
      ok: true,
      projectId: "project-preview-url",
      port: 4_321,
    });
  });

  it("uses an isolated preview host when PREVIEW_DOMAIN is configured", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://cms.example.com");
    vi.stubEnv("BETTER_AUTH_SECRET", "workspace-preview-host-secret");
    vi.stubEnv("PREVIEW_DOMAIN", "preview.example.net");

    const url = new URL(getPreviewUrl("project-preview-url", 4_321));
    const capability = url.searchParams.get("__quillra_preview") ?? "";

    expect(url.hostname).toMatch(/^p-[a-f0-9]{40}\.preview\.example\.net$/);
    expect(url.pathname).toBe("/");
    expect(resolvePreviewCapabilityToken(capability)).toMatchObject({
      ok: true,
      projectId: "project-preview-url",
      port: 4_321,
    });
  });
});

describe("reserveAvailablePreviewPort", () => {
  it("reserves stable, different ports when deterministic hashes collide", async () => {
    const first = await reserveAvailablePreviewPort("project-0");
    const second = await reserveAvailablePreviewPort("project-275");

    expect(first).not.toBe(second);
    expect(await reserveAvailablePreviewPort("project-0")).toBe(first);
    expect(await reserveAvailablePreviewPort("project-275")).toBe(second);
  });

  it("serializes concurrent reservations for one project", async () => {
    const ports = await Promise.all([
      reserveAvailablePreviewPort("project-concurrent"),
      reserveAvailablePreviewPort("project-concurrent"),
      reserveAvailablePreviewPort("project-concurrent"),
    ]);

    expect(new Set(ports).size).toBe(1);
    unregisterPreviewPort("project-concurrent");
  });

  it("skips a deterministic port already occupied by another process", async () => {
    const server = net.createServer();
    const occupiedPort = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("Expected TCP address"));
        else resolve(address.port);
      });
    });

    // Find a project hash whose base maps to the occupied port while still
    // satisfying the production range guard.
    let projectId = "";
    let base = 0;
    for (let candidate = 0; candidate < 10_000; candidate++) {
      const id = `occupied-port-project-${candidate}`;
      let hash = 0;
      for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      const candidateBase = occupiedPort - (hash % 2_000);
      if (candidateBase > 0 && candidateBase <= 65_535 - 2_000) {
        projectId = id;
        base = candidateBase;
        break;
      }
    }
    expect(projectId).not.toBe("");
    vi.stubEnv("PREVIEW_PORT_BASE", String(base));
    const reserved = await reserveAvailablePreviewPort(projectId);
    expect(reserved).not.toBe(occupiedPort);
    unregisterPreviewPort(projectId);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
});

describe("getPackageManager", () => {
  it("honors an explicit packageManager ahead of stale lockfiles", () => {
    const repo = createRepo("pnpm@10.34.0");
    fs.writeFileSync(path.join(repo, "yarn.lock"), "");

    expect(getPackageManager(repo)).toBe("pnpm");
  });

  it("falls back to the lockfile for projects without a declaration", () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "");

    expect(getPackageManager(repo)).toBe("pnpm");
  });

  it("ignores unsupported declarations and defaults to npm", () => {
    expect(getPackageManager(createRepo("bun@1.3.0"))).toBe("npm");
  });
});

describe("project Git security", () => {
  it("scrubs installation credentials from the persisted origin URL", async () => {
    const repo = createRepo();
    const git = simpleGit(repo);
    await git.init();
    await git.addRemote(
      "origin",
      "https://x-access-token:github-installation-secret@github.com/example/site.git",
    );

    await scrubGitRemoteCredentials(repo, "example/site");

    const config = fs.readFileSync(path.join(repo, ".git", "config"), "utf8");
    expect(config).toContain("https://github.com/example/site.git");
    expect(config).not.toContain("github-installation-secret");
    expect(config).not.toContain("x-access-token");
  });

  it("does not execute repository-installed Git hooks", async () => {
    const repo = createRepo();
    const git = simpleGitForProject(repo);
    await git.init();
    await git.addConfig("user.name", "Quillra Test");
    await git.addConfig("user.email", "test@quillra.test");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "safe");
    await git.add("tracked.txt");

    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    const marker = path.join(repo, "hook-ran");
    fs.writeFileSync(hook, `#!/bin/sh\nprintf hook-ran > "${marker}"\n`);
    fs.chmodSync(hook, 0o755);

    await git.commit("test commit");
    expect(fs.existsSync(marker)).toBe(false);
  });
});
