import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { db } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import { detectFramework } from "../../services/framework.js";
import { processUploadToWebP } from "../../services/image.js";
import {
  QUILLRA_TEMP_DIR,
  ensureQuillraTempIgnored,
  ensureRepoCloned,
} from "../../services/workspace.js";
import { type Variables, memberForProject, requireUser } from "./shared.js";

export const filesRouter = new Hono<{ Variables: Variables }>()
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
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
      avif: "image/avif",
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
    // screenshot ends up pushed to GitHub" problem, the agent decides
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
        // .quillra-temp/ regardless, the agent decides later whether
        // to move it into a real asset path.
        const stem = safeStem(file.name, "image");
        let outBuf: Buffer;
        let ext: string;
        let contentType: string;
        if (fw.optimizes) {
          const meta = await sharp(inputBuf).metadata();
          const isJpeg = meta.format === "jpeg" || meta.format === "jpg";
          const isPng = meta.format === "png";
          const pipeline = sharp(inputBuf)
            .rotate()
            .resize(2400, 2400, { fit: "inside", withoutEnlargement: true });
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
    const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
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
    } catch {
      /* already gone */
    }
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
    await db
      .update(projects)
      .set({ logoUrl: null, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    return c.json({ ok: true });
  });
