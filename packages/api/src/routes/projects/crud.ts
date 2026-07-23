import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db/index.js";
import { projectMembers, projects } from "../../db/schema.js";
import { getProjectBrandContext } from "../../services/branding.js";
import { listBranches } from "../../services/github-rest.js";
import {
  GithubConnectionRequiredError,
  GithubRepositoryAccessError,
  getGithubRepositoryForUser,
} from "../../services/github-user-connection.js";
import {
  beginProjectDeletion,
  cancelProjectDeletion,
  clearProjectRepoClone,
  scheduleDeletedProjectWorkspaceCleanup,
} from "../../services/workspace.js";
import { type Variables, memberForProject, requireUser } from "./shared.js";

const githubIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .max(30);
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const branchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith("-") && !hasControlCharacters(value), {
    message: "Invalid Git branch name",
  });

async function verifyRepositorySelection(args: {
  userId: string;
  installationId: string;
  repositoryId: string;
  branch?: string;
}) {
  const repository = await getGithubRepositoryForUser(
    args.userId,
    args.installationId,
    args.repositoryId,
  );
  const branch = args.branch ?? repository.defaultBranch;
  const parsedBranch = branchSchema.safeParse(branch);
  if (!parsedBranch.success) throw new GithubRepositoryAccessError("Invalid Git branch.");
  const branches = await listBranches(args.userId, repository);
  if (!branches.includes(parsedBranch.data)) {
    throw new GithubRepositoryAccessError(
      "The selected branch is not available through your GitHub connection.",
    );
  }
  return { repository, branch: parsedBranch.data };
}

function githubSelectionError(error: unknown): {
  status: 403 | 409;
  body: { error: string; code: string; connectUrl?: string };
} | null {
  if (error instanceof GithubConnectionRequiredError) {
    return {
      status: 409,
      body: {
        error: error.message,
        code: error.code,
        connectUrl: "/api/github/connect/start?returnTo=/",
      },
    };
  }
  if (error instanceof GithubRepositoryAccessError) {
    return { status: 403, body: { error: error.message, code: error.code } };
  }
  return null;
}

