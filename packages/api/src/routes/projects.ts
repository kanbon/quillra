import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../db/index.js";
import { account } from "../db/auth-schema.js";
import { conversations, messages, projectMembers, projects } from "../db/schema.js";
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
import { detectFramework } from "../services/framework.js";
import sharp from "sharp";
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
      logoUrl: p.logoUrl,
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
      logoUrl: z.string().url().max(2048).nullable().optional(),
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
  .get("/:id/conversations", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.projectId, projectId))
      .orderBy(desc(conversations.updatedAt))
      .limit(50);
    return c.json({
      conversations: rows.map((x) => ({
        id: x.id,
        title: x.title,
        updatedAt: x.updatedAt.getTime(),
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
    const targetDir = path.join(repoPath, fw.assetsDir);
    fs.mkdirSync(targetDir, { recursive: true });

    // Where text/markdown/html content files land. Kept separate from images
    // and inside the repo so the agent can import them via the framework's
    // own asset/content system instead of pasting their full text inline.
    const contentDir = path.join(repoPath, "src", "content", "uploads");

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
        fs.writeFileSync(path.join(targetDir, filename), outBuf);
        items.push({
          path: `${fw.assetsDir}/${filename}`,
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
        fs.mkdirSync(contentDir, { recursive: true });
        const filename = `${stem}-${id}.${ext}`;
        fs.writeFileSync(path.join(contentDir, filename), inputBuf);
        items.push({
          path: `src/content/uploads/${filename}`,
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
  });
