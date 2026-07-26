import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectRole } from "../db/app-schema.js";
import { promoteAgentAttachment } from "./agent-execution-tools.js";

let testRoot: string;
let repoRoot: string;
let outsideRoot: string;

function params(role: ProjectRole) {
  return {
    projectId: "project-1",
    githubBindingGeneration: 1,
    repoPath: repoRoot,
    role,
    migrationMode: false,
    signal: new AbortController().signal,
  };
}

function writeScratchFile(name: string, contents: Buffer | string): string {
  const relativePath = `.quillra-temp/${name}`;
  fs.mkdirSync(path.dirname(path.join(repoRoot, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, relativePath), contents);
  return relativePath;
}

beforeEach(() => {
  testRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "quillra-promote-")));
  repoRoot = path.join(testRoot, "repo");
  outsideRoot = path.join(testRoot, "outside");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  fs.mkdirSync(outsideRoot);
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("promoteAgentAttachment", () => {
  it("preserves binary bytes and removes the admin's scratch copy", async () => {
    const contents = Buffer.from([0, 255, 1, 254, 10, 128]);
    const source = writeScratchFile("upload.bin", contents);

    await promoteAgentAttachment(params("admin"), source, "public/assets/upload.bin");

    expect(fs.readFileSync(path.join(repoRoot, "public/assets/upload.bin"))).toEqual(contents);
    expect(fs.existsSync(path.join(repoRoot, source))).toBe(false);
  });

  it.each(["content/uploads/hero.png", "assets/hero.png"])(
    "lets a client promote an image to %s",
    async (destination) => {
      const source = writeScratchFile(`upload-${path.basename(destination)}`, "image");

      await promoteAgentAttachment(params("client"), source, destination);

      expect(fs.readFileSync(path.join(repoRoot, destination), "utf8")).toBe("image");
      expect(fs.existsSync(path.join(repoRoot, source))).toBe(false);
    },
  );

  it.each(["src/index.ts", "package.json", "assets/payload.js"])(
    "rejects the client destination %s and keeps the scratch copy",
    async (destination) => {
      const source = writeScratchFile(`blocked-${path.basename(destination)}`, "safe");

      await expect(promoteAgentAttachment(params("client"), source, destination)).rejects.toThrow(
        /only edit content files/i,
      );

      expect(fs.readFileSync(path.join(repoRoot, source), "utf8")).toBe("safe");
      expect(fs.existsSync(path.join(repoRoot, destination))).toBe(false);
    },
  );

  it("rejects destination traversal without touching an outside file", async () => {
    const source = writeScratchFile("traversal.bin", "inside");
    const outsideFile = path.join(outsideRoot, "keep.bin");
    fs.writeFileSync(outsideFile, "outside");

    await expect(
      promoteAgentAttachment(params("admin"), source, "../outside/keep.bin"),
    ).rejects.toThrow(/project-relative path|project workspace/i);

    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside");
    expect(fs.readFileSync(path.join(repoRoot, source), "utf8")).toBe("inside");
  });

  it("rejects a source outside the attachment scratch directory", async () => {
    fs.mkdirSync(path.join(repoRoot, "content"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "content/source.png"), "content");

    await expect(
      promoteAgentAttachment(params("admin"), "content/source.png", "assets/source.png"),
    ).rejects.toThrow(/attachment scratch directory/i);

    expect(fs.readFileSync(path.join(repoRoot, "content/source.png"), "utf8")).toBe("content");
    expect(fs.existsSync(path.join(repoRoot, "assets/source.png"))).toBe(false);
  });

  it("rejects a dot-segment escape from the scratch directory", async () => {
    fs.writeFileSync(path.join(repoRoot, "outside-scratch.png"), "not an attachment");
    fs.mkdirSync(path.join(repoRoot, ".quillra-temp"), { recursive: true });

    await expect(
      promoteAgentAttachment(
        params("admin"),
        ".quillra-temp/../outside-scratch.png",
        "assets/copied.png",
      ),
    ).rejects.toThrow(/attachment scratch directory/i);

    expect(fs.readFileSync(path.join(repoRoot, "outside-scratch.png"), "utf8")).toBe(
      "not an attachment",
    );
    expect(fs.existsSync(path.join(repoRoot, "assets/copied.png"))).toBe(false);
  });

  it.each(["/etc/passwd", "C:\\Windows\\system.ini", "../outside/secret.png"])(
    "rejects the non-relative source path %s",
    async (source) => {
      await expect(
        promoteAgentAttachment(params("admin"), source, "assets/copied.png"),
      ).rejects.toThrow(/project-relative path|attachment scratch directory/i);

      expect(fs.existsSync(path.join(repoRoot, "assets/copied.png"))).toBe(false);
    },
  );

  it("rejects Git metadata destinations and keeps the attachment", async () => {
    const source = writeScratchFile("git-target.bin", "attachment");

    await expect(
      promoteAgentAttachment(params("admin"), source, "assets/../.git/objects/payload"),
    ).rejects.toThrow(/Git metadata/i);

    expect(fs.readFileSync(path.join(repoRoot, source), "utf8")).toBe("attachment");
    expect(fs.existsSync(path.join(repoRoot, ".git/objects/payload"))).toBe(false);
  });

  it("normalizes a destination before rejecting the scratch directory", async () => {
    const source = writeScratchFile("scratch-target.bin", "attachment");

    await expect(
      promoteAgentAttachment(params("admin"), source, "assets/../.quillra-temp/reintroduced.bin"),
    ).rejects.toThrow(/permanent content or asset destination/i);

    expect(fs.readFileSync(path.join(repoRoot, source), "utf8")).toBe("attachment");
    expect(fs.existsSync(path.join(repoRoot, ".quillra-temp/reintroduced.bin"))).toBe(false);
  });

  it("rejects a scratch-file symlink to an outside source", async () => {
    fs.mkdirSync(path.join(repoRoot, ".quillra-temp"), { recursive: true });
    const outsideFile = path.join(outsideRoot, "secret.png");
    fs.writeFileSync(outsideFile, "outside");
    fs.symlinkSync(outsideFile, path.join(repoRoot, ".quillra-temp/upload.png"));

    await expect(
      promoteAgentAttachment(params("admin"), ".quillra-temp/upload.png", "assets/upload.png"),
    ).rejects.toThrow(/outside the project workspace/i);

    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside");
    expect(fs.existsSync(path.join(repoRoot, "assets/upload.png"))).toBe(false);
  });

  it("rejects a destination parent symlink to an outside directory", async () => {
    const source = writeScratchFile("parent-escape.png", "inside");
    fs.symlinkSync(outsideRoot, path.join(repoRoot, "assets"));

    await expect(
      promoteAgentAttachment(params("admin"), source, "assets/escaped.png"),
    ).rejects.toThrow();

    expect(fs.existsSync(path.join(outsideRoot, "escaped.png"))).toBe(false);
    expect(fs.readFileSync(path.join(repoRoot, source), "utf8")).toBe("inside");
  });
});
