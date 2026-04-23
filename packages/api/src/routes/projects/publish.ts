import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { simpleGit } from "simple-git";
import { db } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import { getInstanceSetting } from "../../services/instance-settings.js";
import { ensureRepoCloned, projectRepoPath, pushToGitHub } from "../../services/workspace.js";
import { type Variables, memberForProject, requireUser } from "./shared.js";

export const publishRouter = new Hono<{ Variables: Variables }>()
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
      } catch {
        /* no remote yet */
      }
      const hasChanges = dirty.length > 0 || unpushed > 0;

      // Generate a plain-English summary using Claude. This is the
      // expensive call (an API round-trip and tokens), only run it when
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
                messages: [
                  {
                    role: "user",
                    content: `Summarize these website changes for a non-technical person. Write exactly 1-3 bullet points using markdown "- " syntax (dash space). Each bullet on its own line. Be specific (e.g. "Updated the homepage title"). No headings, no code, no filenames. Example format:\n- Changed the hero text\n- Added a new page\n\nChanged files:\n${dirty.join("\n")}\n\nDiff summary:\n${diffOutput.slice(0, 1000)}`,
                  },
                ],
              }),
            });
            if (res.ok) {
              const body = (await res.json()) as { content?: { text?: string }[] };
              summary = body.content?.[0]?.text ?? "";
            }
          }
        } catch {
          /* summary is optional */
        }
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
   * "changes pill" in ProjectHeader, the pill itself polls the
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
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
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
      const pushFile = async (path: string, fileStatus: FileChange["status"]) => {
        if (seen.has(path)) return;
        seen.add(path);
        let diff = "";
        let isBinary = false;
        try {
          if (fileStatus === "untracked") {
            diff = await g.raw(["diff", "--no-index", "--", "/dev/null", path]).catch(() => "");
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
          diff = `${diff.slice(0, 200_000)}\n… (truncated)`;
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
   * `.git/info/exclude`, so anything in `.quillra-temp/` survives. We
   * register that folder with the local exclude in ensureQuillraTempIgnored()
   * precisely so that chat scratch assets don't get nuked by a discard.
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
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    try {
      const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
      const g = simpleGit(repoPath);
      // Make sure we know the latest state of the remote before resetting
      // onto it. Failure here is non-fatal, we can still hard-reset to
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
      // directories. We deliberately do NOT pass `-x`, that would
      // also wipe ignored files, including `.quillra-temp/` contents.
      await g.clean("fd");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Discard failed" }, 500);
    }
  })
  /**
   * Manually clear the `migration_target` flag on a project. Used by
   * the "Cancel migration" link inside the MigrationBanner when a
   * migration run got stuck, server restart mid-stream, agent error
   * that never reached `done`, OOM kill, etc. Normally the WS handler
   * clears the flag itself when the SDK emits a clean `done`, but any
   * abnormal termination leaves the row flagged and the UI locked.
   * This endpoint is the frontend-reachable escape hatch the user
   * asked for: "never stuck, always resolveable via the frontend".
   *
   * Also drops any partial workspace files the half-run agent left
   * behind via `git clean -fd` + `git reset --hard` so the user
   * doesn't open to a broken half-migrated repo. This is safe
   * because the migration was going to rewrite everything anyway,
   * and the old tree lives on in origin/<branch>.
   */
  .post("/:id/cancel-migration", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m || (m.role !== "admin" && m.role !== "editor")) {
      return c.json({ error: "Only editors and admins can cancel migrations." }, 403);
    }
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    try {
      await db
        .update(projects)
        .set({ migrationTarget: null, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      // Best-effort: roll the workspace back to origin so the next
      // chat message doesn't see half-written Astro files mixed with
      // the old framework. If the workspace isn't cloned yet or the
      // remote branch doesn't exist, that's fine, the agent will
      // start fresh next time anyway.
      try {
        const repoPath = projectRepoPath(projectId);
        if (fs.existsSync(path.join(repoPath, ".git"))) {
          const g = simpleGit(repoPath);
          await g.fetch("origin", p.defaultBranch).catch(() => undefined);
          const branches = await g.branch(["-r"]).catch(() => ({ all: [] as string[] }));
          if (branches.all.includes(`origin/${p.defaultBranch}`)) {
            await g.reset(["--hard", `origin/${p.defaultBranch}`]).catch(() => undefined);
          }
          await g.clean("fd").catch(() => undefined);
        }
      } catch {
        /* best-effort; flag is already cleared which is what unblocks the UI */
      }
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Cancel failed" }, 500);
    }
  })
  .post("/:id/publish", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    // Every project member can publish. Clients and translators see the
    // button too: "I'm done, put it live" is the end of their workflow.
    // The security boundary remains the per-role agent tool allow-list,
    // publish itself is just a git push of whatever the agent already
    // committed during chat.
    if (!m) {
      return c.json({ error: "You are not a member of this project." }, 403);
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
  });
