import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import { detectFramework } from "../../services/framework.js";
import { getPreviewStatus, isPreviewPortActive } from "../../services/preview-status.js";
import { previewUpstreamUrl } from "../../services/preview-upstream.js";
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
  stopPreview,
} from "../../services/workspace.js";
import { type Variables, memberForProject, requireUser } from "./shared.js";

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
      const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
        expectedBindingGeneration: p.githubBindingGeneration,
      });
      const { port, label } = await runInProjectLock(
        projectId,
        () => startDevPreview(projectId, repoPath, p.previewDevCommand, p.githubBindingGeneration),
        p,
      );
      const preview = getPreviewAddress(projectId, port);
      return c.json({ url: preview.url, previewMode: preview.mode, port, previewLabel: label });
    } catch (e) {
      stopPreview(projectId);
      return c.json({ error: e instanceof Error ? e.message : "Failed to start preview" }, 500);
    }
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
    if (fs.existsSync(path.join(repo, "package.json"))) {
      previewLabel = resolveDevCommand(repo, port, p.previewDevCommand).label;
    }
    return c.json({
      url: preview.url,
      previewMode: preview.mode,
      previewActive: isPreviewPortActive(projectId, port),
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
    const pkgPath = path.join(repoPath, "package.json");
    const hasPackageJson = fs.existsSync(pkgPath);
    const hasNodeModules = null;

    let packageJsonScripts: Record<string, string> | null = null;
    let packageManager: string | null = null;
    if (hasPackageJson) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          scripts?: Record<string, string>;
        };
        packageJsonScripts = pkg.scripts ?? null;
      } catch {
        /* ignore malformed */
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
