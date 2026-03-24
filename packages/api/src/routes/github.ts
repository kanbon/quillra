import { Hono } from "hono";
import type { SessionUser } from "../lib/auth.js";
import { getRepoMeta, listAccessibleRepos, listBranches } from "../services/github-rest.js";

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
      return c.json(
        { error: e instanceof Error ? e.message : "Failed to list repositories" },
        e instanceof Error && e.message.includes("GITHUB_TOKEN") ? 503 : 400,
      );
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
  });
