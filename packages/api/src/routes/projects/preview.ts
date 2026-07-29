import fs from "node:fs";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import { detectFramework } from "../../services/framework.js";
import {
  deactivatePreviewPort,
  getPreviewStatus,
  isPreviewRoutable,
  setPreviewStatus,
} from "../../services/preview-status.js";
import { previewUpstreamUrl, unregisterPreviewUpstream } from "../../services/preview-upstream.js";
import { readProjectPackageJson } from "../../services/project-manifest.js";
import {
  ensureRepoCloned,
  getPackageManager,
  getPreviewAddress,
  getPreviewLogs,
  getPreviewProcessInfo,
  projectRepoPath,
  reinstallProjectDependencies,
  reserveAvailablePreviewPort,
  resolveDevCommand,
  runInProjectLock,
  simpleGitForProject,
  startDevPreview,
} from "../../services/workspace.js";
import { type Variables, memberForProject, requireUser } from "./shared.js";

type PreviewStartResult = { port: number; label: string };
const previewStartRequests = new Map<string, Promise<PreviewStartResult>>();
const previewRefreshRequests = new Map<string, Promise<PreviewStartResult>>();

function coalescePreviewStart(
  projectId: string,
  githubBindingGeneration: number,
  start: () => Promise<PreviewStartResult>,
): Promise<PreviewStartResult> {
  const key = `${projectId}:${githubBindingGeneration}`;
  const existing = previewStartRequests.get(key);
  if (existing) return existing;

  const request = Promise.resolve().then(start);
  previewStartRequests.set(key, request);
  void request.then(
    () => {
      if (previewStartRequests.get(key) === request) previewStartRequests.delete(key);
    },
    () => {
      if (previewStartRequests.get(key) === request) previewStartRequests.delete(key);
    },
  );
  return request;
}

type PreviewProject = typeof projects.$inferSelect;

