import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dependencyInstallFingerprint } from "./dependency-fingerprint.js";

const temporaryDirectories: string[] = [];

function fixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quillra-dependency-fingerprint-"));
  temporaryDirectories.push(directory);
  fs.writeFileSync(path.join(directory, "package.json"), '{"name":"fixture"}');
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("dependencyInstallFingerprint", () => {
  it("stays stable across source-only edits", () => {
    const repo = fixture();
    const manager = { name: "pnpm" as const, version: null };
    const before = dependencyInstallFingerprint(repo, manager);

    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const value = 1;");

    expect(dependencyInstallFingerprint(repo, manager)).toBe(before);
    expect(before).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  it("changes for manifests, lockfiles, and nested workspaces", () => {
    const repo = fixture();
    const manager = { name: "pnpm" as const, version: null };
    const initial = dependencyInstallFingerprint(repo, manager);

    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    const withLock = dependencyInstallFingerprint(repo, manager);
    expect(withLock).not.toBe(initial);

    fs.mkdirSync(path.join(repo, "packages", "web"), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages", "web", "package.json"), '{"name":"web"}');
    expect(dependencyInstallFingerprint(repo, manager)).not.toBe(withLock);
  });

  it("changes when the selected package manager changes", () => {
    const repo = fixture();

    expect(dependencyInstallFingerprint(repo, { name: "pnpm", version: null })).not.toBe(
      dependencyInstallFingerprint(repo, { name: "npm", version: null }),
    );
  });

  it("does not trust dependency metadata hidden behind a symbolic link", () => {
    const repo = fixture();
    const external = path.join(repo, "external-package.json");
    fs.writeFileSync(external, '{"name":"external"}');
    fs.mkdirSync(path.join(repo, "packages"));
    fs.symlinkSync(external, path.join(repo, "packages", "package.json"));

    expect(() => dependencyInstallFingerprint(repo, { name: "pnpm", version: null })).toThrow(
      "Dependency metadata cannot be a symbolic link",
    );
  });

  it("does not cache Yarn installs because PnP, plugins, and releases live outside node_modules", () => {
    const repo = fixture();
    fs.writeFileSync(path.join(repo, "yarn.lock"), "");

    expect(dependencyInstallFingerprint(repo, { name: "yarn", version: "4.9.2" })).toBeUndefined();
  });

  it("does not cache pnpm PnP installs", () => {
    const repo = fixture();
    fs.writeFileSync(path.join(repo, ".npmrc"), "node-linker=pnp\n");

    expect(dependencyInstallFingerprint(repo, { name: "pnpm", version: null })).toBeUndefined();
  });

  it.each([
    {
      label: "file dependency",
      manifest: '{"dependencies":{"local-package":"file:../local-package"}}',
    },
    {
      label: "patch",
      manifest: '{"pnpm":{"patchedDependencies":{"dependency@1.0.0":"patches/dependency.patch"}}}',
    },
    {
      label: "install lifecycle script",
      manifest: '{"scripts":{"postinstall":"node scripts/generate-dependencies.mjs"}}',
    },
  ])("does not cache metadata that relies on an external $label artifact", ({ manifest }) => {
    const repo = fixture();
    fs.writeFileSync(path.join(repo, "package.json"), manifest);

    expect(dependencyInstallFingerprint(repo, { name: "pnpm", version: null })).toBeUndefined();
  });

  it.each(["patches", ".patches", ".yarn", ".pnpmfile.cjs"])(
    "does not cache when the project contains the %s install artifact",
    (artifactPath) => {
      const repo = fixture();
      if (path.extname(artifactPath)) {
        fs.writeFileSync(path.join(repo, artifactPath), "module.exports = {};");
      } else {
        fs.mkdirSync(path.join(repo, artifactPath));
      }

      expect(dependencyInstallFingerprint(repo, { name: "npm", version: null })).toBeUndefined();
    },
  );

  it("keeps ordinary npm and pnpm projects cacheable", () => {
    const repo = fixture();
    fs.writeFileSync(path.join(repo, "package-lock.json"), '{"lockfileVersion":3}');

    expect(dependencyInstallFingerprint(repo, { name: "npm", version: null })).toMatch(
      /^v2:[0-9a-f]{64}$/,
    );
    expect(dependencyInstallFingerprint(repo, { name: "pnpm", version: null })).toMatch(
      /^v2:[0-9a-f]{64}$/,
    );
  });
});
