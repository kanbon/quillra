import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { conversations, messages, projectMembers, projects } from "../db/schema.js";
import type { SessionUser } from "../lib/auth.js";
import type { ProjectRole } from "../db/app-schema.js";
import {
  clearProjectRepoClone,
  ensureQuillraTempIgnored,
  ensureRepoCloned,
  getPreviewLogs,
  getPreviewProcessInfo,
  getPreviewUrl,
  getProjectSubdomainId,
  previewPortForProject,
  projectRepoPath,
  pushToGitHub,
  QUILLRA_TEMP_DIR,
  reinstallProjectDependencies,
  resolveDevCommand,
  startDevPreview,
  stopPreview,
} from "../services/workspace.js";
import { getPreviewStatus } from "../services/preview-status.js";
import { processUploadToWebP } from "../services/image.js";
import { detectFramework } from "../services/framework.js";
import { getInstanceSetting } from "../services/instance-settings.js";
import { beat as presenceBeat, listOthers as presenceListOthers } from "../services/presence.js";
import sharp from "sharp";
import { simpleGit } from "simple-git";
import fs from "node:fs";
import path from "node:path";

type Variables = {
  user: SessionUser | null;
  /** Populated when the request was authenticated via the client session cookie. */
  clientSession: { projectId: string } | null;
};

async function requireUser(c: { get: (k: "user") => SessionUser | null; json: (b: unknown, s: number) => Response }) {
  const user = c.get("user");
  if (!user) return { error: c.json({ error: "Unauthorized" }, 401) };
  return { user };
}

