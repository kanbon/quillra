import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db/index.js";
import { projectMembers, projects } from "../../db/schema.js";
import { clearProjectRepoClone } from "../../services/workspace.js";
import { type Variables, memberForProject, requireUser } from "./shared.js";

export const crudRouter = new Hono<{ Variables: Variables }>()
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
      // Optional flag, set to "astro" if the user ticked the
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
      brandDisplayName: p.brandDisplayName,
      brandAccentColor: p.brandAccentColor,
      groupId: p.groupId,
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
      githubRepoFullName: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/)
        .optional(),
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
      brandDisplayName: z.string().max(120).nullable().optional(),
      brandAccentColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Hex color like #C1121F")
        .nullable()
        .optional(),
      groupId: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const patch: {
      name?: string;
      previewDevCommand?: string | null;
      githubRepoFullName?: string;
      defaultBranch?: string;
      logoUrl?: string | null;
      brandDisplayName?: string | null;
      brandAccentColor?: string | null;
      groupId?: string | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.previewDevCommand !== undefined)
      patch.previewDevCommand = parsed.data.previewDevCommand;
    if (parsed.data.githubRepoFullName !== undefined)
      patch.githubRepoFullName = parsed.data.githubRepoFullName;
    if (parsed.data.defaultBranch !== undefined) patch.defaultBranch = parsed.data.defaultBranch;
    if (parsed.data.logoUrl !== undefined) patch.logoUrl = parsed.data.logoUrl;
    if (parsed.data.brandDisplayName !== undefined)
      patch.brandDisplayName = parsed.data.brandDisplayName?.trim() || null;
    if (parsed.data.brandAccentColor !== undefined)
      patch.brandAccentColor = parsed.data.brandAccentColor?.trim() || null;
    if (parsed.data.groupId !== undefined) patch.groupId = parsed.data.groupId || null;

    const repoChanged =
      patch.githubRepoFullName !== undefined &&
      patch.githubRepoFullName !== existing.githubRepoFullName;
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
  });
