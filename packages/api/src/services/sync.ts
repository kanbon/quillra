/**
 * Remote-sync helpers for the editor's "your team pushed while you were
 * away" flow.
 *
 * A project's workspace on disk can drift from origin/<branch> in two
 * ways: someone on the team pushed commits from outside Quillra
 * (remote-ahead), and/or the current user has uncommitted chat-turn
 * edits in the working tree (local-dirty). The editor calls these
 * helpers on load to figure out what to show:
 *
 *   in_sync                    nothing to do
 *   behind                     remote has new commits, working tree clean,
 *                              we fast-forward silently
 *   behind_with_local_changes  remote has new commits AND the user has
 *                              uncommitted changes; we surface a modal
 *                              with two choices
 *   ahead_only                 local has unpushed commits but remote is
 *                              unchanged; nothing to do (publish handles it)
 *
 * The conflict resolver (resolveMergeConflictsWithOpus) spins up a
 * separate one-shot agent with the strongest model and a tiny prompt,
 * strictly scoped to rewriting conflict-marker blocks and committing
 * the result. It runs outside the normal chat turn so the user's
 * conversation state isn't polluted.
 */

import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { buildConflictResolverCanUseTool } from "./agent-permissions.js";
import { createSafeSdkEnv } from "./child-process-env.js";
import { getInstanceSetting } from "./instance-settings.js";
import {
  authenticatedGitForProject,
  ensureRepoCloned,
  runInProjectLock,
  simpleGitForProject,
} from "./workspace.js";

export type LocalFileChange = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
};

export type RemoteCommit = {
  sha: string;
  shortSha: string;
  author: string;
  message: string;
  when: number;
};

export type SyncStatus =
  | { state: "in_sync" }
  | {
      state: "ahead_only";
      localAhead: number;
    }
  | {
      state: "behind";
      remoteAhead: number;
      remoteCommits: RemoteCommit[];
    }
  | {
      state: "behind_with_local_changes";
      remoteAhead: number;
      remoteCommits: RemoteCommit[];
      localChanges: LocalFileChange[];
    };

async function loadProject(projectId: string) {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) throw new Error("Project not found");
  return p;
}

function mapPorcelainStatus(code: string): LocalFileChange["status"] {
  // `git status --porcelain` two-char codes, X = index, Y = worktree
  if (code === "??") return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

/**
 * Inspect the workspace and remote for this project. Runs a single
 * `git fetch` against origin before comparing so the answer isn't stale.
 * Safe to call often; the result is a snapshot, not a mutation.
 */
export async function getSyncStatus(projectId: string): Promise<SyncStatus> {
  const p = await loadProject(projectId);
  const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
    expectedBindingGeneration: p.githubBindingGeneration,
  });
  return runInProjectLock(
    p.id,
    async () => {
      const networkGit = await authenticatedGitForProject(p.id, repoPath, p.githubRepoFullName);
      const g = simpleGitForProject(repoPath);

      try {
        await networkGit.fetch("origin", p.defaultBranch);
      } catch {
        // Network hiccups shouldn't block the editor; fall through with
        // whatever we last knew about the remote. The sync modal will
        // effectively be hidden, which is the safe default.
      }

      const remoteRef = `origin/${p.defaultBranch}`;
      const remoteKnown = (await g.branch(["-r"])).all.includes(remoteRef);
      if (!remoteKnown) return { state: "in_sync" };

      // Porcelain status for both tracked and untracked changes.
      const statusRaw = await g.raw(["status", "--porcelain=v1"]);
      const localChanges: LocalFileChange[] = statusRaw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const code = line.slice(0, 2);
          const pathPart = line.slice(3).trim();
          // Renames look like "old -> new"; keep the new path.
          const filePath = pathPart.includes(" -> ")
            ? (pathPart.split(" -> ")[1] ?? pathPart)
            : pathPart;
          return { path: filePath, status: mapPorcelainStatus(code) };
        });

      // Commit counts in each direction.
      const ahead = Number(
        (await g.raw(["rev-list", "--count", `${remoteRef}..HEAD`])).trim() || "0",
      );
      const behind = Number(
        (await g.raw(["rev-list", "--count", `HEAD..${remoteRef}`])).trim() || "0",
      );

      if (behind === 0 && ahead === 0 && localChanges.length === 0) {
        return { state: "in_sync" };
      }
      if (behind === 0 && ahead === 0 && localChanges.length > 0) {
        // Locally dirty only; treated as in_sync for the load-time prompt.
        // The publish flow handles these commits when the user ships.
        return { state: "in_sync" };
      }
      if (behind === 0 && ahead > 0) {
        return { state: "ahead_only", localAhead: ahead };
      }

      // Remote has new commits. Capture them for the modal.
      const logRaw = await g.raw([
        "log",
        `HEAD..${remoteRef}`,
        "--pretty=format:%H%x00%an%x00%s%x00%ct",
      ]);
      const remoteCommits: RemoteCommit[] = logRaw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha = "", author = "", message = "", ct = "0"] = line.split("\u0000");
          return {
            sha,
            shortSha: sha.slice(0, 7),
            author,
            message,
            when: Number(ct) * 1000,
          };
        });

      if (localChanges.length === 0) {
        return { state: "behind", remoteAhead: behind, remoteCommits };
      }
      return {
        state: "behind_with_local_changes",
        remoteAhead: behind,
        remoteCommits,
        localChanges,
      };
    },
    p,
  );
}