async function memberForProject(userId: string, projectId: string) {
  const [row] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

export const projectsRouter = new Hono<{ Variables: Variables }>()
  .get("/", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const rows = await db
      .select({
        project: projects,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(eq(projectMembers.userId, r.user.id))
      .orderBy(desc(projects.updatedAt));

    return c.json({
      projects: rows.map(({ project, role }) => ({
        id: project.id,
        name: project.name,
        githubRepoFullName: project.githubRepoFullName,
        defaultBranch: project.defaultBranch,
        role,
        updatedAt: project.updatedAt.getTime(),
      })),
    });
  })
  .post("/", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null);
    const schema = z.object({
      name: z.string().min(1).max(200),
      githubRepoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      defaultBranch: z.string().min(1).default("main"),
      previewDevCommand: z.string().max(2000).nullable().optional(),
      // Optional flag — set to "astro" if the user ticked the
      // "Convert to Astro" card in ConnectProjectModal. Kicks off a
      // migration agent run on project open.
      migrationTarget: z.enum(["astro"]).nullable().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const id = nanoid();
    const now = new Date();
    await db.insert(projects).values({
      id,
      name: parsed.data.name,
      githubRepoFullName: parsed.data.githubRepoFullName,
      defaultBranch: parsed.data.defaultBranch,
      previewDevCommand: parsed.data.previewDevCommand ?? null,
      migrationTarget: parsed.data.migrationTarget ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectMembers).values({
      id: nanoid(),
      projectId: id,
      userId: r.user.id,
      role: "admin",
      createdAt: now,
    });

    return c.json({ id }, 201);
  })
  .get("/:id", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    return c.json({
      id: p.id,
      name: p.name,
      githubRepoFullName: p.githubRepoFullName,
      defaultBranch: p.defaultBranch,
      previewDevCommand: p.previewDevCommand,
      logoUrl: p.logoUrl,
      migrationTarget: p.migrationTarget,
      role: m.role,
    });
  })
  .patch("/:id", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m || m.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    const [existing] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!existing) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const schema = z.object({
      name: z.string().min(1).max(200).optional(),
      previewDevCommand: z.string().max(2000).nullable().optional(),
      githubRepoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
      defaultBranch: z.string().min(1).max(255).optional(),
      // Accepts either a real https URL or a data: URL (from the logo upload endpoint)
      logoUrl: z
        .string()
        .max(2_500_000) // ~2.5 MB upper bound for base64-encoded logos
        .refine(
          (v) => v.startsWith("http://") || v.startsWith("https://") || v.startsWith("data:image/"),
          { message: "logoUrl must be an http(s) or data:image URL" },
        )
        .nullable()
        .optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const patch: {
      name?: string;
      previewDevCommand?: string | null;
      githubRepoFullName?: string;
      defaultBranch?: string;
      logoUrl?: string | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.previewDevCommand !== undefined) patch.previewDevCommand = parsed.data.previewDevCommand;
    if (parsed.data.githubRepoFullName !== undefined) patch.githubRepoFullName = parsed.data.githubRepoFullName;
    if (parsed.data.defaultBranch !== undefined) patch.defaultBranch = parsed.data.defaultBranch;
    if (parsed.data.logoUrl !== undefined) patch.logoUrl = parsed.data.logoUrl;

    const repoChanged =
      patch.githubRepoFullName !== undefined && patch.githubRepoFullName !== existing.githubRepoFullName;
    const branchChanged =
      patch.defaultBranch !== undefined && patch.defaultBranch !== existing.defaultBranch;
    if (repoChanged || branchChanged) {
      clearProjectRepoClone(projectId);
    }

    await db.update(projects).set(patch).where(eq(projects.id, projectId));
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m || m.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    // Kill any running preview + wipe the cloned workspace (node_modules,
    // git, everything) so deleted projects don't leave orphan files.
    clearProjectRepoClone(projectId);
    await db.delete(projects).where(eq(projects.id, projectId));
    return c.newResponse(null, 204);
  })
  .get("/:id/publish-status", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    try {
      const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
      const g = simpleGit(repoPath);
      const status = await g.status();
      const dirty = [...status.modified, ...status.created, ...status.not_added, ...status.deleted];
      let unpushed = 0;
      try {
        const branches = await g.branch(["-r"]);
        if (branches.all.includes(`origin/${p.defaultBranch}`)) {
          const log = await g.log({ from: `origin/${p.defaultBranch}`, to: "HEAD", maxCount: 100 });
          unpushed = log.total;
        }
      } catch { /* no remote yet */ }
      const hasChanges = dirty.length > 0 || unpushed > 0;

      // Generate a plain-English summary using Claude. This is the
      // expensive call (an API round-trip and tokens) — only run it when
      // the caller explicitly asks via ?summary=1, so the header's
      // changes-pill polling can hit this endpoint cheaply.
      const wantSummary = c.req.query("summary") === "1";
      let summary = "";
      if (wantSummary && hasChanges) {
        try {
          const diffOutput = await g.diff(["--stat", "--no-color"]);
          const apiKey = getInstanceSetting("ANTHROPIC_API_KEY");
          if (apiKey && diffOutput) {
            const res = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 150,
                messages: [{
                  role: "user",
                  content: `Summarize these website changes for a non-technical person. Write exactly 1-3 bullet points using markdown "- " syntax (dash space). Each bullet on its own line. Be specific (e.g. "Updated the homepage title"). No headings, no code, no filenames. Example format:\n- Changed the hero text\n- Added a new page\n\nChanged files:\n${dirty.join("\n")}\n\nDiff summary:\n${diffOutput.slice(0, 1000)}`,
                }],
              }),
            });
            if (res.ok) {
              const body = await res.json() as { content?: { text?: string }[] };
              summary = body.content?.[0]?.text ?? "";
            }
          }
        } catch { /* summary is optional */ }
      }

      return c.json({ dirty, unpushed, hasChanges, summary });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
    }
  })
  /**
   * Technical change overview. Returns every dirty + untracked file
   * with its full unified git diff, plus the list of local commits
   * that aren't on the remote default branch yet. Used by the
   * "changes pill" in ProjectHeader — the pill itself polls the
   * lightweight /publish-status endpoint, but when the user clicks
   * it, THIS endpoint supplies the per-file diff bodies shown in
   * the ChangesModal.
   *
   * Untracked files get a synthetic "everything added" diff via
   * `git diff --no-index /dev/null <file>` so the UI doesn't have
   * a weird empty state for brand-new files.
   */
  .get("/:id/changes", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    try {
      const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
      const g = simpleGit(repoPath);
      const status = await g.status();

      type FileChange = {
        path: string;
        status: "modified" | "added" | "deleted" | "untracked" | "renamed";
        additions: number;
        deletions: number;
        diff: string;
        isBinary: boolean;
      };

      const files: FileChange[] = [];
      const seen = new Set<string>();
      const pushFile = async (
        path: string,
        fileStatus: FileChange["status"],
      ) => {
        if (seen.has(path)) return;
        seen.add(path);
        let diff = "";
        let isBinary = false;
        try {
          if (fileStatus === "untracked") {
            diff = await g
              .raw(["diff", "--no-index", "--", "/dev/null", path])
              .catch(() => "");
          } else {
            diff = await g.diff(["--", path]);
          }
        } catch {
          diff = "";
        }
        if (/^Binary files /m.test(diff) || diff.includes("\x00")) {
          isBinary = true;
          diff = "";
        }
        let additions = 0;
        let deletions = 0;
        for (const line of diff.split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) additions++;
          else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
        }
        // Hard cap on diff size so a monstrous auto-generated file
        // doesn't make the modal unusable. 200kB is plenty for real
        // human edits.
        if (diff.length > 200_000) {
          diff = diff.slice(0, 200_000) + "\n… (truncated)";
        }
        files.push({ path, status: fileStatus, additions, deletions, diff, isBinary });
      };

      for (const f of status.deleted) await pushFile(f, "deleted");
      for (const f of status.modified) await pushFile(f, "modified");
      for (const f of status.created) await pushFile(f, "added");
      for (const r of status.renamed) await pushFile(r.to, "renamed");
      for (const f of status.not_added) await pushFile(f, "untracked");

      // Unpushed commits (local-only vs origin/<default branch>)
      type CommitEntry = {
        sha: string;
        shortSha: string;
        message: string;
        author: string;
        date: string;
      };
      const commits: CommitEntry[] = [];
      try {
        const branches = await g.branch(["-r"]);
        if (branches.all.includes(`origin/${p.defaultBranch}`)) {
          const log = await g.log({
            from: `origin/${p.defaultBranch}`,
            to: "HEAD",
            maxCount: 50,
          });
          for (const commit of log.all) {
            commits.push({
              sha: commit.hash,
              shortSha: commit.hash.slice(0, 7),
              message: commit.message,
              author: commit.author_name,
              date: commit.date,
            });
          }
        }
      } catch {
        /* no remote yet */
      }

      return c.json({ files, commits });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
    }
  })
  /**
   * Destructive: revert the working tree AND drop any unpushed local
   * commits, bringing the repo back in sync with `origin/<branch>`.
   *
   * Runs `git fetch origin` → `git reset --hard origin/<branch>` →
   * `git clean -fd`. The last step removes untracked files, but
   * `git clean` by default respects both `.gitignore` and
   * `.git/info/exclude`, so anything in `.quillra-temp/` survives —
   * we register that folder with the local exclude in
   * ensureQuillraTempIgnored() precisely so that chat scratch assets
   * don't get nuked by a discard.
   *
   * Permission: admin or editor. Clients and translators can't
   * discard published work they didn't author.
   */
  .post("/:id/discard-changes", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m || (m.role !== "admin" && m.role !== "editor")) {
      return c.json({ error: "Only editors and admins can discard changes." }, 403);
    }
    const [p] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    try {
      const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
      const g = simpleGit(repoPath);
      // Make sure we know the latest state of the remote before resetting
      // onto it. Failure here is non-fatal — we can still hard-reset to
      // whatever HEAD's upstream was when we cloned.
      await g.fetch("origin", p.defaultBranch).catch(() => undefined);
      const branches = await g.branch(["-r"]);
      if (branches.all.includes(`origin/${p.defaultBranch}`)) {
        await g.reset(["--hard", `origin/${p.defaultBranch}`]);
      } else {
        await g.reset(["--hard", "HEAD"]);
      }
      // Remove untracked files the reset didn't touch. `-f` (force) is
      // required by git by default, `-d` recurses into untracked
      // directories. We deliberately do NOT pass `-x` — that would
      // also wipe ignored files, including `.quillra-temp/` contents.
      await g.clean("fd");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Discard failed" }, 500);
    }
  })
  .post("/:id/publish", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m || (m.role !== "admin" && m.role !== "editor")) {
      return c.json({ error: "Only editors and admins can publish." }, 403);
    }
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    try {
      const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);

      // Generate a proper commit message from the diff via Claude Haiku.
      // Falls back to a filename summary inside pushToGitHub if this
      // errors out or the Anthropic key isn't set.
      let commitMessage: string | null = null;
      try {
        const g = simpleGit(repoPath);
        const status = await g.status();
        const dirtyList = [
          ...status.modified,
          ...status.created,
          ...status.not_added,
          ...status.deleted,
        ];
        if (dirtyList.length > 0) {
          const diffOutput = await g.diff(["--stat", "--no-color"]).catch(() => "");
          const diffFull = await g.diff(["--no-color"]).catch(() => "");
          const apiKey = getInstanceSetting("ANTHROPIC_API_KEY");
          if (apiKey && diffOutput) {
            const res = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 200,
                messages: [
                  {
                    role: "user",
                    content: `You are writing a git commit message for website edits made through a CMS.

Rules:
- First line: concise imperative subject in present tense, max 72 chars, no trailing period.
- Blank line.
- 1-3 bullet lines (prefix "- "), each describing a concrete change. Keep them short, specific, user-facing where possible.
- No markdown headings, no code blocks, no "Committed via …" footer.
- Write it as if a human developer is committing their own work.

Changed files:
${dirtyList.slice(0, 20).join("\n")}

Diff summary:
${diffOutput.slice(0, 1500)}

First 3000 chars of the full diff:
${diffFull.slice(0, 3000)}

Output ONLY the commit message, nothing else.`,
                  },
                ],
              }),
            });
            if (res.ok) {
              const body = (await res.json()) as { content?: { text?: string }[] };
              const text = body.content?.[0]?.text?.trim();
              if (text) commitMessage = text;
            }
          }
        }
      } catch {
        /* fall back to filename summary inside pushToGitHub */
      }

      const result = await pushToGitHub(
        repoPath,
        p.defaultBranch,
        p.githubRepoFullName,
        { name: r.user.name ?? null, email: r.user.email ?? null },
        commitMessage,
      );
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Publish failed" }, 400);
    }
  })
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
      return c.json(
        { error: e instanceof Error ? e.message : "Failed to start preview" },
        500,
      );
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
      return c.json(
        { error: e instanceof Error ? e.message : "Reinstall failed" },
        500,
      );
    }
  })
  /**
   * Git commit history for the project. Shows version history in the UI
   * sourced directly from the cloned repo — no separate audit log needed.
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
      } catch { /* no remote yet */ }

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
    let previewLabel = "—";
    const repo = projectRepoPath(projectId);
    if (fs.existsSync(path.join(repo, "package.json"))) {
      previewLabel = resolveDevCommand(repo, port, p.previewDevCommand).label;
    }
    return c.json({ url, port, previewLabel });
  })
  /**
   * Deep debug snapshot for the live-preview pipeline. Used by the Debug
   * modal in the editor to diagnose why a preview is failing. Collects
   * everything we know locally — no external calls — so it never adds
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
      } catch { /* ignore malformed */ }
      if (fs.existsSync(path.join(repoPath, "yarn.lock"))) packageManager = "yarn";
      else if (fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) packageManager = "pnpm";
      else packageManager = "npm";
    }

    let rootFiles: string[] = [];
    try {
      if (repoExists) rootFiles = fs.readdirSync(repoPath).slice(0, 80);
    } catch { /* ignore */ }

    const fw = repoExists ? detectFramework(repoPath) : null;
    const dev = repoExists && hasPackageJson
      ? resolveDevCommand(repoPath, port, p.previewDevCommand)
      : null;

    const processInfo = getPreviewProcessInfo(projectId);
    const previewStatus = getPreviewStatus(projectId);
    const subdomainId = getProjectSubdomainId(projectId);
    const subdomainHost = process.env.PREVIEW_DOMAIN;

    // Probe the upstream dev server — short timeout so the modal is snappy
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
      framework: fw && fw.id !== "unknown"
        ? { id: fw.id, label: fw.label, iconSlug: fw.iconSlug, color: fw.color, optimizes: fw.optimizes }
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
      devCommand: dev
        ? { command: dev.command, args: dev.args, label: dev.label }
        : null,
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
  })
  .get("/:id/conversations", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);

    // Visibility rules:
    //   - clients only see their own conversations
    //   - admins / editors / translators see every conversation in the
    //     project, with an optional ?userId=... filter for the UI's
    //     "show only this person" dropdown
    const filterUserId = c.req.query("userId");
    const whereExpr =
      m.role === "client"
        ? and(eq(conversations.projectId, projectId), eq(conversations.createdByUserId, r.user.id))
        : filterUserId
          ? and(eq(conversations.projectId, projectId), eq(conversations.createdByUserId, filterUserId))
          : eq(conversations.projectId, projectId);

    const rows = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
        createdByUserId: conversations.createdByUserId,
      })
      .from(conversations)
      .where(whereExpr)
      .orderBy(desc(conversations.updatedAt))
      .limit(100);

    // Enrich with the creator's name/email so the UI can show who wrote
    // each chat without a second round-trip. Only do the join for non-
    // client roles — clients already know it's all themselves.
    type Author = { id: string; name: string; email: string; image: string | null };
    const authors = new Map<string, Author>();
    if (m.role !== "client") {
      const uniqueUserIds = Array.from(
        new Set(rows.map((r) => r.createdByUserId).filter((v): v is string => !!v)),
      );
      if (uniqueUserIds.length > 0) {
        const users = await db
          .select({ id: user.id, name: user.name, email: user.email, image: user.image })
          .from(user);
        for (const u of users) {
          if (uniqueUserIds.includes(u.id)) authors.set(u.id, u);
        }
      }
    }

    return c.json({
      viewerRole: m.role,
      canSeeAll: m.role !== "client",
      conversations: rows.map((x) => ({
        id: x.id,
        title: x.title,
        updatedAt: x.updatedAt.getTime(),
        createdByUserId: x.createdByUserId,
        author: x.createdByUserId ? authors.get(x.createdByUserId) ?? null : null,
      })),
    });
  })
  .get("/:id/messages", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const conversationId = c.req.query("conversationId");
    const where = conversationId
      ? and(eq(messages.projectId, projectId), eq(messages.conversationId, conversationId))
      : eq(messages.projectId, projectId);
    const rows = await db
      .select()
      .from(messages)
      .where(where)
      .orderBy(desc(messages.id))
      .limit(100);
    return c.json({
      messages: rows.reverse().map((x) => {
        let attachments: { path: string; originalName: string }[] | undefined;
        if (x.attachments) {
          try { attachments = JSON.parse(x.attachments); } catch { /* ignore */ }
        }
        return {
          id: x.id,
          role: x.role,
          content: x.content,
          conversationId: x.conversationId,
          createdAt: x.createdAt.getTime(),
          attachments,
        };
      }),
    });
  })
  .get("/:id/file", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    const rel = (c.req.query("path") ?? "").replace(/^\/+/, "");
    if (!rel) return c.json({ error: "path required" }, 400);
    const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
    const resolved = path.resolve(repoPath, rel);
    if (!resolved.startsWith(path.resolve(repoPath) + path.sep)) {
      return c.json({ error: "Invalid path" }, 400);
    }
    if (!fs.existsSync(resolved)) return c.json({ error: "Not found" }, 404);
    const ext = path.extname(resolved).toLowerCase().slice(1);
    const mime: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
      gif: "image/gif", svg: "image/svg+xml", avif: "image/avif",
    };
    const buf = fs.readFileSync(resolved);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "content-type": mime[ext] ?? "application/octet-stream",
        "cache-control": "private, max-age=300",
      },
    });
  })
  .get("/:id/framework", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
    const fw = detectFramework(repoPath);
    return c.json(fw);
  })
  .post("/:id/upload", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);

    // Accept either a single `file` field or multiple `files` fields
    const body = await c.req.parseBody({ all: true });
    const candidates: unknown[] = [];
    if (Array.isArray(body.files)) candidates.push(...body.files);
    else if (body.files) candidates.push(body.files);
    if (Array.isArray(body.file)) candidates.push(...body.file);
    else if (body.file) candidates.push(body.file);

    const files: File[] = candidates.filter((f): f is File => f instanceof File);
    if (files.length === 0) return c.json({ error: "Expected files field" }, 400);

    const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
    const fw = detectFramework(repoPath);
    // EVERY chat upload lands in `.quillra-temp/` first. The folder is
    // ignored via .git/info/exclude so files never show up in a commit
    // unless the agent explicitly promotes them to a real asset path
    // (public/, src/content/, etc.). This solves the "reference-only
    // screenshot ends up pushed to GitHub" problem — the agent decides
    // per-file whether the attachment is a real asset for the site or
    // just context for the conversation.
    ensureQuillraTempIgnored(repoPath);
    const tempDir = path.join(repoPath, QUILLRA_TEMP_DIR);
    fs.mkdirSync(tempDir, { recursive: true });

    type UploadItem = {
      path: string;
      originalName: string;
      bytes: number;
      contentType: string;
      kind: "image" | "content";
    };
    const items: UploadItem[] = [];

    const CONTENT_EXTS = new Set(["txt", "md", "markdown", "html", "htm", "csv", "json"]);
    const CONTENT_MIME_PREFIXES = ["text/"];
    const CONTENT_MIMES = new Set([
      "application/json",
      "application/xml",
      "application/x-yaml",
      "application/yaml",
    ]);

    function isContentFile(file: File): boolean {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (CONTENT_EXTS.has(ext)) return true;
      if (CONTENT_MIMES.has(file.type)) return true;
      if (CONTENT_MIME_PREFIXES.some((p) => file.type.startsWith(p))) return true;
      return false;
    }

    function safeStem(name: string, fallback: string): string {
      return (
        (name.replace(/\.[^.]+$/, "") || fallback)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/(^-|-$)/g, "")
          .slice(0, 40) || fallback
      );
    }

    for (const file of files) {
      const isImage = file.type.startsWith("image/");
      const isContent = !isImage && isContentFile(file);
      if (!isImage && !isContent) continue;

      const inputBuf = Buffer.from(await file.arrayBuffer());
      const id = nanoid(10);

      if (isImage) {
        // We still normalize heavy uploads (resize + pick an efficient
        // format) so the file is agent-friendly. The destination is
        // .quillra-temp/ regardless — the agent decides later whether
        // to move it into a real asset path.
        const stem = safeStem(file.name, "image");
        let outBuf: Buffer;
        let ext: string;
        let contentType: string;
        if (fw.optimizes) {
          const meta = await sharp(inputBuf).metadata();
          const isJpeg = meta.format === "jpeg" || meta.format === "jpg";
          const isPng = meta.format === "png";
          const pipeline = sharp(inputBuf).rotate().resize(2400, 2400, { fit: "inside", withoutEnlargement: true });
          if (isJpeg) {
            outBuf = await pipeline.jpeg({ quality: 90 }).toBuffer();
            ext = "jpg";
            contentType = "image/jpeg";
          } else if (isPng) {
            outBuf = await pipeline.png({ compressionLevel: 9 }).toBuffer();
            ext = "png";
            contentType = "image/png";
          } else {
            outBuf = await pipeline.webp({ quality: 90 }).toBuffer();
            ext = "webp";
            contentType = "image/webp";
          }
        } else {
          outBuf = await processUploadToWebP(inputBuf);
          ext = "webp";
          contentType = "image/webp";
        }
        const filename = `${stem}-${id}.${ext}`;
        fs.writeFileSync(path.join(tempDir, filename), outBuf);
        items.push({
          path: `${QUILLRA_TEMP_DIR}/${filename}`,
          originalName: file.name,
          bytes: outBuf.length,
          contentType,
          kind: "image",
        });
      } else {
        // Content file: keep the original extension, just sanitize the stem
        const stem = safeStem(file.name, "content");
        const rawExt = (file.name.split(".").pop() ?? "txt").toLowerCase();
        const ext = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : "txt";
        // Cap content uploads to 1 MiB so a stray paste can't fill the disk
        const MAX_CONTENT_BYTES = 1024 * 1024;
        if (inputBuf.length > MAX_CONTENT_BYTES) continue;
        const filename = `${stem}-${id}.${ext}`;
        fs.writeFileSync(path.join(tempDir, filename), inputBuf);
        items.push({
          path: `${QUILLRA_TEMP_DIR}/${filename}`,
          originalName: file.name,
          bytes: inputBuf.length,
          contentType: file.type || "text/plain",
          kind: "content",
        });
      }
    }

    if (items.length === 0) return c.json({ error: "No supported files in upload" }, 400);
    return c.json({ items, framework: fw });
  })
  .post("/:id/asset-delete", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json().catch(() => null) as { path?: string } | null;
    const rel = body?.path?.replace(/^\/+/, "");
    if (!rel) return c.json({ error: "path required" }, 400);
    // Path safety: must stay inside the repo
    const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
    const resolved = path.resolve(repoPath, rel);
    if (!resolved.startsWith(path.resolve(repoPath) + path.sep)) {
      return c.json({ error: "Invalid path" }, 400);
    }
    try {
      fs.unlinkSync(resolved);
    } catch { /* already gone */ }
    return c.json({ ok: true });
  })
  /**
   * Upload a project logo. The file is resized/recoded via sharp into a
   * reasonable square PNG under ~200 KiB and stored as a data: URL in
   * projects.logo_url. Avoids the "you need a CDN" step for small teams
   * while keeping the column portable (it's still just text).
   *
   * Admins only.
   */
  .post("/:id/logo", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m || m.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || !(file instanceof File)) return c.json({ error: "Expected file field" }, 400);
    if (!file.type.startsWith("image/")) return c.json({ error: "File must be an image" }, 400);
    // Hard cap raw upload at 5 MB before sharp even sees it
    if (file.size > 5 * 1024 * 1024) return c.json({ error: "Image too large (max 5 MB)" }, 400);

    const inputBuf = Buffer.from(await file.arrayBuffer());
    let outBuf: Buffer;
    try {
      outBuf = await sharp(inputBuf)
        .rotate() // honour EXIF
        .resize(256, 256, { fit: "cover", position: "centre" })
        .png({ compressionLevel: 9 })
        .toBuffer();
    } catch {
      return c.json({ error: "Could not process image" }, 400);
    }

    const dataUrl = `data:image/png;base64,${outBuf.toString("base64")}`;

    await db
      .update(projects)
      .set({ logoUrl: dataUrl, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return c.json({ logoUrl: dataUrl, bytes: outBuf.length });
  })
  /** Clear the project logo (sets logo_url to NULL). Admins only. */
  .delete("/:id/logo", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m || m.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    await db.update(projects).set({ logoUrl: null, updatedAt: new Date() }).where(eq(projects.id, projectId));
    return c.json({ ok: true });
  })
  /**
   * Presence heartbeat. The frontend hits this every ~10s while a user has a
   * project open. Upserts the caller into the in-memory presence map and
   * returns every other active viewer for that project (team members and
   * clients alike, excluding self).
   */
  .post("/:id/presence/beat", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");

    // Access check: team members (via projectMembers row) OR a client whose
    // session cookie is pinned to exactly this project.
    const clientSession = c.get("clientSession");
    let kind: "team" | "client";
    if (clientSession && clientSession.projectId === projectId) {
      kind = "client";
    } else {
      const m = await memberForProject(r.user.id, projectId);
      if (!m) return c.json({ error: "Forbidden" }, 403);
      kind = "team";
    }

    presenceBeat(
      projectId,
      {
        id: r.user.id,
        name: r.user.name ?? r.user.email ?? "Someone",
        email: r.user.email ?? "",
        image: r.user.image ?? null,
      },
      kind,
    );

    const others = presenceListOthers(projectId, r.user.id).map((e) => ({
      userId: e.userId,
      name: e.name,
      email: e.email,
      image: e.image,
      kind: e.kind,
      lastSeenAt: e.lastSeenAt,
    }));
    return c.json({ others });
  });
