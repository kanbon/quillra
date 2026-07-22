import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCanUseTool, buildConflictResolverCanUseTool } from "./agent-permissions.js";

const tempDirectories: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quillra-permissions-"));
  tempDirectories.push(root);
  fs.mkdirSync(path.join(root, "content"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "content", "page.md"), "hello");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};");
  return root;
}

async function check(
  role: "admin" | "editor" | "client",
  workspaceRoot: string,
  toolName: string,
  input: Record<string, unknown>,
  migrationMode = false,
) {
  return buildCanUseTool(role, { workspaceRoot, migrationMode })(toolName, input, {
    toolUseID: "tool-1",
    signal: new AbortController().signal,
  });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("buildCanUseTool workspace boundary", () => {
  it("allows in-workspace reads and client content edits", async () => {
    const root = makeWorkspace();

    await expect(
      check("admin", root, "Read", { file_path: "content/page.md" }),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      check("client", root, "Edit", { file_path: path.join(root, "content", "page.md") }),
    ).resolves.toMatchObject({ behavior: "allow" });
  });

  it.each(["admin", "editor", "client"] as const)(
    "denies traversal for the %s role",
    async (role) => {
      const root = makeWorkspace();
      await expect(
        check(role, root, "Read", { file_path: "../../etc/passwd" }),
      ).resolves.toMatchObject({ behavior: "deny" });
    },
  );

  it("keeps the workspace boundary in migration mode", async () => {
    const root = makeWorkspace();

    await expect(
      check(
        "admin",
        root,
        "Write",
        { file_path: path.join(path.dirname(root), "outside.txt") },
        true,
      ),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("applies editor path rules to notebook paths", async () => {
    const root = makeWorkspace();
    fs.writeFileSync(path.join(root, "src", "analysis.ipynb"), "{}");

    await expect(
      check("editor", root, "NotebookEdit", { notebook_path: "src/analysis.ipynb" }),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("denies reads through a symlink that points outside the workspace", async () => {
    const root = makeWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "quillra-outside-"));
    tempDirectories.push(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(root, "linked"));

    await expect(
      check("admin", root, "Read", { file_path: "linked/secret.txt" }),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("classifies client writes by their canonical target", async () => {
    const root = makeWorkspace();
    fs.symlinkSync("../package.json", path.join(root, "content", "package-alias.json"));

    await expect(
      check("client", root, "Edit", { file_path: "content/../package.json" }),
    ).resolves.toMatchObject({ behavior: "deny" });
    await expect(
      check("client", root, "Edit", { file_path: "content/package-alias.json" }),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("does not let an editor disguise a source target behind a symlink", async () => {
    const root = makeWorkspace();
    fs.symlinkSync("../src/index.ts", path.join(root, "docs", "notes.txt"));

    await expect(
      check("editor", root, "Edit", { file_path: "docs/notes.txt" }),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("rejects dangling symlinks that point outside the workspace", async () => {
    const root = makeWorkspace();
    const outsideTarget = path.join(path.dirname(root), "not-created", "secret.md");
    fs.symlinkSync(outsideTarget, path.join(root, "content", "dangling.md"));

    await expect(
      check("client", root, "Write", { file_path: "content/dangling.md" }),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("removes general-purpose shell access from editors", async () => {
    const root = makeWorkspace();
    for (const command of [
      "npm --version; cat /etc/passwd",
      'node -e "console.log(process.env.ANTHROPIC_API_KEY)"',
      "git -c alias.escape='!sh' escape",
    ]) {
      await expect(check("editor", root, "Bash", { command })).resolves.toMatchObject({
        behavior: "deny",
      });
    }

    await expect(
      check("admin", root, "Bash", { command: "node --version" }),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      check("editor", root, "Bash", { command: "node --version" }, true),
    ).resolves.toMatchObject({ behavior: "allow" });
  });

  it("allows pathless searches but denies escaping glob patterns", async () => {
    const root = makeWorkspace();

    await expect(check("client", root, "Grep", { pattern: "hello" })).resolves.toMatchObject({
      behavior: "allow",
    });
    await expect(check("admin", root, "Glob", { pattern: "../../**/*" })).resolves.toMatchObject({
      behavior: "deny",
    });
  });
});

describe("buildConflictResolverCanUseTool", () => {
  it("allows only exact conflicted files through Read, Edit, and Write", async () => {
    const root = makeWorkspace();
    const canUseTool = buildConflictResolverCanUseTool(root, ["src/index.ts"]);
    const call = (toolName: string, input: Record<string, unknown>) =>
      canUseTool(toolName, input, {
        toolUseID: "conflict-tool",
        signal: new AbortController().signal,
      });

    await expect(call("Read", { file_path: "src/index.ts" })).resolves.toMatchObject({
      behavior: "allow",
    });
    await expect(
      call("Edit", { file_path: path.join(root, "src", "index.ts") }),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(call("Write", { file_path: "package.json" })).resolves.toMatchObject({
      behavior: "deny",
    });
    await expect(call("Bash", { command: "git add src/index.ts" })).resolves.toMatchObject({
      behavior: "deny",
    });
    await expect(call("Glob", { pattern: "**/*" })).resolves.toMatchObject({
      behavior: "deny",
    });
  });

  it("rejects path aliases to files outside the exact conflict set", async () => {
    const root = makeWorkspace();
    fs.symlinkSync("../package.json", path.join(root, "src", "alias.ts"));
    const canUseTool = buildConflictResolverCanUseTool(root, ["src/index.ts"]);

    await expect(
      canUseTool(
        "Edit",
        { file_path: "src/alias.ts" },
        {
          toolUseID: "conflict-tool",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("does not treat a conflicted symlink as permission to edit its target", async () => {
    const root = makeWorkspace();
    fs.symlinkSync("../package.json", path.join(root, "src", "alias.ts"));
    const canUseTool = buildConflictResolverCanUseTool(root, ["src/alias.ts"]);

    await expect(
      canUseTool(
        "Edit",
        { file_path: "src/alias.ts" },
        {
          toolUseID: "conflict-tool",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny" });
  });
});
