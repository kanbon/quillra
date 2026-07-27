import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectFramework } from "./framework.js";

describe("detectFramework", () => {
  it("does not follow a repository-controlled package.json symlink", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "quillra-framework-repo-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "quillra-framework-outside-"));
    try {
      fs.writeFileSync(
        path.join(outside, "package.json"),
        JSON.stringify({ devDependencies: { vite: "^7.0.0" } }),
      );
      fs.symlinkSync(path.join(outside, "package.json"), path.join(repo, "package.json"));

      expect(detectFramework(repo).id).toBe("unknown");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
