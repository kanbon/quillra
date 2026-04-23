/**
 * Remote-sync routes for the editor's "pull before you chat" flow.
 *
 * `GET  /:id/sync-status`  Non-mutating inspection. Fetches origin,
 *                          compares HEAD to origin/<branch>, returns
 *                          whether the user is behind, ahead, both, or
 *                          in sync. Also includes a short summary of
 *                          the new remote commits and the user's local
 *                          changes when relevant, so the UI can show
 *                          "3 commits from Alice" without a second API
 *                          call.
 * `POST /:id/sync/fast-forward`   Silent pull when the tree is clean.
 * `POST /:id/sync/merge`          Merges remote with local changes.
 *                                 Delegates conflict resolution to the
 *                                 Opus-powered helper in services/sync.ts
 *                                 and surfaces any files that needed
 *                                 manual rescue.
 * `POST /:id/sync/discard`        Hard reset onto origin. Throws away
 *                                 any uncommitted chat-turn edits.
 *
 * All four require project membership. The merge/discard endpoints are
 * write-destructive to the workspace but never to the remote.
 */

import { Hono } from "hono";
import {
  discardAndReset,
  fastForwardPull,
  getSyncStatus,
  mergeRemote,
} from "../../services/sync.js";
import { type Variables, memberForProject, requireUser } from "./shared.js";

export const syncRouter = new Hono<{ Variables: Variables }>()
  .get("/:id/sync-status", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Forbidden" }, 403);
    try {
      const status = await getSyncStatus(projectId);
      return c.json(status);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Sync status failed" }, 500);
    }
  })
  .post("/:id/sync/fast-forward", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Forbidden" }, 403);
    try {
      const result = await fastForwardPull(projectId);
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Pull failed" }, 500);
    }
  })
  .post("/:id/sync/merge", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Forbidden" }, 403);
    try {
      const result = await mergeRemote(projectId, {
        name: r.user.name ?? r.user.email ?? "Quillra user",
        email: r.user.email ?? "noreply@quillra.app",
      });
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Merge failed" }, 500);
    }
  })
  .post("/:id/sync/discard", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");
    const m = await memberForProject(r.user.id, projectId);
    if (!m) return c.json({ error: "Forbidden" }, 403);
    try {
      await discardAndReset(projectId);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Discard failed" }, 500);
    }
  });
