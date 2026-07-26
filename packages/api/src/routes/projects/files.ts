import path from "node:path";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { db } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import {
  ProjectFilePathError,
  assertProjectDirectory,
  deleteProjectFile,
  ensureProjectDirectory,
  ensureProjectGitExclude,
  readProjectFile,
  writeProjectFile,
} from "../../lib/project-files.js";
import {
  PROJECT_IMAGE_MAX_INPUT_PIXELS,
  PROJECT_LOGO_BODY_MAX_BYTES,
  PROJECT_LOGO_MAX_FILE_BYTES,
  PROJECT_LOGO_MAX_OUTPUT_BYTES,
  PROJECT_UPLOAD_BODY_MAX_BYTES,
  PROJECT_UPLOAD_MAX_AGGREGATE_BYTES,
  PROJECT_UPLOAD_MAX_CONTENT_FILE_BYTES,
  PROJECT_UPLOAD_MAX_FILES,
  PROJECT_UPLOAD_MAX_FILE_BYTES,
  PROJECT_UPLOAD_MAX_OUTPUT_AGGREGATE_BYTES,
  PROJECT_UPLOAD_MAX_OUTPUT_FILE_BYTES,
} from "../../lib/request-limits.js";
import { detectFramework } from "../../services/framework.js";
import { processUploadToWebP } from "../../services/image.js";
import { ProjectGithubBindingChangedError } from "../../services/project-github-token.js";
import { QUILLRA_TEMP_DIR, ensureRepoCloned, runInProjectLock } from "../../services/workspace.js";
import { type Variables, memberForProject, requireUser } from "./shared.js";

export {
  PROJECT_IMAGE_MAX_INPUT_PIXELS,
  PROJECT_LOGO_BODY_MAX_BYTES,
  PROJECT_LOGO_MAX_FILE_BYTES,
  PROJECT_LOGO_MAX_OUTPUT_BYTES,
  PROJECT_UPLOAD_BODY_MAX_BYTES,
  PROJECT_UPLOAD_MAX_AGGREGATE_BYTES,
  PROJECT_UPLOAD_MAX_CONTENT_FILE_BYTES,
  PROJECT_UPLOAD_MAX_FILES,
  PROJECT_UPLOAD_MAX_FILE_BYTES,
  PROJECT_UPLOAD_MAX_OUTPUT_AGGREGATE_BYTES,
  PROJECT_UPLOAD_MAX_OUTPUT_FILE_BYTES,
};

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
  if (CONTENT_MIME_PREFIXES.some((prefix) => file.type.startsWith(prefix))) return true;
  return false;
}

const projectUploadBodyLimit = bodyLimit({
  maxSize: PROJECT_UPLOAD_BODY_MAX_BYTES,
  onError: (c) => c.json({ error: "Upload request too large" }, 413),
});

const projectLogoBodyLimit = bodyLimit({
  maxSize: PROJECT_LOGO_BODY_MAX_BYTES,
  onError: (c) => c.json({ error: "Logo upload request too large" }, 413),
});

function projectFileErrorResponse(
  c: Context<{ Variables: Variables }>,
  error: unknown,
): Response | null {
  if (error instanceof ProjectGithubBindingChangedError) {
    return c.json({ error: error.message, code: "project_binding_changed" }, 409);
  }
  if (!(error instanceof ProjectFilePathError)) return null;
  if (error.code === "NOT_FOUND") return c.json({ error: "Not found" }, 404);
  return c.json({ error: "Invalid path" }, 400);
}

