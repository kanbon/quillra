import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeReservedPreviewHandoff,
  resolvePreviewCapability,
  resolvePreviewCapabilityToken,
  resolveReservedPreviewSessionToken,
  revokePreviewCapability,
} from "./preview-capability.js";
import { registerPreviewPort, unregisterPreviewPort } from "./preview-status.js";
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
    registerPreviewPort(4_321, "project-preview-url");

    const url = new URL(getPreviewUrl("project-preview-url", 4_321));
    const handoff = url.searchParams.get("__quillra_preview") ?? "";

    expect(url.hostname).toMatch(/^p-[a-f0-9]{40}\.preview\.example\.net$/);
    expect(url.pathname).toBe("/");
    expect(resolvePreviewCapabilityToken(handoff)).toEqual({ ok: false });
    const exchanged = consumeReservedPreviewHandoff(handoff, url.host);
    expect(exchanged).toMatchObject({
      ok: true,
      projectId: "project-preview-url",
      port: 4_321,
    });
    if (!exchanged.ok) return;
    expect(exchanged.token).not.toBe(handoff);
    expect(resolveReservedPreviewSessionToken(exchanged.token, url.host)).toMatchObject({
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
    const git = simpleGitForProject(repo, {
      name: "Quillra Test",
      email: "test@quillra.test",
    });
    await git.init();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "safe");
    await git.add("tracked.txt");

    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    const marker = path.join(repo, "hook-ran");
    fs.writeFileSync(hook, `#!/bin/sh\nprintf hook-ran > "${marker}"\n`);
    fs.chmodSync(hook, 0o755);

    await git.commit("test commit");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("removes executable local config before every project Git command", async () => {
    const repo = createRepo();
    const identity = {
      name: "Quillra Test",
      email: "test@quillra.test",
    };
    const setupGit = simpleGit({
      baseDir: repo,
      config: [`user.name=${identity.name}`, `user.email=${identity.email}`],
    });
    await setupGit.init();

    fs.writeFileSync(
      path.join(repo, ".gitattributes"),
      "tracked.txt filter=quillra-evil diff=quillra-evil merge=quillra-evil\n",
    );
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
    await setupGit.add([".gitattributes", "tracked.txt"]);
    await setupGit.commit("base");
    const initialBranch = (await setupGit.branchLocal()).current;
    await setupGit.checkoutLocalBranch("feature");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "feature\n");
    await setupGit.add("tracked.txt");
    await setupGit.commit("feature");
    await setupGit.checkout(initialBranch);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "main\n");
    await setupGit.add("tracked.txt");
    await setupGit.commit("main");

    const marker = path.join(repo, "git-config-command-ran");
    const executable = path.join(repo, "git-config-command");
    fs.writeFileSync(executable, `#!/bin/sh\n: > "${marker}"\ncat\n`);
    fs.chmodSync(executable, 0o755);

    const plantExecutableConfig = () => {
      fs.writeFileSync(
        path.join(repo, ".git", "config"),
        [
          "[core]",
          "\trepositoryformatversion = 0",
          "\tfilemode = true",
          "\tbare = false",
          "\tlogallrefupdates = true",
          `\tfsmonitor = ${executable}`,
          `\tsshCommand = ${executable}`,
          '[filter "quillra-evil"]',
          `\tclean = ${executable}`,
          `\tsmudge = ${executable}`,
          '[diff "quillra-evil"]',
          `\tcommand = ${executable}`,
          '[merge "quillra-evil"]',
          `\tdriver = ${executable} %O %A %B`,
          "[diff]",
          `\texternal = ${executable}`,
          "[credential]",
          `\thelper = !${executable}`,
          "[http]",
          "\tproxy = http://127.0.0.1:9",
          "[include]",
          `\tpath = ${executable}`,
          "[alias]",
          `\tstatus = !${executable}`,
          "",
        ].join("\n"),
      );
    };
    const expectCommandBlocked = async (command: () => Promise<unknown>) => {
      plantExecutableConfig();
      fs.rmSync(marker, { force: true });
      await command();
      expect(fs.existsSync(marker)).toBe(false);
    };

    const git = simpleGitForProject(repo, identity);
    await expectCommandBlocked(() => git.status());
    await expectCommandBlocked(() => git.checkout("feature"));
    await expectCommandBlocked(() => git.checkout(initialBranch));

    fs.writeFileSync(path.join(repo, "tracked.txt"), "main staged\n");
    await expectCommandBlocked(() => git.add("tracked.txt"));
    await expectCommandBlocked(() => git.diff(["--cached"]));
    await git.reset(["--hard", "HEAD"]);

    await expectCommandBlocked(() =>
      git.raw(["merge", "--no-edit", "feature"]).catch(() => undefined),
    );
    await git.raw(["merge", "--abort"]).catch(() => undefined);

    const sanitized = fs.readFileSync(path.join(repo, ".git", "config"), "utf8");
    expect(sanitized).toContain("[core]");
    expect(sanitized).not.toContain(executable);
    expect(sanitized).not.toMatch(
      /fsmonitor|filter|external|merge\s+"quillra-evil"|credential|proxy|include|alias|sshCommand/i,
    );
  });
});
