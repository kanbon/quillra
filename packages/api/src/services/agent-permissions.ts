/**
 * Role-based tool permissions for the Claude Agent SDK, factored out
 * of agent.ts so the per-role allowlist is the only thing in this file.
 * The SDK's `canUseTool` option calls the returned callback for every
 * tool use, we decide allow/deny based on (project role, migration
 * mode, tool name, tool input).
 *
 * Every SDK file tool is confined to the project root first. Migration mode
 * then short-circuits the role-specific rules because it has to delete old
 * lockfiles, rewrite package.json, and run arbitrary project commands.
 *
 * Roles (defined in db/app-schema.ts):
 *  - admin, full control inside the project workspace
 *  - editor, read the workspace; write non-src/config files; use the
 *              diagnostics MCP server; no general-purpose shell
 *  - client, non-technical end user: read the workspace; write only
 *              to content/ and assets/ with content/image extensions;
 *              no shell, no MCP tools
 *
 * Anything else is denied. That includes any tool the SDK adds in
 * future that we haven't explicitly thought about, fail closed.
 */
import fs from "node:fs";
import path from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRole } from "../db/app-schema.js";

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"]);
const EXECUTION_BASH_TOOL = "mcp__quillra-execution__bash";
const PROMOTE_ATTACHMENT_TOOL = "mcp__quillra-execution__promote_attachment";

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function requestedFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "NotebookEdit") {
    return String(input.notebook_path ?? input.file_path ?? input.path ?? "").trim() || null;
  }
  return String(input.file_path ?? input.path ?? "").trim() || null;
}

function hasEscapingGlobPattern(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== "Glob") return false;
  const pattern = String(input.pattern ?? "").replace(/\\/g, "/");
  return (
    pattern.includes("\0") ||
    pattern.includes("..") ||
    pattern.startsWith("~") ||
    pattern.startsWith("/") ||
    /^[A-Za-z]:\//.test(pattern)
  );
}

/**
 * Resolve a requested file path to its canonical workspace-relative target.
 * Walking each path component lets us reject both existing and dangling
 * symlinks that point outside the workspace. It also gives role checks the
 * resolved target, so `content/../package.json` and an in-workspace symlink to
 * `package.json` cannot masquerade as client-editable content.
 */
function canonicalWorkspacePath(workspaceRoot: string, requested: string): string | null {
  const rootAbsolute = path.resolve(workspaceRoot);
  const candidate = path.resolve(rootAbsolute, requested);
  if (!isInside(rootAbsolute, candidate)) return null;

  try {
    const rootReal = fs.realpathSync.native(rootAbsolute);
    const relative = path.relative(rootAbsolute, candidate);
    let current = rootReal;
    let pending = relative === "" ? [] : relative.split(path.sep);
    let followedSymlinks = 0;

    while (pending.length > 0) {
      const segment = pending.shift();
      if (!segment) continue;
      const next = path.resolve(current, segment);
      if (!isInside(rootReal, next)) return null;

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        const missingTarget = path.resolve(next, ...pending);
        if (!isInside(rootReal, missingTarget)) return null;
        return path.relative(rootReal, missingTarget).replace(/\\/g, "/");
      }

      if (!stat.isSymbolicLink()) {
        current = next;
        continue;
      }

      followedSymlinks += 1;
      if (followedSymlinks > 40) return null;
      const target = path.resolve(path.dirname(next), fs.readlinkSync(next));
      if (!isInside(rootReal, target)) return null;
      const targetRelative = path.relative(rootReal, target);
      pending = [...(targetRelative === "" ? [] : targetRelative.split(path.sep)), ...pending];
      current = rootReal;
    }

    return path.relative(rootReal, current).replace(/\\/g, "/");
  } catch {
    return null;
  }
}

function literalGlobPrefix(input: Record<string, unknown>): string | null {
  const pattern = String(input.pattern ?? "").replace(/\\/g, "/");
  const parts: string[] = [];
  for (const segment of pattern.split("/")) {
    if (!segment || /[*?[\]{}()!+@]/.test(segment)) break;
    parts.push(segment);
  }
  return parts.length > 0 ? parts.join(path.sep) : null;
}

function canonicalFileToolPath(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
): string | null | undefined {
  if (hasEscapingGlobPattern(toolName, input)) return undefined;

  const requested = requestedFilePath(toolName, input);
  if (requested) return canonicalWorkspacePath(workspaceRoot, requested) ?? undefined;
  if (toolName === "Glob") {
    const prefix = literalGlobPrefix(input);
    if (prefix && canonicalWorkspacePath(workspaceRoot, prefix) === null) return undefined;
    return null;
  }
  if (toolName === "Grep") return null;
  return undefined;
}

/** True for paths an editor role is not allowed to write. Keeps
 *  editors out of source + config, which is what separates them from
 *  the admin role. Matches `src/`, `*.config.*`, and `package.json`. */
function editorBlockedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.includes("/src/") ||
    normalized.startsWith("src/") ||
    /\.config\./.test(normalized) ||
    normalized.endsWith("package.json")
  );
}

/**
 * Git metadata is control-plane state, not project content. Letting an agent
 * edit `.git/config`, hooks, attributes, or refs would turn a later trusted
 * publish/fetch into a code-execution primitive inside the Quillra container.
 * This boundary applies even to admins and migration runs.
 */
function isGitMetadataPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return normalized === ".git" || normalized.startsWith(".git/");
}

