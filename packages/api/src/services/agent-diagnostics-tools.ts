/**
 * In-process MCP server exposed to the Claude Agent SDK so the agent
 * can see the same preview diagnostics the PreviewDebugModal shows in
 * the UI. Without these tools the agent is blind when something like
 * `npm install` is OOM-killed or `astro dev` exits with a render
 * error — it'd either claim success or try again without understanding
 * the cause. With them it can inspect `get_preview_status`, read the
 * recent stderr, and decide what to fix.
 *
 * Built per-run (see runProjectAgent) so each tool closes over the
 * project's id / repo path / dev command override without needing a
 * global registry.
 *
 * Only wired up for admin and editor roles. Clients never call these —
 * dev-server debugging isn't a client concern.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { detectFramework } from "./framework.js";
import { setPreviewStatus } from "./preview-status.js";
import { getPreviewStatus } from "./preview-status.js";
import {
  getPreviewLogs,
  getPreviewProcessInfo,
  getPreviewUrl,
  previewPortForProject,
  resolveDevCommand,
  startDevPreview,
  stopPreview,
} from "./workspace.js";

type Params = {
  projectId: string;
  repoPath: string;
  /** Mirrored from the projects.preview_dev_command column. */
  previewDevCommandOverride: string | null | undefined;
};

/** Small upstream-probe with a tight timeout so an unresponsive dev
 *  server doesn't block the tool call for the SDK's default 60s. */
async function probeUpstream(port: number): Promise<{
  ok: boolean;
  status?: number;
  contentType?: string;
  error?: string;
}> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1500),
      redirect: "manual",
    });
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type") ?? undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type StatusSnapshot = {
  stage: string;
  stageMessage: string | null;
  stageUpdatedAt: number;
  childProcess: {
    running: boolean;
    pid: number | null;
    exitCode: number | null;
    signalCode: string | null;
  };
  upstreamProbe: Awaited<ReturnType<typeof probeUpstream>>;
  port: number;
  previewUrl: string;
  framework: { id: string; label: string } | null;
  packageManager: "npm" | "yarn" | "pnpm";
  devCommand: { command: string; args: string[]; label: string } | null;
  /** Last 20 stderr lines — by far the most useful field for debugging. */
  recentErrors: string[];
  /** Last 10 stdout lines — sometimes the actual error is printed there
   *  (e.g. Astro writes "ERROR" to stdout, not stderr). */
  recentStdout: string[];
};

async function buildStatusSnapshot(params: Params): Promise<StatusSnapshot> {
  const port = previewPortForProject(params.projectId);
  const status = getPreviewStatus(params.projectId);
  const child = getPreviewProcessInfo(params.projectId);
  const probe = await probeUpstream(port);
  const fw = detectFramework(params.repoPath);
  const dev = resolveDevCommand(params.repoPath, port, params.previewDevCommandOverride) ?? null;
  const logs = getPreviewLogs(params.projectId);
  const recentErrors = logs
    .filter((l) => l.stream === "stderr")
    .slice(-20)
    .map((l) => l.line);
  const recentStdout = logs
    .filter((l) => l.stream === "stdout")
    .slice(-10)
    .map((l) => l.line);
  // Best-effort package manager detection mirroring the UI.
  const fs = await import("node:fs");
  const path = await import("node:path");
  let packageManager: "npm" | "yarn" | "pnpm" = "npm";
  if (fs.existsSync(path.join(params.repoPath, "yarn.lock"))) packageManager = "yarn";
  else if (fs.existsSync(path.join(params.repoPath, "pnpm-lock.yaml"))) packageManager = "pnpm";

  return {
    stage: status.stage,
    stageMessage: status.message ?? null,
    stageUpdatedAt: status.updatedAt,
    childProcess: child,
    upstreamProbe: probe,
    port,
    previewUrl: getPreviewUrl(params.projectId, port),
    framework: fw && fw.id !== "unknown" ? { id: fw.id, label: fw.label } : null,
    packageManager,
    devCommand: dev ? { command: dev.command, args: dev.args, label: dev.label } : null,
    recentErrors,
    recentStdout,
  };
}

export function buildAgentDiagnosticsMcpServer(params: Params) {
  return createSdkMcpServer({
    name: "quillra-diagnostics",
    version: "1.0.0",
    tools: [
      tool(
        "get_preview_status",
        [
          "Returns the live dev-server status for this project as JSON:",
          "stage (idle/starting/installing/ready/error), whether the child",
          "process is running, exit code if it died, a tight upstream HTTP",
          "probe, the detected framework, the resolved dev command, and",
          "the last 20 stderr + last 10 stdout log lines.",
          "",
          "Use this whenever the live preview doesn't look right —",
          "especially after you've made changes, run `npm install`, or the",
          "preview stays on its boot screen. The recent stderr field is",
          "usually enough to tell you what broke (missing dependency,",
          "port conflict, framework config error, OOM exit code).",
        ].join(" "),
        {},
        async () => {
          const snap = await buildStatusSnapshot(params);
          return {
            content: [{ type: "text", text: JSON.stringify(snap, null, 2) }],
          };
        },
      ),

      tool(
        "tail_preview_logs",
        [
          "Returns the last N lines from the dev server's stdout+stderr",
          "interleaved in the order they were emitted. Useful when",
          "get_preview_status's 20-line slice isn't enough context —",
          "for build tools that emit verbose progress before the real",
          "error.",
        ].join(" "),
        {
          lines: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("How many lines to return (default 80, max 500)."),
        },
        async (args) => {
          const n = args.lines ?? 80;
          const logs = getPreviewLogs(params.projectId);
          const tail = logs.slice(-n).map((l) => `[${l.stream}] ${l.line}`);
          return {
            content: [{ type: "text", text: tail.length ? tail.join("\n") : "(no log lines)" }],
          };
        },
      ),

      tool(
        "restart_preview",
        [
          "Stops and restarts the dev server for this project, then waits",
          "a couple of seconds and returns the new status. Use this after",
          "you've fixed the cause of a dev-server error — rather than",
          "waiting for the user to click the Restart button in the",
          "preview error overlay. Safe to call whether or not the",
          "preview is currently running.",
        ].join(" "),
        {},
        async () => {
          try {
            stopPreview(params.projectId);
            // Very short cooldown so the SIGTERM actually lands before the
            // next spawn; otherwise npm install can race with the new one
            // and both fight over node_modules.
            await new Promise((r) => setTimeout(r, 500));
            setPreviewStatus(params.projectId, "starting", "Restarted by agent");
            await startDevPreview(
              params.projectId,
              params.repoPath,
              params.previewDevCommandOverride ?? null,
            );
            // Let the child log for a moment before we read status so the
            // returned snapshot is more useful than an empty one.
            await new Promise((r) => setTimeout(r, 2000));
            const snap = await buildStatusSnapshot(params);
            return {
              content: [
                {
                  type: "text",
                  text: `Preview restarted.\n\n${JSON.stringify(snap, null, 2)}`,
                },
              ],
            };
          } catch (e) {
            return {
              content: [
                {
                  type: "text",
                  text: `Restart failed: ${e instanceof Error ? e.message : String(e)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
