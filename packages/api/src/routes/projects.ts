import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../db/index.js";
import { account } from "../db/auth-schema.js";
import { messages, projectMembers, projects } from "../db/schema.js";
import type { SessionUser } from "../lib/auth.js";
import type { ProjectRole } from "../db/app-schema.js";
import {
  clearProjectRepoClone,
  ensureRepoCloned,
  getPreviewUrl,
  previewPortForProject,
  projectRepoPath,
  pushToGitHub,
  resolveDevCommand,
  startDevPreview,
  stopPreview,
} from "../services/workspace.js";
import { processUploadToWebP } from "../services/image.js";
import { simpleGit } from "simple-git";
import fs from "node:fs";
import path from "node:path";

type Variables = { user: SessionUser | null };

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
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const patch: {
      name?: string;
      previewDevCommand?: string | null;
      githubRepoFullName?: string;
      defaultBranch?: string;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.previewDevCommand !== undefined) patch.previewDevCommand = parsed.data.previewDevCommand;
    if (parsed.data.githubRepoFullName !== undefined) patch.githubRepoFullName = parsed.data.githubRepoFullName;
    if (parsed.data.defaultBranch !== undefined) patch.defaultBranch = parsed.data.defaultBranch;

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
    stopPreview(projectId);
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

      // Generate a plain-English summary using Claude
      let summary = "";
      if (hasChanges) {
        try {
          const diffOutput = await g.diff(["--stat", "--no-color"]);
          const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
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
                  content: `Summarize these website changes in 1-2 short sentences for a non-technical person. Be specific about what changed (e.g. "Updated the homepage title" not "Modified files"). No technical jargon.\n\nChanged files:\n${dirty.join("\n")}\n\nDiff summary:\n${diffOutput.slice(0, 1000)}`,
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
      const [acct] = await db
        .select()
        .from(account)
        .where(and(eq(account.userId, r.user.id), eq(account.providerId, "github")))
        .limit(1);
      const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
      const result = await pushToGitHub(repoPath, p.defaultBranch, p.githubRepoFullName, acct?.accessToken, {
        name: r.user.name,
        email: r.user.email,
      });
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
  .get("/:id/messages", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.projectId, projectId))
      .orderBy(desc(messages.id))
      .limit(100);
    return c.json({
      messages: rows.reverse().map((x) => ({
        id: x.id,
        role: x.role,
        content: x.content,
        createdAt: x.createdAt.getTime(),
      })),
    });
  })
  .post("/:id/upload", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);

    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || !(file instanceof File)) return c.json({ error: "Expected file field" }, 400);
    const buf = Buffer.from(await file.arrayBuffer());
    const webp = await processUploadToWebP(buf);
    const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
    const uploads = path.join(repoPath, "public", "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    const name = `${nanoid()}.webp`;
    const outPath = path.join(uploads, name);
    fs.writeFileSync(outPath, webp);
    return c.json({ path: `/uploads/${name}`, bytes: webp.length });
  });
