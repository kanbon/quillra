/**
 * Role-based tool permissions for the Claude Agent SDK, factored out
 * of agent.ts so the per-role allowlist is the only thing in this file.
 * The SDK's `canUseTool` option calls the returned callback for every
 * tool use, we decide allow/deny based on (project role, migration
 * mode, tool name, tool input).
 *
 * Migration mode short-circuits to "allow everything" because the
 * migration agent has to delete old lockfiles, rewrite package.json,
 * and run arbitrary shell commands; the user is locked out of the
 * composer while it runs so there's no interactive risk.
 *
 * Roles (defined in db/app-schema.ts):
 *  - admin, full control of the project workspace
 *  - editor, read everything; write non-src/config files; run
 *              git/npm/yarn/pnpm/npx/node (no `git push`); full access
 *              to the diagnostics MCP server
 *  - client, non-technical end user: read everything; write only
 *              to content/ and assets/ with content/image extensions;
 *              no shell, no MCP tools
 *
 * Anything else is denied. That includes any tool the SDK adds in
 * future that we haven't explicitly thought about, fail closed.
 */
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRole } from "../db/app-schema.js";

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

export function buildCanUseTool(role: ProjectRole, opts?: { migrationMode?: boolean }) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    callOpts: {
      toolUseID: string;
      signal: AbortSignal;
    },
  ): Promise<PermissionResult> => {
    const id = callOpts.toolUseID;

    // Migration mode: bypass every role's guardrails. The migration
    // agent has to delete old build configs, remove lockfiles, blow
    // away source trees, rewrite package.json, and run arbitrary
    // commands. The user is locked out of the composer while this
    // runs (isMigratingToAstro flag in the Editor), so there's no
    // risk of an interactive user fighting with the agent for
    // control. The project-level authorization to kick this off
    // happened at project creation; once migration_target is set
    // on the row, the agent gets free rein until it clears the flag.
    if (opts?.migrationMode) {
      return { behavior: "allow", toolUseID: id };
    }

    if (role === "admin") {
      // Admins have full control of their own project workspace, every
      // tool, every command, no paternalistic blocks. The workspace is
      // isolated (per-project clone on disk, git-backed so nothing is
      // truly unrecoverable) and the admin asked for Claude Code to
      // run. Recovering from a broken install often means
      // `rm -rf node_modules` and we shouldn't be the thing standing in
      // the way.
      return { behavior: "allow", toolUseID: id };
    }

    if (role === "editor") {
      // In-process diagnostic MCP tools (read-only preview status +
      // restart). Editors are trusted enough to debug their own dev
      // server without jumping to admin.
      if (toolName.startsWith("mcp__quillra-diagnostics__")) {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
        const fp = String(
          (input as { file_path?: string }).file_path ?? (input as { path?: string }).path ?? "",
        );
        if (editorBlockedPath(fp)) {
          return { behavior: "deny", message: "Editors cannot change this path.", toolUseID: id };
        }
        return { behavior: "allow", toolUseID: id };
      }
      if (toolName === "Bash") {
        const cmd = String((input as { command?: string }).command ?? "").trim();
        if (!/^(git|npm|yarn|pnpm|npx|node)\s/i.test(cmd)) {
          return { behavior: "deny", message: "Command not allowed for editors.", toolUseID: id };
        }
        if (/\bgit\s+push\b/i.test(cmd)) {
          return { behavior: "deny", message: "git push requires confirmation.", toolUseID: id };
        }
        return { behavior: "allow", toolUseID: id };
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
      if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
        const fp = String(
          (input as { file_path?: string }).file_path ?? (input as { path?: string }).path ?? "",
        ).replace(/\\/g, "/");
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