function detectProjectFramework(repoPath: string): ReturnType<typeof detectFramework> {
  try {
    // detectFramework reads package.json internally. Verify the same target
    // through the confined descriptor path first so a committed symlink
    // cannot redirect that read outside the checkout.
    readProjectFile(repoPath, "package.json");
  } catch (error) {
    if (!(error instanceof ProjectFilePathError) || error.code !== "NOT_FOUND") throw error;
  }
  return detectFramework(repoPath);
}

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
    const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
      expectedBindingGeneration: p.githubBindingGeneration,
    });
    let buf: Buffer;
    try {
      buf = await runInProjectLock(projectId, async () => readProjectFile(repoPath, rel), p);
    } catch (error) {
      const response = projectFileErrorResponse(c, error);
      if (response) return response;
      throw error;
    }
    const ext = path.extname(rel).toLowerCase().slice(1);
    const mime: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
      avif: "image/avif",
    };
    const headers: Record<string, string> = {
      "content-type": mime[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    };
    if (ext === "svg") {
      // Repository-controlled SVG can contain scripts. If it is navigated to
      // directly, keep it in an opaque sandbox with every resource disabled.
      headers["content-security-policy"] = "sandbox; default-src 'none'";
    }
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers,
    });
  })
  .get("/:id/framework", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    if (m.role === "client") return c.json({ error: "Forbidden" }, 403);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
      expectedBindingGeneration: p.githubBindingGeneration,
    });
    try {
      const fw = await runInProjectLock(projectId, async () => detectProjectFramework(repoPath), p);
      return c.json(fw);
    } catch (error) {
      const response = projectFileErrorResponse(c, error);
      if (response) return response;
      throw error;
    }
  })
  .post("/:id/upload", projectUploadBodyLimit, async (c) => {
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

    const allFiles = Object.values(body).flatMap((value) =>
      (Array.isArray(value) ? value : [value]).filter((item): item is File => item instanceof File),
    );
    if (allFiles.length > PROJECT_UPLOAD_MAX_FILES) {
      return c.json({ error: `Upload at most ${PROJECT_UPLOAD_MAX_FILES} files at once` }, 413);
    }
    let aggregateInputBytes = 0;
    for (const file of allFiles) {
      if (file.size > PROJECT_UPLOAD_MAX_FILE_BYTES) {
        return c.json({ error: "Files must be 5 MB or smaller" }, 413);
      }
      aggregateInputBytes += file.size;
      if (aggregateInputBytes > PROJECT_UPLOAD_MAX_AGGREGATE_BYTES) {
        return c.json({ error: "Combined upload must be 20 MB or smaller" }, 413);
      }
    }

    const files: File[] = candidates.filter((f): f is File => f instanceof File);
    if (files.length === 0) return c.json({ error: "Expected files field" }, 400);
    for (const file of files) {
      if (
        !file.type.startsWith("image/") &&
        isContentFile(file) &&
        file.size > PROJECT_UPLOAD_MAX_CONTENT_FILE_BYTES
      ) {
        return c.json({ error: "Content files must be 1 MB or smaller" }, 413);
      }
    }

    const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
      expectedBindingGeneration: p.githubBindingGeneration,
    });
    let fw: ReturnType<typeof detectFramework>;
    try {
      fw = await runInProjectLock(projectId, async () => detectProjectFramework(repoPath), p);
    } catch (error) {
      const response = projectFileErrorResponse(c, error);
      if (response) return response;
      throw error;
    }
    // EVERY chat upload lands in `.quillra-temp/` first. The folder is
    // ignored via .git/info/exclude so files never show up in a commit
    // unless the agent explicitly promotes them to a real asset path
    // (public/, src/content/, etc.). This solves the "reference-only
    // screenshot ends up pushed to GitHub" problem, the agent decides
    // per-file whether the attachment is a real asset for the site or
    // just context for the conversation.
    type UploadItem = {
      path: string;
      originalName: string;
      bytes: number;
      contentType: string;
      kind: "image" | "content";
    };
    type PreparedUpload = {
      filename: string;
      contents: Buffer;
      item: UploadItem;
    };
    const preparedUploads: PreparedUpload[] = [];
    let aggregateOutputBytes = 0;

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
        try {
          if (fw.optimizes) {
            const sharpOptions = { limitInputPixels: PROJECT_IMAGE_MAX_INPUT_PIXELS };
            const meta = await sharp(inputBuf, sharpOptions).metadata();
            const isJpeg = meta.format === "jpeg";
            const isPng = meta.format === "png";
            const pipeline = sharp(inputBuf, sharpOptions)
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
            outBuf = await processUploadToWebP(inputBuf, PROJECT_IMAGE_MAX_INPUT_PIXELS);
            ext = "webp";
            contentType = "image/webp";
          }
        } catch {
          return c.json({ error: "Could not process image" }, 400);
        }
        if (outBuf.length > PROJECT_UPLOAD_MAX_OUTPUT_FILE_BYTES) {
          return c.json({ error: "Processed image is too large" }, 413);
        }
        aggregateOutputBytes += outBuf.length;
        if (aggregateOutputBytes > PROJECT_UPLOAD_MAX_OUTPUT_AGGREGATE_BYTES) {
          return c.json({ error: "Combined processed upload is too large" }, 413);
        }
        const filename = `${stem}-${id}.${ext}`;
        preparedUploads.push({
          filename,
          contents: outBuf,
          item: {
            path: `${QUILLRA_TEMP_DIR}/${filename}`,
            originalName: file.name,
            bytes: outBuf.length,
            contentType,
            kind: "image",
          },
        });
      } else {
        // Content file: keep the original extension, just sanitize the stem
        const stem = safeStem(file.name, "content");
        const rawExt = (file.name.split(".").pop() ?? "txt").toLowerCase();
        const ext = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : "txt";
        const filename = `${stem}-${id}.${ext}`;
        aggregateOutputBytes += inputBuf.length;
        if (aggregateOutputBytes > PROJECT_UPLOAD_MAX_OUTPUT_AGGREGATE_BYTES) {
          return c.json({ error: "Combined processed upload is too large" }, 413);
        }
        preparedUploads.push({
          filename,
          contents: inputBuf,
          item: {
            path: `${QUILLRA_TEMP_DIR}/${filename}`,
            originalName: file.name,
            bytes: inputBuf.length,
            contentType: file.type || "text/plain",
            kind: "content",
          },
        });
      }
    }

    if (preparedUploads.length === 0) {
      return c.json({ error: "No supported files in upload" }, 400);
    }

    try {
      await runInProjectLock(
        projectId,
        async () => {
          try {
            assertProjectDirectory(repoPath, ".git");
          } catch (error) {
            if (error instanceof ProjectFilePathError) {
              throw new Error("Project workspace changed during upload. Please retry.");
            }
            throw error;
          }
          ensureProjectGitExclude(repoPath, QUILLRA_TEMP_DIR);
          ensureProjectDirectory(repoPath, QUILLRA_TEMP_DIR);
          for (const upload of preparedUploads) {
            writeProjectFile(repoPath, `${QUILLRA_TEMP_DIR}/${upload.filename}`, upload.contents);
          }
        },
        p,
      );
    } catch (error) {
      const response = projectFileErrorResponse(c, error);
      if (response) return response;
      throw error;
    }

    const items = preparedUploads.map(({ item }) => item);
    return c.json({ items, framework: fw });
  })
  .post("/:id/asset-delete", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    if (m.role === "client") return c.json({ error: "Forbidden" }, 403);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
    const rel = body?.path?.replace(/^\/+/, "");
    if (!rel) return c.json({ error: "path required" }, 400);
    const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
      expectedBindingGeneration: p.githubBindingGeneration,
    });
    try {
      await runInProjectLock(
        projectId,
        async () => {
          deleteProjectFile(repoPath, rel);
        },
        p,
      );
    } catch (error) {
      const response = projectFileErrorResponse(c, error);
      if (response) return response;
      throw error;
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
  .post("/:id/logo", projectLogoBodyLimit, async (c) => {
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
    if (file.size > PROJECT_LOGO_MAX_FILE_BYTES) {
      return c.json({ error: "Image too large (max 5 MB)" }, 413);
    }

    const inputBuf = Buffer.from(await file.arrayBuffer());
    let outBuf: Buffer;
    try {
      outBuf = await sharp(inputBuf, {
        limitInputPixels: PROJECT_IMAGE_MAX_INPUT_PIXELS,
      })
        .rotate() // honour EXIF
        .resize(256, 256, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({ compressionLevel: 9 })
        .toBuffer();
    } catch {
      return c.json({ error: "Could not process image" }, 400);
    }
    if (outBuf.length > PROJECT_LOGO_MAX_OUTPUT_BYTES) {
      return c.json({ error: "Processed logo is too large" }, 413);
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
