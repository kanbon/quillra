import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProjectFilePathError,
  deleteProjectFile,
  ensureProjectDirectory,
  ensureProjectGitExclude,
  readProjectFile,
  writeProjectFile,
} from "./project-files.js";

let testRoot: string;
let repoRoot: string;
let outsideRoot: string;

function expectPathError(operation: () => unknown, code: "INVALID_PATH" | "NOT_FOUND") {
  try {
    operation();
    throw new Error("Expected project path operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectFilePathError);
    expect((error as ProjectFilePathError).code).toBe(code);
  }
}

beforeEach(() => {
  testRoot = fs.realpathSync.native(mkdtempSync(path.join(tmpdir(), "quillra-project-files-")));
  repoRoot = path.join(testRoot, "repo");
  outsideRoot = path.join(testRoot, "outside");
  fs.mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true });
  fs.mkdirSync(outsideRoot);
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("project file path confinement", () => {
  it("reads regular files and in-project symlinks through a verified descriptor", () => {
    fs.mkdirSync(path.join(repoRoot, "public"));
    fs.writeFileSync(path.join(repoRoot, "public", "asset.txt"), "project asset");
    fs.symlinkSync("asset.txt", path.join(repoRoot, "public", "alias.txt"));

    expect(readProjectFile(repoRoot, "public/asset.txt").toString()).toBe("project asset");
    expect(readProjectFile(repoRoot, "public/alias.txt").toString()).toBe("project asset");
  });

  it("rejects traversal and existing symlinks whose targets are outside the project", () => {
    const secret = path.join(outsideRoot, "secret.txt");
    fs.writeFileSync(secret, "outside secret");
    fs.symlinkSync(secret, path.join(repoRoot, "leak.txt"));
    fs.mkdirSync(path.join(repoRoot, "nested"));
    fs.symlinkSync(outsideRoot, path.join(repoRoot, "nested", "escape"));

    expectPathError(() => readProjectFile(repoRoot, "../outside/secret.txt"), "INVALID_PATH");
    expectPathError(() => readProjectFile(repoRoot, "leak.txt"), "INVALID_PATH");
    expectPathError(() => readProjectFile(repoRoot, "nested/escape/secret.txt"), "INVALID_PATH");
  });

  it("rejects writes through symlinked parents and final symlinks", () => {
    const outsideFile = path.join(outsideRoot, "upload.md");
    fs.writeFileSync(outsideFile, "unchanged");
    fs.symlinkSync(outsideRoot, path.join(repoRoot, ".quillra-temp"));

    expectPathError(
      () => writeProjectFile(repoRoot, ".quillra-temp/upload.md", "malicious write"),
      "INVALID_PATH",
    );
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("unchanged");

    fs.unlinkSync(path.join(repoRoot, ".quillra-temp"));
    ensureProjectDirectory(repoRoot, ".quillra-temp");
    fs.symlinkSync(outsideFile, path.join(repoRoot, ".quillra-temp", "upload.md"));
    expectPathError(
      () => writeProjectFile(repoRoot, ".quillra-temp/upload.md", "malicious write"),
      "INVALID_PATH",
    );
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("unchanged");
  });

  it("rejects deletes through a symlinked parent", () => {
    const outsideFile = path.join(outsideRoot, "keep.txt");
    fs.writeFileSync(outsideFile, "keep");
    fs.symlinkSync(outsideRoot, path.join(repoRoot, "public"));

    expectPathError(() => deleteProjectFile(repoRoot, "public/keep.txt"), "INVALID_PATH");
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep");
  });

  it("rejects a final symlink without touching its outside target", () => {
    const outsideFile = path.join(outsideRoot, "keep.txt");
    const link = path.join(repoRoot, "outside-link.txt");
    fs.writeFileSync(outsideFile, "keep");
    fs.symlinkSync(outsideFile, link);

    expectPathError(() => deleteProjectFile(repoRoot, "outside-link.txt"), "INVALID_PATH");
    expect(fs.existsSync(link)).toBe(true);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep");
  });

  it("rejects a repository root replaced with a symlink", () => {
    const originalRepo = path.join(testRoot, "original-repo");
    fs.renameSync(repoRoot, originalRepo);
    fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "outside secret");
    fs.symlinkSync(outsideRoot, repoRoot);

    expectPathError(() => readProjectFile(repoRoot, "secret.txt"), "INVALID_PATH");
    expectPathError(() => writeProjectFile(repoRoot, "created.txt", "no"), "INVALID_PATH");
    expectPathError(() => deleteProjectFile(repoRoot, "secret.txt"), "INVALID_PATH");
    expect(fs.readFileSync(path.join(outsideRoot, "secret.txt"), "utf8")).toBe("outside secret");
    expect(fs.existsSync(path.join(outsideRoot, "created.txt"))).toBe(false);
  });

  it("never appends the scratch ignore rule through a symlink", () => {
    const outsideFile = path.join(outsideRoot, "exclude");
    fs.writeFileSync(outsideFile, "outside\n");
    fs.symlinkSync(outsideFile, path.join(repoRoot, ".git", "info", "exclude"));

    expectPathError(() => ensureProjectGitExclude(repoRoot, ".quillra-temp"), "INVALID_PATH");
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside\n");
  });

  it("creates an idempotent local git-exclude rule without committed changes", () => {
    ensureProjectGitExclude(repoRoot, ".quillra-temp");
    ensureProjectGitExclude(repoRoot, ".quillra-temp");

    const exclude = fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/^\.quillra-temp\/$/gm)).toHaveLength(1);
  });
});
