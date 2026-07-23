import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ProjectRole } from "../db/app-schema.js";
import {
  deleteProjectFile,
  ensureProjectDirectory,
  readProjectFile,
  writeProjectFile,
} from "../lib/project-files.js";
import { buildCanUseTool } from "./agent-permissions.js";
import { getDefaultE2BRuntime } from "./e2b-runtime.js";
import { QUILLRA_TEMP_DIR } from "./workspace.js";

const BASH_TOOL_NAME = "mcp__quillra-execution__bash";
const PROMOTE_TOOL_NAME = "mcp__quillra-execution__promote_attachment";

type AgentExecutionParams = {
  projectId: string;
  githubBindingGeneration: number;
  repoPath: string;
  role: ProjectRole;
  migrationMode: boolean;
  signal: AbortSignal;
};

function normalizedRelativePath(value: string): string {
  const slashNormalized = value.trim().replace(/\\/g, "/");
  if (
    !slashNormalized ||
    slashNormalized.includes("\0") ||
    slashNormalized.startsWith("/") ||
    path.win32.isAbsolute(slashNormalized)
  ) {
    throw new Error("A project-relative path is required.");
  }
  const normalized = path.posix.normalize(slashNormalized);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("A project-relative path is required.");
  }
  return normalized;
}

function isScratchAttachment(relativePath: string): boolean {
  return relativePath.startsWith(`${QUILLRA_TEMP_DIR}/`) && relativePath !== QUILLRA_TEMP_DIR;
}

async function assertDestinationAllowed(
  params: AgentExecutionParams,
  destinationPath: string,
): Promise<void> {
  if (destinationPath === QUILLRA_TEMP_DIR || destinationPath.startsWith(`${QUILLRA_TEMP_DIR}/`)) {
    throw new Error("Choose a permanent content or asset destination.");
  }
  const permission = await buildCanUseTool(params.role, {
    workspaceRoot: params.repoPath,
    migrationMode: params.migrationMode,
  })(
    "Write",
    { file_path: destinationPath },
    {
      toolUseID: "quillra-promote-attachment",
      signal: params.signal,
    },
  );
  if (permission.behavior !== "allow") {
    throw new Error(permission.message || "This destination is not allowed for your project role.");
  }
}

/**
 * Promote a previously validated upload without invoking a shell. The hardened
 * project-file helpers reject symlink escapes, special files, and path races.
 */
export async function promoteAgentAttachment(
  params: AgentExecutionParams,
  source: string,
  destination: string,
): Promise<void> {
  const sourcePath = normalizedRelativePath(source);
  const destinationPath = normalizedRelativePath(destination);
  if (!isScratchAttachment(sourcePath)) {
    throw new Error("Only files from Quillra's attachment scratch directory can be promoted.");
  }
  await assertDestinationAllowed(params, destinationPath);

  const contents = readProjectFile(params.repoPath, sourcePath);
  const parent = path.posix.dirname(destinationPath);
  if (parent !== ".") ensureProjectDirectory(params.repoPath, parent);
  writeProjectFile(params.repoPath, destinationPath, contents);
  if (!deleteProjectFile(params.repoPath, sourcePath)) {
    throw new Error("The attachment disappeared before it could be promoted.");
  }
}

function commandResultText(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): string {
  const chunks: string[] = [];
  if (result.stdout) chunks.push(result.stdout.replace(/\s+$/, ""));
  if (result.stderr) chunks.push(result.stderr.replace(/\s+$/, ""));
  if (result.exitCode !== 0) chunks.push(`Command exited with code ${result.exitCode}.`);
  return chunks.join("\n") || "Command completed successfully.";
}

export function buildAgentExecutionMcpServer(params: AgentExecutionParams) {
  const promoteAttachmentTool = tool(
    "promote_attachment",
    [
      "Copies an uploaded file from .quillra-temp into a permanent project",
      "content or asset path, then removes the scratch copy. Use this for",
      "images, PDFs, and other binary attachments instead of Bash mv.",
    ].join(" "),
    {
      source: z.string().min(1).describe("Project-relative .quillra-temp source path."),
      destination: z.string().min(1).describe("Project-relative permanent destination path."),
    },
    async ({ source, destination }) => {
      try {
        await promoteAgentAttachment(params, source, destination);
        return {
          content: [{ type: "text", text: "Attachment promoted into the project." }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Attachment promotion failed.",
            },
          ],
          isError: true,
        };
      }
    },
  );
  const bashTool = tool(
    "bash",
    [
      "Runs a shell command inside this project's isolated E2B sandbox.",
      "The sandbox receives project files but no Quillra, GitHub, Anthropic,",
      "database, mail, encryption, or E2B credentials. Changes to normal",
      "project files are synchronized back after the command completes.",
    ].join(" "),
    {
      command: z.string().min(1).describe("Shell command to run in the project workspace."),
      timeout: z
        .number()
        .int()
        .min(1_000)
        .max(30 * 60_000)
        .optional()
        .describe("Optional timeout in milliseconds."),
      run_in_background: z.boolean().optional().describe("Background execution is not supported."),
    },
    async ({ command, timeout, run_in_background: runInBackground }) => {
      if (runInBackground) {
        return {
          content: [
            {
              type: "text",
              text: "Background commands are not supported. Run the command in the foreground.",
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await getDefaultE2BRuntime().runCommand(
          {
            projectId: params.projectId,
            githubBindingGeneration: params.githubBindingGeneration,
          },
          {
            localRoot: params.repoPath,
            command,
            timeoutMs: timeout,
            signal: params.signal,
          },
        );
        return {
          content: [{ type: "text", text: commandResultText(result) }],
          isError: result.exitCode !== 0,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Secure command execution failed.",
            },
          ],
          isError: true,
        };
      }
    },
  );
  const tools =
    params.role === "admin" || params.migrationMode
      ? [bashTool, promoteAttachmentTool]
      : [promoteAttachmentTool];

  return createSdkMcpServer({
    name: "quillra-execution",
    version: "1.0.0",
    tools,
  });
}

export const AGENT_BASH_TOOL_ALIAS = BASH_TOOL_NAME;
export const AGENT_PROMOTE_ATTACHMENT_TOOL = PROMOTE_TOOL_NAME;