export function buildCanUseTool(
  role: ProjectRole,
  opts: { workspaceRoot: string; migrationMode?: boolean },
) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    callOpts: {
      toolUseID: string;
      signal: AbortSignal;
    },
  ): Promise<PermissionResult> => {
    const id = callOpts.toolUseID;
    const canonicalFilePath = FILE_TOOLS.has(toolName)
      ? canonicalFileToolPath(toolName, input, opts.workspaceRoot)
      : null;

    if (FILE_TOOLS.has(toolName) && canonicalFilePath === undefined) {
      return {
        behavior: "deny",
        message: "File tools are limited to this project workspace.",
        toolUseID: id,
      };
    }

    if (
      FILE_TOOLS.has(toolName) &&
      typeof canonicalFilePath === "string" &&
      isGitMetadataPath(canonicalFilePath)
    ) {
      return {
        behavior: "deny",
        message: "Git metadata is managed by Quillra.",
        toolUseID: id,
      };
    }

    // Migration mode needs broad file writes and remote shell execution, but
    // still fails closed for every unknown/built-in tool. Bash is an alias for
    // the project-scoped E2B MCP tool, never the SDK's local shell.
    if (opts.migrationMode) {
      if (
        FILE_TOOLS.has(toolName) ||
        toolName === EXECUTION_BASH_TOOL ||
        toolName === PROMOTE_ATTACHMENT_TOOL ||
        toolName.startsWith("mcp__quillra-diagnostics__")
      ) {
        return { behavior: "allow", toolUseID: id };
      }
      return { behavior: "deny", message: "Tool not allowed for migration.", toolUseID: id };
    }

    if (role === "admin") {
      if (
        FILE_TOOLS.has(toolName) ||
        toolName === EXECUTION_BASH_TOOL ||
        toolName === PROMOTE_ATTACHMENT_TOOL ||
        toolName.startsWith("mcp__quillra-diagnostics__")
      ) {
        return { behavior: "allow", toolUseID: id };
      }
      return { behavior: "deny", message: "Tool not allowed for admins.", toolUseID: id };
    }

    if (role === "editor") {
      // In-process diagnostic MCP tools (read-only preview status +
      // restart). Editors are trusted enough to debug their own dev
      // server without jumping to admin.
      if (toolName.startsWith("mcp__quillra-diagnostics__")) {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === PROMOTE_ATTACHMENT_TOOL) {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
        const fp = canonicalFilePath ?? "";
        if (editorBlockedPath(fp)) {
          return { behavior: "deny", message: "Editors cannot change this path.", toolUseID: id };
        }
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Bash") {
        return { behavior: "deny", message: "Editors cannot run shell commands.", toolUseID: id };
      }
      return { behavior: "deny", message: "Tool not allowed for editors.", toolUseID: id };
    }

    if (role === "client") {
      // Clients are non-technical end users (the website owner). They get
      // the most restrictive sandbox: read anything, but only edit content
      // files (text/markdown/json) and image assets. No code, no config,
      // no shell, no git.
      if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === PROMOTE_ATTACHMENT_TOOL) {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
        const fp = canonicalFilePath ?? "";
        // Allow content paths and asset paths only
        const isContentPath =
          /(^|\/)(content|data|public|src\/content|src\/data|src\/assets|assets)\//i.test(fp);
        const isContentExt = /\.(md|markdown|mdx|txt|json|yaml|yml|html|htm)$/i.test(fp);
        const isImageExt = /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(fp);
        if ((isContentPath && (isContentExt || isImageExt)) || (isContentExt && isContentPath)) {
          return { behavior: "allow", toolUseID: id };
        }
        return {
          behavior: "deny",
          message:
            "Clients can only edit content files (text, images) inside content/ or assets/ directories.",
          toolUseID: id,
        };
      }
      if (toolName === "Bash") {
        return { behavior: "deny", message: "Clients cannot run shell commands.", toolUseID: id };
      }
      return { behavior: "deny", message: "Tool not allowed for clients.", toolUseID: id };
    }

    return { behavior: "deny", message: "Unknown role.", toolUseID: id };
  };
}

/**
 * The merge-conflict agent is narrower than every interactive role: it may
 * only read or rewrite the exact conflicted targets. Git staging happens in
 * trusted server code after the agent exits, so it never receives Bash.
 */
export function buildConflictResolverCanUseTool(workspaceRoot: string, conflictedFiles: string[]) {
  const allowedPaths = new Set(
    conflictedFiles
      .map((filePath) => {
        const canonical = canonicalWorkspacePath(workspaceRoot, filePath);
        const lexical = path
          .relative(path.resolve(workspaceRoot), path.resolve(workspaceRoot, filePath))
          .replace(/\\/g, "/");
        // File tools follow symlinks. A conflicted symlink must not turn an
        // otherwise exact allowlist entry into permission to edit its target.
        return canonical === lexical ? canonical : null;
      })
      .filter((filePath): filePath is string => filePath !== null),
  );

  return async (
    toolName: string,
    input: Record<string, unknown>,
    callOpts: { toolUseID: string; signal: AbortSignal },
  ): Promise<PermissionResult> => {
    const id = callOpts.toolUseID;
    if (toolName !== "Read" && toolName !== "Edit" && toolName !== "Write") {
      return {
        behavior: "deny",
        message: "The conflict resolver can only read or edit conflicted files.",
        toolUseID: id,
      };
    }

    const requested = requestedFilePath(toolName, input);
    const canonical = requested ? canonicalWorkspacePath(workspaceRoot, requested) : null;
    if (!canonical || !allowedPaths.has(canonical)) {
      return {
        behavior: "deny",
        message: "The conflict resolver can only touch the listed conflicted files.",
        toolUseID: id,
      };
    }
    return { behavior: "allow", toolUseID: id };
  };
}
