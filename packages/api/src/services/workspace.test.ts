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
  packageInstallCommand,
  reserveAvailablePreviewPort,
  resolveDevCommand,
  resolvePackageManager,
  scrubGitRemoteCredentials,
  simpleGitForProject,
} from "./workspace.js";

const tempDirectories: string[] = [];

function createRepo(
  packageManager?: unknown,
  manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    devEngines?: unknown;
  } = {},
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quillra-package-manager-"));
  tempDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "fixture", private: true, packageManager, ...manifest }),
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
    expect(resolvePackageManager(repo)).toEqual({ name: "pnpm", version: "10.34.0" });
  });

  it.each([
    ["yarn.lock", "yarn"],
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
  ] as const)("falls back to %s for projects without a declaration", (lockfile, expected) => {
    const repo = createRepo(undefined);
    fs.writeFileSync(path.join(repo, lockfile), "");

    expect(getPackageManager(repo)).toBe(expected);
  });

  it("fails clearly for an explicitly unsupported package manager", () => {
    expect(() => getPackageManager(createRepo("bun@1.3.0"))).toThrow(
      'Unsupported package manager "bun"',
    );
  });

  it.each([
    "pnpm@file:../manager",
    "yarn@https://example.test/yarn.tgz",
    "npm@git+ssh://host",
    "pnpm@latest",
    "yarn@4",
  ])("rejects unsafe package-manager references: %s", (declaration) => {
    expect(() => resolvePackageManager(createRepo(declaration))).toThrow(
      "must use an exact semantic version",
    );
  });

  it("preserves a Corepack integrity-qualified version", () => {
    const integrity = "a".repeat(128);
    expect(resolvePackageManager(createRepo(`pnpm@10.34.0+sha512.${integrity}`))).toEqual({
      name: "pnpm",
      version: `10.34.0+sha512.${integrity}`,
    });
  });

  it("uses devEngines.packageManager before lockfile detection", () => {
    const repo = createRepo(undefined, {
      devEngines: { packageManager: { name: "yarn", version: "4.9.1" } },
    });
    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "");

    expect(resolvePackageManager(repo)).toEqual({ name: "yarn", version: "4.9.1" });
  });

  it.each([42, {}, ["pnpm@10.34.0"]])(
    "rejects a non-string top-level packageManager without throwing a type error",
    (packageManager) => {
      expect(() => resolvePackageManager(createRepo(packageManager))).toThrow(
        "packageManager must be a string",
      );
    },
  );

  it("accepts devEngines arrays and semantic version ranges", () => {
    const repo = createRepo(undefined, {
      devEngines: {
        packageManager: [
          { name: "npm", version: "^11.0.0" },
          { name: "pnpm", version: ">=10 <11" },
        ],
      },
    });
    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "");

    expect(resolvePackageManager(repo)).toEqual({ name: "pnpm", version: ">=10 <11" });
  });

  it("skips an invalid devEngines range when another alternative is valid", () => {
    const repo = createRepo(undefined, {
      devEngines: {
        packageManager: [
          { name: "pnpm", version: "next10" },
          { name: "yarn", version: "^4.0.0", onFail: "error" },
        ],
      },
    });

    expect(resolvePackageManager(repo)).toEqual({ name: "yarn", version: "^4.0.0" });
  });

  it("applies advisory onFail when the only devEngines range is invalid", () => {
    const repo = createRepo(undefined, {
      devEngines: {
        packageManager: { name: "pnpm", version: "next10", onFail: "warn" },
      },
    });

    expect(resolvePackageManager(repo)).toEqual({ name: "npm", version: null });
  });

  it.each(["warn", "ignore"] as const)(
    "falls back when every devEngines package-manager alternative is unsupported with onFail=%s",
    (onFail) => {
      const repo = createRepo(undefined, {
        devEngines: {
          packageManager: [{ name: "bun" }, { name: "deno", onFail }],
        },
      });

      expect(resolvePackageManager(repo)).toEqual({ name: "npm", version: null });
    },
  );

  it("fails when every required devEngines package-manager alternative is unsupported", () => {
    const repo = createRepo(undefined, {
      devEngines: {
        packageManager: [{ name: "bun" }, { name: "deno", onFail: "error" }],
      },
    });

    expect(() => resolvePackageManager(repo)).toThrow('Unsupported package manager "bun"');
  });
});

describe("packageInstallCommand", () => {
  it.each([
    [
      "pnpm@10.34.0",
      "NODE_ENV=development NPM_CONFIG_PRODUCTION=false COREPACK_ENABLE_AUTO_PIN=0 COREPACK_DEFAULT_TO_LATEST=0 COREPACK_ENABLE_PROJECT_SPEC=0 'corepack' 'pnpm@10.34.0' 'install' '--prod=false'",
    ],
    [
      "yarn@4.9.1",
      "NODE_ENV=development NPM_CONFIG_PRODUCTION=false COREPACK_ENABLE_AUTO_PIN=0 COREPACK_DEFAULT_TO_LATEST=0 COREPACK_ENABLE_PROJECT_SPEC=0 'corepack' 'yarn@4.9.1' 'install'",
    ],
    [
      "npm@11.5.1",
      "NODE_ENV=development NPM_CONFIG_PRODUCTION=false COREPACK_ENABLE_AUTO_PIN=0 COREPACK_DEFAULT_TO_LATEST=0 COREPACK_ENABLE_PROJECT_SPEC=0 'corepack' 'npm@11.5.1' 'install' '--include=dev'",
    ],
  ])("builds the declared %s install command", (packageManager, expected) => {
    expect(packageInstallCommand(createRepo(packageManager))).toBe(expected);
  });

  it("uses Corepack's known-good pnpm when detection came from a lockfile", () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "");

    expect(packageInstallCommand(repo)).toContain("'corepack' 'pnpm' 'install'");
  });

  it("disables Corepack's second project-spec interpretation for a versionless declaration", () => {
    const repo = createRepo(undefined, {
      devEngines: { packageManager: { name: "pnpm" } },
    });

    expect(packageInstallCommand(repo)).toContain(
      "COREPACK_ENABLE_PROJECT_SPEC=0 'corepack' 'pnpm' 'install'",
    );
  });
});

