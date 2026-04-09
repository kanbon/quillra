import { Hono } from "hono";
import type { SessionUser } from "../lib/auth.js";
import {
  fetchRepoManifest,
  getRepoMeta,
  listAccessibleRepos,
  listBranches,
} from "../services/github-rest.js";
import { detectFromManifest, publicFrameworkList } from "../services/framework-registry.js";

type Variables = { user: SessionUser | null };

async function requireUser(c: { get: (k: "user") => SessionUser | null; json: (b: unknown, s: number) => Response }) {
  const user = c.get("user");
  if (!user) return { error: c.json({ error: "Unauthorized" }, 401) };
  return { user };
}

export const githubRouter = new Hono<{ Variables: Variables }>()
  .get("/repos", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    try {
      const repos = await listAccessibleRepos();
      return c.json({ repos });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to list repositories";
      // App not configured → 503 so the UI shows "install the GitHub App"
      return c.json({ error: msg }, msg.includes("GitHub App") ? 503 : 400);
    }
  })
  .get("/repos/:owner/:repo/branches", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    try {
      const branches = await listBranches(owner, repo);
      let defaultBranch: string | undefined;
      try {
        const meta = await getRepoMeta(owner, repo);
        defaultBranch = meta.defaultBranch;
      } catch {
        defaultBranch = branches.includes("main") ? "main" : branches[0];
      }
      return c.json({ branches, defaultBranch });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Failed to list branches" },
        400,
      );
    }
  })
  /**
   * Identify the framework of a GitHub repo at a given branch BEFORE the user
   * commits to creating a project. We fetch package.json + the root file list
   * via the GitHub API (no clone), then run it through the central registry.
   */
  .get("/repos/:owner/:repo/framework", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const ref = c.req.query("ref") ?? "";
    if (!ref) return c.json({ error: "ref query param required" }, 400);
    try {
      const manifest = await fetchRepoManifest(owner, repo, ref);
      const def = detectFromManifest(manifest);
      if (!def) {
        return c.json({
          supported: false,
          reason: "We couldn't recognise the framework in this repository.",
          rootFilesSample: manifest.rootFiles.slice(0, 20),
        });
      }
      return c.json({
        supported: true,
        framework: {
          id: def.id,
          label: def.label,
          iconSlug: def.iconSlug,
          color: def.color,
          blurb: def.blurb,
          optimizes: def.optimizes,
        },
      });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Failed to inspect repository" },
        400,
      );
    }
  })
  /** Public list of every framework Quillra supports — used by the connect modal and the badge */
  .get("/frameworks", async (c) => {
    return c.json({ frameworks: publicFrameworkList() });
  });
