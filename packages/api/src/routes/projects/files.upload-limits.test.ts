import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../lib/auth.js";

const workspaceMocks = vi.hoisted(() => ({
  ensureRepoCloned: vi.fn(),
  runInProjectLock: vi.fn(),
}));

const frameworkMocks = vi.hoisted(() => ({
  detectFramework: vi.fn(),
}));

const sharpMocks = vi.hoisted(() => ({
  sharp: vi.fn(),
  metadata: vi.fn(),
  toBuffer: vi.fn(),
}));

vi.mock("../../services/workspace.js", () => ({
  QUILLRA_TEMP_DIR: ".quillra-temp",
  ...workspaceMocks,
}));
vi.mock("../../services/framework.js", () => frameworkMocks);
vi.mock("sharp", () => ({ default: sharpMocks.sharp }));

const originalDatabaseUrl = process.env.DATABASE_URL;
let tempDirectory: string;
let repoPath: string;
let lockActive = false;
let openDatabase: typeof import("../../db/index.js")["rawSqlite"] | null = null;

beforeEach(() => {
  tempDirectory = realpathSync.native(mkdtempSync(path.join(tmpdir(), "quillra-upload-limits-")));
  repoPath = path.join(tempDirectory, "repo");
  mkdirSync(path.join(repoPath, ".git"), { recursive: true });
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  lockActive = false;
  workspaceMocks.ensureRepoCloned.mockReset();
  workspaceMocks.runInProjectLock.mockReset();
  workspaceMocks.ensureRepoCloned.mockResolvedValue(repoPath);
  workspaceMocks.runInProjectLock.mockImplementation(
    async (_projectId: string, operation: () => Promise<unknown> | unknown) => {
      expect(lockActive).toBe(false);
      lockActive = true;
      try {
        return await operation();
      } finally {
        lockActive = false;
      }
    },
  );
  frameworkMocks.detectFramework.mockReset();
  frameworkMocks.detectFramework.mockImplementation(() => {
    expect(lockActive).toBe(true);
    return {
      id: "generic",
      label: "Generic",
      iconSlug: "html5",
      color: "#737373",
      assetsDir: "images",
      optimizes: true,
    };
  });
  sharpMocks.metadata.mockReset().mockResolvedValue({ format: "png" });
  sharpMocks.toBuffer.mockReset().mockResolvedValue(Buffer.from("processed"));
  sharpMocks.sharp.mockReset().mockImplementation(() => {
    const pipeline = {
      metadata: sharpMocks.metadata,
      rotate: vi.fn(),
      resize: vi.fn(),
      jpeg: vi.fn(),
      png: vi.fn(),
      webp: vi.fn(),
      toBuffer: sharpMocks.toBuffer,
    };
    pipeline.rotate.mockReturnValue(pipeline);
    pipeline.resize.mockReturnValue(pipeline);
    pipeline.jpeg.mockReturnValue(pipeline);
    pipeline.png.mockReturnValue(pipeline);
    pipeline.webp.mockReturnValue(pipeline);
    return pipeline;
  });
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.resetModules();
  vi.restoreAllMocks();
  if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, "DATABASE_URL");
  else process.env.DATABASE_URL = originalDatabaseUrl;
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function createApp() {
  vi.resetModules();
  const [{ rawSqlite }, filesModule] = await Promise.all([
    import("../../db/index.js"),
    import("./files.js"),
  ]);
  openDatabase = rawSqlite;
  const now = Date.now();
  rawSqlite
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('owner-1', 'Owner', 'owner@example.com', 1, ?, ?)`,
    )
    .run(now, now);
  rawSqlite
    .prepare(
      `INSERT INTO projects
         (id, name, github_repo_full_name, default_branch, created_at, updated_at)
       VALUES ('project-1', 'Project One', 'example/site', 'main', ?, ?)`,
    )
    .run(now, now);
  rawSqlite
    .prepare(
      `INSERT INTO project_members (id, project_id, user_id, role, created_at)
       VALUES ('membership-1', 'project-1', 'owner-1', 'admin', ?)`,
    )
    .run(now);

  type Variables = {
    user: SessionUser | null;
    clientSession: { projectId: string } | null;
  };
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "owner-1",
      name: "Owner",
      email: "owner@example.com",
    } as SessionUser);
    c.set("clientSession", null);
    await next();
  });
  app.route("/projects", filesModule.filesRouter);
  return { app, filesModule };
}

describe("project upload limits", () => {
  it("rejects an oversized Content-Length before parsing the body", async () => {
    const { app, filesModule } = await createApp();
    const response = await app.request("/projects/project-1/upload", {
      method: "POST",
      headers: {
        "content-length": String(filesModule.PROJECT_UPLOAD_BODY_MAX_BYTES + 1),
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array([1]),
    });

    expect(response.status).toBe(413);
    expect(workspaceMocks.ensureRepoCloned).not.toHaveBeenCalled();
  });

  it("counts streamed bytes when Content-Length is missing", async () => {
    const { app, filesModule } = await createApp();
    const chunk = new Uint8Array(Math.floor(filesModule.PROJECT_UPLOAD_BODY_MAX_BYTES / 2) + 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request("http://localhost/projects/project-1/upload", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.has("content-length")).toBe(false);

    const response = await app.request(request);

    expect(response.status).toBe(413);
    expect(workspaceMocks.ensureRepoCloned).not.toHaveBeenCalled();
  });

  it("rejects too many files before cloning or decoding them", async () => {
    const { app, filesModule } = await createApp();
    const form = new FormData();
    for (let index = 0; index <= filesModule.PROJECT_UPLOAD_MAX_FILES; index++) {
      form.append("files", new File(["x"], `copy-${index}.md`, { type: "text/markdown" }));
    }

    const response = await app.request("/projects/project-1/upload", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(413);
    expect(workspaceMocks.ensureRepoCloned).not.toHaveBeenCalled();
  });

  it("rejects files whose combined size exceeds the aggregate limit", async () => {
    const { app, filesModule } = await createApp();
    const form = new FormData();
    const fileBytes = Math.floor(filesModule.PROJECT_UPLOAD_MAX_AGGREGATE_BYTES / 5) + 1;
    for (let index = 0; index < 5; index++) {
      form.append(
        "files",
        new File([new Uint8Array(fileBytes)], `image-${index}.png`, { type: "image/png" }),
      );
    }

    const response = await app.request("/projects/project-1/upload", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(413);
    expect(workspaceMocks.ensureRepoCloned).not.toHaveBeenCalled();
  });

  it("detects the framework under the project lock before preparing an upload", async () => {
    const { app } = await createApp();
    const form = new FormData();
    form.set("file", new File(["# Copy"], "copy.md", { type: "text/markdown" }));

    const response = await app.request("/projects/project-1/upload", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    expect(frameworkMocks.detectFramework).toHaveBeenCalledWith(repoPath);
    expect(workspaceMocks.runInProjectLock).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized content and image files before arrayBuffer or Sharp", async () => {
    const { app, filesModule } = await createApp();
    const content = new File(
      [new Uint8Array(filesModule.PROJECT_UPLOAD_MAX_CONTENT_FILE_BYTES + 1)],
      "copy.md",
      { type: "text/markdown" },
    );
    const contentArrayBuffer = vi.spyOn(content, "arrayBuffer");
    const contentForm = new FormData();
    contentForm.set("files", content);

    const contentResponse = await app.request("/projects/project-1/upload", {
      method: "POST",
      body: contentForm,
    });

    expect(contentResponse.status).toBe(413);
    expect(contentArrayBuffer).not.toHaveBeenCalled();

    const image = new File(
      [new Uint8Array(filesModule.PROJECT_UPLOAD_MAX_FILE_BYTES + 1)],
      "image.png",
      { type: "image/png" },
    );
    const imageArrayBuffer = vi.spyOn(image, "arrayBuffer");
    const imageForm = new FormData();
    imageForm.set("files", image);

    const imageResponse = await app.request("/projects/project-1/upload", {
      method: "POST",
      body: imageForm,
    });

    expect(imageResponse.status).toBe(413);
    expect(imageArrayBuffer).not.toHaveBeenCalled();
    expect(workspaceMocks.ensureRepoCloned).not.toHaveBeenCalled();
    expect(sharpMocks.sharp).not.toHaveBeenCalled();
  });

  it("caps each processed image before retaining or writing it", async () => {
    const { app, filesModule } = await createApp();
    sharpMocks.toBuffer.mockResolvedValue(
      Buffer.alloc(filesModule.PROJECT_UPLOAD_MAX_OUTPUT_FILE_BYTES + 1),
    );
    const form = new FormData();
    form.set("file", new File(["image"], "image.png", { type: "image/png" }));

    const response = await app.request("/projects/project-1/upload", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(413);
    expect(workspaceMocks.runInProjectLock).toHaveBeenCalledTimes(1);
    expect(sharpMocks.sharp).toHaveBeenCalledWith(expect.any(Buffer), {
      limitInputPixels: filesModule.PROJECT_IMAGE_MAX_INPUT_PIXELS,
    });
  });

  it("caps the aggregate prepared output before writing it", async () => {
    const { app, filesModule } = await createApp();
    const outputBytes = Math.floor(filesModule.PROJECT_UPLOAD_MAX_OUTPUT_AGGREGATE_BYTES / 3) + 1;
    sharpMocks.toBuffer.mockResolvedValue(Buffer.alloc(outputBytes));
    const form = new FormData();
    for (let index = 0; index < 3; index++) {
      form.append("files", new File(["image"], `image-${index}.png`, { type: "image/png" }));
    }

    const response = await app.request("/projects/project-1/upload", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(413);
    expect(workspaceMocks.runInProjectLock).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized logos before arrayBuffer or Sharp", async () => {
    const { app, filesModule } = await createApp();
    const logo = new File(
      [new Uint8Array(filesModule.PROJECT_LOGO_MAX_FILE_BYTES + 1)],
      "logo.png",
      { type: "image/png" },
    );
    const arrayBuffer = vi.spyOn(logo, "arrayBuffer");
    const form = new FormData();
    form.set("file", logo);

    const response = await app.request("/projects/project-1/logo", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(413);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(sharpMocks.sharp).not.toHaveBeenCalled();
  });

  it("passes a conservative pixel ceiling to Sharp for logos", async () => {
    const { app, filesModule } = await createApp();
    const form = new FormData();
    form.set("file", new File(["image"], "logo.png", { type: "image/png" }));

    const response = await app.request("/projects/project-1/logo", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    expect(sharpMocks.sharp).toHaveBeenCalledWith(expect.any(Buffer), {
      limitInputPixels: filesModule.PROJECT_IMAGE_MAX_INPUT_PIXELS,
    });
  });

  it("serves repository SVG with nosniff and an opaque restrictive sandbox", async () => {
    const { app } = await createApp();
    writeFileSync(
      path.join(repoPath, "untrusted.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );

    const response = await app.request("/projects/project-1/file?path=untrusted.svg");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});