export const crudRouter = new Hono<{ Variables: Variables }>()
  .get("/", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const membershipFilter = r.clientSession
      ? and(
          eq(projectMembers.userId, r.user.id),
          eq(projectMembers.projectId, r.clientSession.projectId),
        )
      : eq(projectMembers.userId, r.user.id);
    const rows = await db
      .select({
        project: projects,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(membershipFilter)
      .orderBy(desc(projects.updatedAt));

    return c.json({
      projects: rows.map(({ project, role }) => ({
        id: project.id,
        name: project.name,
        githubRepoFullName: project.githubRepoFullName,
        defaultBranch: project.defaultBranch,
        githubConnectionRequired: !project.githubInstallationId || !project.githubRepositoryId,
        role,
        updatedAt: project.updatedAt.getTime(),
      })),
    });
  })
  .post("/", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    if (r.clientSession) return c.json({ error: "Forbidden" }, 403);
    const body = await c.req.json().catch(() => null);
    const schema = z
      .object({
        name: z.string().min(1).max(200),
        // Kept in the request shape for old clients, but never trusted. The
        // canonical name comes from GitHub after checking immutable ids.
        githubRepoFullName: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .optional(),
        githubInstallationId: githubIdSchema,
        githubRepositoryId: githubIdSchema,
        defaultBranch: branchSchema.optional(),
        previewDevCommand: z.string().max(2000).nullable().optional(),
        // Optional flag, set to "astro" if the user ticked the
        // "Convert to Astro" card in ConnectProjectModal. Kicks off a
        // migration agent run on project open.
        migrationTarget: z.enum(["astro"]).nullable().optional(),
      })
      .strict();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    let selection: Awaited<ReturnType<typeof verifyRepositorySelection>>;
    try {
      selection = await verifyRepositorySelection({
        userId: r.user.id,
        installationId: parsed.data.githubInstallationId,
        repositoryId: parsed.data.githubRepositoryId,
        branch: parsed.data.defaultBranch,
      });
    } catch (error) {
      const mapped = githubSelectionError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }

    const id = nanoid();
    const now = new Date();
    await db.insert(projects).values({
      id,
      name: parsed.data.name,
      githubRepoFullName: selection.repository.fullName,
      githubInstallationId: selection.repository.installationId,
      githubRepositoryId: selection.repository.repositoryId,
      defaultBranch: selection.branch,
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
  .post("/:id/github/rebind", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    if (r.clientSession) return c.json({ error: "Forbidden" }, 403);
    const projectId = c.req.param("id");
    const membership = await memberForProject(r.user.id, projectId);
    if (!membership || membership.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    const [existing] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        githubInstallationId: githubIdSchema,
        githubRepositoryId: githubIdSchema,
        defaultBranch: branchSchema.optional(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    let selection: Awaited<ReturnType<typeof verifyRepositorySelection>>;
    try {
      selection = await verifyRepositorySelection({
        userId: r.user.id,
        installationId: parsed.data.githubInstallationId,
        repositoryId: parsed.data.githubRepositoryId,
        branch: parsed.data.defaultBranch,
      });
    } catch (error) {
      const mapped = githubSelectionError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }

    await clearProjectRepoClone(projectId, undefined, async () => {
      await db
        .update(projects)
        .set({
          githubRepoFullName: selection.repository.fullName,
          githubInstallationId: selection.repository.installationId,
          githubRepositoryId: selection.repository.repositoryId,
          githubBindingGeneration: sql`${projects.githubBindingGeneration} + 1`,
          defaultBranch: selection.branch,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));
    });
    return c.json({
      ok: true,
      githubRepoFullName: selection.repository.fullName,
      githubInstallationId: selection.repository.installationId,
      githubRepositoryId: selection.repository.repositoryId,
      defaultBranch: selection.branch,
    });
  })
  .get("/:id", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Not found" }, 404);
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    const brandContext = await getProjectBrandContext(projectId, new URL(c.req.url).host || null);
    return c.json({
      id: p.id,
      name: p.name,
      githubRepoFullName: p.githubRepoFullName,
      githubInstallationId: p.githubInstallationId,
      githubRepositoryId: p.githubRepositoryId,
      githubConnectionRequired: !p.githubInstallationId || !p.githubRepositoryId,
      defaultBranch: p.defaultBranch,
      previewDevCommand: p.previewDevCommand,
      logoUrl: p.logoUrl,
      brandDisplayName: p.brandDisplayName,
      brandAccentColor: p.brandAccentColor,
      groupId: p.groupId,
      instanceBrand: brandContext.instanceBrand,
      inheritedBrand: brandContext.inheritedBrand,
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
    const schema = z
      .object({
        name: z.string().min(1).max(200).optional(),
        previewDevCommand: z.string().max(2000).nullable().optional(),
        // Accepts either a real https URL or a data: URL (from the logo upload endpoint)
        logoUrl: z
          .string()
          .max(2_500_000) // ~2.5 MB upper bound for base64-encoded logos
          .refine(
            (v) =>
              v.startsWith("http://") || v.startsWith("https://") || v.startsWith("data:image/"),
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
      })
      .strict();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const patch: {
      name?: string;
      previewDevCommand?: string | null;
      logoUrl?: string | null;
      brandDisplayName?: string | null;
      brandAccentColor?: string | null;
      groupId?: string | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.previewDevCommand !== undefined)
      patch.previewDevCommand = parsed.data.previewDevCommand;
    if (parsed.data.logoUrl !== undefined) patch.logoUrl = parsed.data.logoUrl;
    if (parsed.data.brandDisplayName !== undefined)
      patch.brandDisplayName = parsed.data.brandDisplayName?.trim() || null;
    if (parsed.data.brandAccentColor !== undefined)
      patch.brandAccentColor = parsed.data.brandAccentColor?.trim() || null;
    if (parsed.data.groupId !== undefined) patch.groupId = parsed.data.groupId || null;

    await db.update(projects).set(patch).where(eq(projects.id, projectId));
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m || m.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    // Make the project unavailable to already-authorized in-flight workspace
    // requests before removing its source-of-truth row. Filesystem cleanup is
    // best-effort and happens second: a busy node_modules directory must never
    // turn a successful logical delete into a visible 500.
    beginProjectDeletion(projectId);
    try {
      await db.delete(projects).where(eq(projects.id, projectId));
    } catch (error) {
      cancelProjectDeletion(projectId);
      throw error;
    }
    void scheduleDeletedProjectWorkspaceCleanup(projectId);
    return c.newResponse(null, 204);
  });
