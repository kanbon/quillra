import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { simpleGit } from "simple-git";
import { db } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import { detectFramework } from "../../services/framework.js";
import { getPreviewStatus } from "../../services/preview-status.js";
import {
  ensureRepoCloned,
  getPreviewLogs,
  getPreviewProcessInfo,
  getPreviewUrl,
  getProjectSubdomainId,
  previewPortForProject,
  projectRepoPath,
  reinstallProjectDependencies,
  resolveDevCommand,
  startDevPreview,
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
      const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
      const { port, label } = await startDevPreview(projectId, repoPath, p.previewDevCommand);
      const url = getPreviewUrl(projectId, port);
      return c.json({ url, port, previewLabel: label });
    } catch (e) {
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
      const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
      const g = simpleGit(repoPath);

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
      const commits = log.all.map((c) => ({
        sha: c.hash,
        shortSha: c.hash.slice(0, 7),
        author: c.author_name,
        email: c.author_email,
        message: c.message,
        subject: c.message.split("\n")[0] ?? c.message,
        body: c.message.split("\n").slice(2).join("\n").trim(), // skip blank line after subject
        timestamp: new Date(c.date).getTime(),
        isHead: c.hash === headSha,
        isPushed: pushedSet.has(c.hash) || pushedSet.size === 0, // if we couldn't read remote, assume pushed
      }));

      return c.json({
        commits,
        branch: p.defaultBranch,
        repo: p.githubRepoFullName,
        headSha,
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
    const port = previewPortForProject(projectId);
    const url = getPreviewUrl(projectId, port);
    let previewLabel = "-";
    const repo = projectRepoPath(projectId);
    if (fs.existsSync(path.join(repo, "package.json"))) {
      previewLabel = resolveDevCommand(repo, port, p.previewDevCommand).label;
    }
    return c.json({ url, port, previewLabel });
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

    const port = previewPortForProject(projectId);
    const previewUrl = getPreviewUrl(projectId, port);
    const repoPath = projectRepoPath(projectId);
    const repoExists = fs.existsSync(repoPath);
    const pkgPath = path.join(repoPath, "package.json");
    const nodeModulesPath = path.join(repoPath, "node_modules");
    const hasPackageJson = fs.existsSync(pkgPath);
    const hasNodeModules = fs.existsSync(nodeModulesPath);

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
      if (fs.existsSync(path.join(repoPath, "yarn.lock"))) packageManager = "yarn";
      else if (fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) packageManager = "pnpm";
      else packageManager = "npm";
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
    const subdomainId = getProjectSubdomainId(projectId);
    const subdomainHost = process.env.PREVIEW_DOMAIN;

    // Probe the upstream dev server, short timeout so the modal is snappy
    type ProbeResult = { ok: boolean; status?: number; contentType?: string; error?: string };
    let probe: ProbeResult = { ok: false };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
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

    return c.json({
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
        previewUrl,
        subdomainHost: subdomainHost ?? null,
        subdomainId,
        stage: previewStatus.stage,
        stageMessage: previewStatus.message ?? null,
        stageUpdatedAt: previewStatus.updatedAt,
      },
      childProcess: processInfo,
      upstreamProbe: probe,
      logs,
      serverTime: Date.now(),
    });
  });