type GitActor = { name: string; email: string };

/**
 * Fast-forward silently when the working tree is clean. Used after a
 * behind-no-local-changes sync status.
 */
export async function fastForwardPull(projectId: string): Promise<{ pulled: number }> {
  const p = await loadProject(projectId);
  const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
    expectedBindingGeneration: p.githubBindingGeneration,
  });
  return runInProjectLock(
    p.id,
    async () => {
      const networkGit = await authenticatedGitForProject(p.id, repoPath, p.githubRepoFullName);
      await networkGit.fetch("origin", p.defaultBranch);
      const g = simpleGitForProject(repoPath);
      const before = (await g.revparse(["HEAD"])).trim();
      await g.raw(["merge", "--ff-only", `origin/${p.defaultBranch}`]);
      const after = (await g.revparse(["HEAD"])).trim();
      if (before === after) return { pulled: 0 };
      const count = Number(
        (await g.raw(["rev-list", "--count", `${before}..${after}`])).trim() || "0",
      );
      return { pulled: count };
    },
    p,
  );
}

/**
 * Throw away local changes and hard-reset onto origin. Called when the
 * user picks "Discard my changes" in the sync modal.
 */
export async function discardAndReset(projectId: string): Promise<void> {
  const p = await loadProject(projectId);
  const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
    expectedBindingGeneration: p.githubBindingGeneration,
  });
  await runInProjectLock(
    p.id,
    async () => {
      const networkGit = await authenticatedGitForProject(p.id, repoPath, p.githubRepoFullName);
      await networkGit.fetch("origin", p.defaultBranch);
      const g = simpleGitForProject(repoPath);
      await g.reset(["--hard", `origin/${p.defaultBranch}`]);
      await g.clean("fd");
    },
    p,
  );
}

export type MergeOutcome =
  | { state: "merged_clean"; commitSha: string }
  | { state: "fast_forwarded" }
  | { state: "conflicts_resolved"; commitSha: string; resolvedFiles: string[] }
  | {
      state: "conflicts_unresolved";
      conflictedFiles: string[];
      message: string;
    };

/**
 * Try to merge origin into the local branch, keeping both sides where
 * possible. On conflict, spin up an Opus-powered resolver agent; if that
 * can't produce a clean tree either, return the conflicted file list so
 * the UI can surface them.
 */
