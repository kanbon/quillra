import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PROJECT_PACKAGE_JSON_BYTES, readProjectPackageJson } from "./project-manifest.js";

const temporaryPaths: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(() => {
  for (const target of temporaryPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("readProjectPackageJson", () => {
  it("reads a regular manifest", () => {
    const repo = temporaryDirectory("quillra-manifest-");
    fs.writeFileSync(path.join(repo, "package.json"), '{"packageManager":"pnpm@10.34.0"}');

    expect(readProjectPackageJson(repo)?.packageManager).toBe("pnpm@10.34.0");
  });

  it("refuses a symlink without reading its target", () => {
    const repo = temporaryDirectory("quillra-manifest-repo-");
    const outside = temporaryDirectory("quillra-manifest-outside-");
    fs.writeFileSync(
      path.join(outside, "secret.json"),
      '{"packageManager":"pnpm@10.34.0","secret":"host-only"}',
    );
    fs.symlinkSync(path.join(outside, "secret.json"), path.join(repo, "package.json"));

    expect(readProjectPackageJson(repo)).toBeNull();
  });

  it("rejects a manifest larger than one MiB", () => {
    const repo = temporaryDirectory("quillra-manifest-large-");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      `{"padding":"${"x".repeat(MAX_PROJECT_PACKAGE_JSON_BYTES)}"}`,
    );

    expect(() => readProjectPackageJson(repo)).toThrow("1 MiB inspection limit");
  });

  it("treats malformed JSON as an unavailable manifest", () => {
    const repo = temporaryDirectory("quillra-manifest-invalid-");
    fs.writeFileSync(path.join(repo, "package.json"), "{not-json");

    expect(readProjectPackageJson(repo)).toBeNull();
  });
});