describe("resolveDevCommand", () => {
  it.each([
    ["npm@11.5.1", ["corepack", "npm@11.5.1", "exec", "--", "vite"]],
    ["pnpm@10.34.0", ["corepack", "pnpm@10.34.0", "exec", "vite"]],
    ["yarn@4.9.1", ["corepack", "yarn@4.9.1", "run", "vite"]],
  ] as const)(
    "runs framework binaries through the declared %s",
    (packageManager, expectedCorepackPrefix) => {
      const repo = createRepo(packageManager, { devDependencies: { vite: "^7.0.0" } });
      const resolved = resolveDevCommand(repo, 4_321, null);

      expect(resolved.command).toBe("env");
      expect(resolved.args.slice(0, 3)).toEqual([
        "COREPACK_ENABLE_AUTO_PIN=0",
        "COREPACK_DEFAULT_TO_LATEST=0",
        "COREPACK_ENABLE_PROJECT_SPEC=0",
      ]);
      expect(resolved.args.slice(3, 3 + expectedCorepackPrefix.length)).toEqual(
        expectedCorepackPrefix,
      );
      expect(resolved.args).toContain("4321");
      expect(resolved.label).toBe("Vite");
    },
  );

  it.each([
    ["npm@11.5.1", ["corepack", "npm@11.5.1", "run", "dev"]],
    ["pnpm@10.34.0", ["corepack", "pnpm@10.34.0", "run", "dev"]],
    ["yarn@4.9.1", ["corepack", "yarn@4.9.1", "run", "dev"]],
  ] as const)(
    "runs a generic dev script through the declared %s",
    (packageManager, expectedCorepackArgs) => {
      const resolved = resolveDevCommand(
        createRepo(packageManager, { scripts: { dev: "custom-dev-server" } }),
        4_321,
        null,
      );

      expect(resolved.command).toBe("env");
      expect(resolved.args.slice(3)).toEqual(expectedCorepackArgs);
    },
  );

  it("uses bundled npx when npm has no explicit version", () => {
    const repo = createRepo(undefined, { devDependencies: { vite: "^7.0.0" } });

    expect(resolveDevCommand(repo, 4_321, null)).toMatchObject({
      command: "npx",
      args: ["vite", "--host", "127.0.0.1", "--port", "4321", "--strictPort"],
    });
  });

  it("resolves CRA without an npm-only embedded shell command", () => {
    const resolved = resolveDevCommand(
      createRepo("yarn@4.9.1", { dependencies: { "react-scripts": "^5.0.1" } }),
      4_321,
      null,
    );

    expect(resolved).toEqual({
      command: "env",
      args: [
        "COREPACK_ENABLE_AUTO_PIN=0",
        "COREPACK_DEFAULT_TO_LATEST=0",
        "COREPACK_ENABLE_PROJECT_SPEC=0",
        "corepack",
        "yarn@4.9.1",
        "run",
        "react-scripts",
        "start",
      ],
      label: "React (CRA)",
    });
  });

  it("does not read a symlinked package.json before E2B rejects it", () => {
    const repo = createRepo();
    const external = path.join(os.tmpdir(), `quillra-external-manifest-${Date.now()}.json`);
    fs.writeFileSync(external, JSON.stringify({ packageManager: "pnpm@10.34.0" }));
    fs.rmSync(path.join(repo, "package.json"));
    fs.symlinkSync(external, path.join(repo, "package.json"));
    try {
      expect(packageInstallCommand(repo)).toBeNull();
      expect(resolveDevCommand(repo, 4_321, null).command).toBe("npx");
    } finally {
      fs.rmSync(external, { force: true });
    }
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

  it("preserves the sanitized origin across guarded Git commands", async () => {
    const repo = createRepo();
    const git = simpleGit(repo);
    await git.init();
    await git.addRemote(
      "origin",
      "https://x-access-token:github-installation-secret@github.com/example/site.git",
    );

    await scrubGitRemoteCredentials(repo, "example/site");

    const projectGit = simpleGitForProject(repo);
    await projectGit.status();
    const remotes = await projectGit.getRemotes(true);
    const config = fs.readFileSync(path.join(repo, ".git", "config"), "utf8");

    expect(remotes).toEqual([
      {
        name: "origin",
        refs: {
          fetch: "https://github.com/example/site.git",
          push: "https://github.com/example/site.git",
        },
      },
    ]);
    expect(config).toContain("url = https://github.com/example/site.git");
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