export async function mergeRemote(projectId: string, actor: GitActor): Promise<MergeOutcome> {
  const p = await loadProject(projectId);
  const repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch, {
    expectedBindingGeneration: p.githubBindingGeneration,
  });
  return runInProjectLock(
    p.id,
    async () => {
      const networkGit = await authenticatedGitForProject(p.id, repoPath, p.githubRepoFullName);
      const g = simpleGitForProject(repoPath, actor);
      await networkGit.fetch("origin", p.defaultBranch);

      const remoteRef = `origin/${p.defaultBranch}`;

      // If working tree is clean, a fast-forward or three-way merge is the
      // whole job.
      const status = await g.status();
      if (status.isClean()) {
        try {
          await g.raw(["merge", "--ff-only", remoteRef]);
          return { state: "fast_forwarded" };
        } catch {
          // Non-ff; fall through to a merge commit below.
        }
      }

      // Stage any uncommitted work first so the merge has a real commit to
      // combine against. We do a temporary "WIP" commit that the merge
      // rolls into the final result.
      if (!status.isClean()) {
        await g.add("-A");
        await g.raw(["commit", "-m", "WIP: merging remote changes", "--allow-empty"]);
      }

      try {
        await g.raw(["merge", "--no-ff", "--no-edit", remoteRef]);
        const head = (await g.revparse(["HEAD"])).trim();
        return { state: "merged_clean", commitSha: head };
      } catch {
        // Merge stopped on conflicts. Hand to the resolver agent.
      }

      const conflicted = (await g.raw(["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .filter(Boolean);

      if (conflicted.length === 0) {
        // Merge failed for some other reason; abort and bail loudly.
        await g.raw(["merge", "--abort"]).catch(() => undefined);
        return {
          state: "conflicts_unresolved",
          conflictedFiles: [],
          message: "Merge failed for an unknown reason. Please resolve manually.",
        };
      }

      const resolved = await resolveMergeConflictsWithOpus({
        repoPath,
        conflictedFiles: conflicted,
      });

      if (!resolved.ok) {
        // Leave the merge in its conflicted state so an admin can inspect.
        return {
          state: "conflicts_unresolved",
          conflictedFiles: conflicted,
          message: resolved.reason,
        };
      }

      // Resolver staged the files; we commit with the configured actor.
      await g.raw(["commit", "-m", "chore: resolve merge conflicts", "--no-edit"]);
      const head = (await g.revparse(["HEAD"])).trim();
      return { state: "conflicts_resolved", commitSha: head, resolvedFiles: conflicted };
    },
    p,
  );
}

/**
 * One-shot agent run dedicated to rewriting files with conflict markers.
 * Uses the strongest Opus available since these are rare, high-stakes,
 * and benefit from the extra reasoning. Tools are intentionally limited to
 * Read, Edit, and Write on the exact conflicted files. Trusted server code
 * stages those paths after the agent finishes.
 *
 * Returns `{ ok: true }` if every conflicted file is now clean and
 * staged, `{ ok: false, reason }` otherwise.
 */
async function resolveMergeConflictsWithOpus(opts: {
  repoPath: string;
  conflictedFiles: string[];
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const apiKey = (await getInstanceSetting("ANTHROPIC_API_KEY")) ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "No Anthropic API key configured." };
  }

  const listing = opts.conflictedFiles
    .map((filePath) => `  - ${JSON.stringify(filePath)}`)
    .join("\n");
  const prompt = `You are resolving a git merge conflict for the Quillra website editor.

Repository: ${opts.repoPath}
Conflicted files:
${listing}

For each file above:
  1. Read the file and find the conflict markers ("<<<<<<<", "=======", ">>>>>>>").
  2. Decide the correct resolution. Preserve the intent of BOTH sides when possible.
     - For content files (Markdown, MDX, HTML, JSON copy) prefer combining both sides
       rather than picking one.
     - For config/build files (package.json, lock files, *.config.*, CI configs) prefer
       the remote side unless the local side is clearly the newer, intended change.
     - Never leave conflict markers in the file.
  3. Write the resolved file. Quillra will stage the exact conflicted paths after you finish.

After every file above is resolved, stop. Do not run git commands. Do not touch
files that aren't in the list. Do not change unrelated lines in the conflicted files.

When done, reply with a single short confirmation line like "Resolved N files.". No
explanation of individual changes; we just need to know you finished.`;

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: opts.repoPath,
        // Use the strongest Opus for conflict resolution. Same identifier
        // the product uses for migrations.
        model: "claude-opus-4-5",
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            "You are a careful merge-conflict resolver. Do exactly what the user asked, nothing else. No commentary during tool use.",
        },
        env: createSafeSdkEnv({
          ANTHROPIC_API_KEY: apiKey,
          CLAUDE_AGENT_SDK_CLIENT_APP: "quillra/cms-conflict-resolver",
          IS_SANDBOX: "1",
        }),
        tools: ["Read", "Edit", "Write"],
        canUseTool: buildConflictResolverCanUseTool(opts.repoPath, opts.conflictedFiles),
      },
    })) {
      // We don't care about intermediate events; the sentinel is that the
      // loop ends with the filesystem in a clean state.
      void msg;
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Resolver run failed" };
  }

  // Sanity-check: every file must exist without conflict markers AND be
  // staged.
  for (const rel of opts.conflictedFiles) {
    const abs = path.join(opts.repoPath, rel);
    if (!fs.existsSync(abs)) {
      // A resolution that deletes the file is legitimate, but the file
      // must still be staged as a deletion. We check below.
    } else {
      const body = fs.readFileSync(abs, "utf8");
      if (/^<{7}|^={7}|^>{7}/m.test(body)) {
        return { ok: false, reason: `Conflict markers remain in ${rel}.` };
      }
    }
  }
  // Stage only the server-supplied conflict list. `--` prevents unusual file
  // names from being interpreted as git options, and the agent never gets a
  // shell merely to perform this deterministic operation.
  const g = simpleGitForProject(opts.repoPath);
  try {
    await g.add(["--", ...opts.conflictedFiles]);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Failed to stage resolved files.",
    };
  }

  // Confirm the index has no unmerged paths remaining.
  const unresolved = (await g.raw(["diff", "--name-only", "--diff-filter=U"]))
    .split("\n")
    .filter(Boolean).length;
  if (unresolved > 0) {
    return { ok: false, reason: "Some files were not staged by the resolver." };
  }
  return { ok: true };
}