function launchProjectPreview(project: PreviewProject): Promise<PreviewStartResult> {
  return runInProjectLock(
    project.id,
    async () => {
      const checkoutReady = fs.existsSync(projectRepoPath(project.id));
      setPreviewStatus(
        project.id,
        checkoutReady ? "starting" : "cloning",
        checkoutReady
          ? "Preparing the latest project files"
          : `Fetching ${project.githubRepoFullName}`,
        checkoutReady ? "warm" : "cold",
      );
      try {
        const repoPath = await ensureRepoCloned(
          project.id,
          project.githubRepoFullName,
          project.defaultBranch,
          {
            expectedBindingGeneration: project.githubBindingGeneration,
          },
        );
        return await startDevPreview(
          project.id,
          repoPath,
          project.previewDevCommand,
          project.githubBindingGeneration,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start preview";
        if (getPreviewStatus(project.id).stage !== "error") {
          setPreviewStatus(project.id, "error", message);
        }
        throw error;
      }
    },
    project,
  );
}

/**
 * AI turns can finish while the initial preview is still starting. Queue one
 * replacement after that launch instead of accidentally sharing its stale
 * snapshot. Multiple browser tabs still coalesce onto the same replacement.
 */
function queuePreviewRefresh(project: PreviewProject): Promise<PreviewStartResult> {
  const key = `${project.id}:${project.githubBindingGeneration}`;
  const existing = previewRefreshRequests.get(key);
  if (existing) return existing;

  const precedingStart = previewStartRequests.get(key);
  const request = (precedingStart ? precedingStart.catch(() => undefined) : Promise.resolve()).then(
    () => launchProjectPreview(project),
  );
  previewRefreshRequests.set(key, request);
  void request.then(
    () => {
      if (previewRefreshRequests.get(key) === request) previewRefreshRequests.delete(key);
    },
    () => {
      if (previewRefreshRequests.get(key) === request) previewRefreshRequests.delete(key);
    },
  );
  return request;
}

export const previewRouter = new Hono<{ Variables: Variables }>()
  .post("/:id/preview", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    try {
      const { port, label } = await coalescePreviewStart(projectId, p.githubBindingGeneration, () =>
        launchProjectPreview(p),
      );
      const preview = getPreviewAddress(projectId, port);
      return c.json({ url: preview.url, previewMode: preview.mode, port, previewLabel: label });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to start preview";
      return c.json({ error: message }, 500);
    }
  })
  /**
   * Apply the control-plane checkout to an already-running isolated preview.
   *
   * This endpoint acknowledges immediately so the browser can swap to the
   * authenticated boot document while the replacement is serialized behind
   * the agent's project lock. The old E2B route is revoked first: users never
   * see a stale preview presented as if it contained the new AI edits.
   */
  .post("/:id/preview/refresh", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);

    const port = await reserveAvailablePreviewPort(projectId);
    deactivatePreviewPort(projectId, port);
    unregisterPreviewUpstream(projectId, port);
    setPreviewStatus(projectId, "starting", "Applying the latest changes", "warm");

    const request = queuePreviewRefresh(p);
    void request.catch((error) => {
      console.error("[preview-refresh] replacement failed", {
        projectId,
        githubBindingGeneration: p.githubBindingGeneration,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const preview = getPreviewAddress(projectId, port);
    let previewLabel = "-";
    const repo = projectRepoPath(projectId);
    if (readProjectPackageJson(repo)) {
      previewLabel = resolveDevCommand(repo, port, p.previewDevCommand).label;
    }
    return c.json(
      {
        accepted: true,
        url: preview.url,
        previewMode: preview.mode,
        port,
        previewLabel,
      },
      202,
    );
  })
  /**
   * Wipe node_modules and reinstall without re-cloning. Heals a project
   * whose dependencies were installed with the wrong NODE_ENV / missing
   * devDependencies / stale lockfile. Admins only.
   */
  .post("/:id/reinstall", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m || (m.role !== "admin" && m.role !== "editor")) {
      return c.json({ error: "Forbidden" }, 403);
    }
    try {
      await reinstallProjectDependencies(projectId);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Reinstall failed" }, 500);
    }
  })
  /**
   * Git commit history for the project. Shows version history in the UI
   * sourced directly from the cloned repo, no separate audit log needed.
   */
  .get("/:id/commits", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);

    const limit = Math.min(Number(c.req.query("limit") ?? "30"), 200);
    try {
      const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
        expectedBindingGeneration: p.githubBindingGeneration,
      });
      const result = await runInProjectLock(
        projectId,
        async () => {
          const g = simpleGitForProject(repoPath);

          // Current HEAD sha for "you are here" marker
          const headSha = (await g.revparse(["HEAD"])).trim();

          // Work out which remote commits are on origin so we can flag
          // "unpushed" vs "pushed" per commit.
          let pushedSet = new Set<string>();
          try {
            const branches = await g.branch(["-r"]);
            if (branches.all.includes(`origin/${p.defaultBranch}`)) {
              const remoteLog = await g.log({
                from: "", // everything
                to: `origin/${p.defaultBranch}`,
                maxCount: Math.max(limit * 2, 100),
              });
              pushedSet = new Set(remoteLog.all.map((l) => l.hash));
            }
          } catch {
            /* no remote yet */
          }

          const log = await g.log({ maxCount: limit });
          const commits = log.all.map((commit) => ({
            sha: commit.hash,
            shortSha: commit.hash.slice(0, 7),
            author: commit.author_name,
            email: commit.author_email,
            message: commit.message,
            subject: commit.message.split("\n")[0] ?? commit.message,
            body: commit.message.split("\n").slice(2).join("\n").trim(),
            timestamp: new Date(commit.date).getTime(),
            isHead: commit.hash === headSha,
            isPushed: pushedSet.has(commit.hash) || pushedSet.size === 0,
          }));
          return { commits, headSha };
        },
        p,
      );

      return c.json({
        commits: result.commits,
        branch: p.defaultBranch,
        repo: p.githubRepoFullName,
        headSha: result.headSha,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Failed to read git history" }, 500);
    }
  })
  .get("/:id/preview-meta", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    const port = await reserveAvailablePreviewPort(projectId);
    const preview = getPreviewAddress(projectId, port);
    let previewLabel = "-";
    const repo = projectRepoPath(projectId);
    if (readProjectPackageJson(repo)) {
      previewLabel = resolveDevCommand(repo, port, p.previewDevCommand).label;
    }
    const previewActive = isPreviewRoutable(projectId, port);
    const previewStage = getPreviewStatus(projectId).stage;
    const previewStarting =
      !previewActive &&
      (getPreviewProcessInfo(projectId).running ||
        previewStage === "cloning" ||
        previewStage === "installing" ||
        previewStage === "starting");
    return c.json({
      url: preview.url,
      previewMode: preview.mode,
      previewActive,
      previewStarting,
      port,
      previewLabel,
    });
  })
  /**
   * Deep debug snapshot for the live-preview pipeline. Used by the Debug
   * modal in the editor to diagnose why a preview is failing. Collects
   * everything we know locally, no external calls, so it never adds
   * latency or leaks data.
   */
  .get("/:id/preview-debug", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);

    const port = await reserveAvailablePreviewPort(projectId);
    const previewAddress = getPreviewAddress(projectId, port);
    const repoPath = projectRepoPath(projectId);
    const repoExists = fs.existsSync(repoPath);
    const packageJson = repoExists ? readProjectPackageJson(repoPath) : null;
    const hasPackageJson = packageJson !== null;
    const hasNodeModules = null;

    let packageJsonScripts: Record<string, string> | null = null;
    let packageManager: string | null = null;
    if (packageJson) {
      const scripts = packageJson.scripts as unknown;
      if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
        packageJsonScripts = Object.fromEntries(
          Object.entries(scripts).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
      packageManager = getPackageManager(repoPath);
    }

    let rootFiles: string[] = [];
    try {
      if (repoExists) rootFiles = fs.readdirSync(repoPath).slice(0, 80);
    } catch {
      /* ignore */
    }

    const fw = repoExists ? detectFramework(repoPath) : null;
    const dev =
      repoExists && hasPackageJson ? resolveDevCommand(repoPath, port, p.previewDevCommand) : null;

    const processInfo = getPreviewProcessInfo(projectId);
    const previewStatus = getPreviewStatus(projectId);

    // Probe the upstream dev server, short timeout so the modal is snappy
    type ProbeResult = { ok: boolean; status?: number; contentType?: string; error?: string };
    let probe: ProbeResult = { ok: false };
    const upstream = previewUpstreamUrl(projectId, port, "/");
    try {
      if (!upstream) throw new Error("Preview upstream is not registered.");
      const res = await fetch(upstream.url, {
        headers: upstream.headers,
        signal: AbortSignal.timeout(1500),
        redirect: "manual",
      });
      probe = {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get("content-type") ?? undefined,
      };
    } catch (e) {
      probe = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const logs = getPreviewLogs(projectId).slice(-120);

    const response = {
      project: {
        id: p.id,
        name: p.name,
        githubRepoFullName: p.githubRepoFullName,
        defaultBranch: p.defaultBranch,
        previewDevCommandOverride: p.previewDevCommand,
      },
      framework:
        fw && fw.id !== "unknown"
          ? {
              id: fw.id,
              label: fw.label,
              iconSlug: fw.iconSlug,
              color: fw.color,
              optimizes: fw.optimizes,
            }
          : null,
      workspace: {
        repoPath,
        repoExists,
        hasPackageJson,
        hasNodeModules,
        packageManager,
        packageJsonScripts,
        rootFiles,
      },
      devCommand: dev ? { command: dev.command, args: dev.args, label: dev.label } : null,
      preview: {
        port,
        previewUrl: previewAddress.url,
        previewMode: previewAddress.mode,
        stage: previewStatus.stage,
        stageMessage: previewStatus.message ?? null,
        stageUpdatedAt: previewStatus.updatedAt,
      },
      childProcess: processInfo,
      upstreamProbe: probe,
      logs,
      serverTime: Date.now(),
    };

    // Clients need the small health shape for the preview overlay, but host
    // paths, commands, repository listings, PIDs, and logs are operator-only.
    if (m.role === "client") {
      return c.json({
        ...response,
        workspace: {
          repoPath: "",
          repoExists,
          hasPackageJson,
          hasNodeModules,
          packageManager,
          packageJsonScripts: null,
          rootFiles: [],
        },
        devCommand: null,
        childProcess: { ...processInfo, pid: null, signalCode: null },
        upstreamProbe: probe.ok
          ? { ok: true, status: probe.status, contentType: probe.contentType }
          : { ok: false },
        logs: [],
      });
    }
    return c.json(response);
  });
