import { Hono } from "hono";
import { beat as presenceBeat, listOthers as presenceListOthers } from "../../services/presence.js";
import { type Variables, memberForProject, requireUser } from "./shared.js";

export const presenceRouter = new Hono<{ Variables: Variables }>()
  /**
   * Presence heartbeat. The frontend hits this every ~10s while a user has a
   * project open. Upserts the caller into the in-memory presence map and
   * returns every other active viewer for that project (team members and
   * clients alike, excluding self).
   */
  .post("/:id/presence/beat", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const projectId = c.req.param("id");

    // Access check: team members (via projectMembers row) OR a client whose
    // session cookie is pinned to exactly this project.
    const clientSession = c.get("clientSession");
    let kind: "team" | "client";
    if (clientSession && clientSession.projectId === projectId) {
      kind = "client";
    } else {
      const m = await memberForProject(r.user.id, projectId);
      if (!m) return c.json({ error: "Forbidden" }, 403);
      kind = "team";
    }

    presenceBeat(
      projectId,
      {
        id: r.user.id,
        name: r.user.name ?? r.user.email ?? "Someone",
        email: r.user.email ?? "",
        image: r.user.image ?? null,
      },
      kind,
    );

    const others = presenceListOthers(projectId, r.user.id).map((e) => ({
      userId: e.userId,
      name: e.name,
      email: e.email,
      image: e.image,
      kind: e.kind,
      lastSeenAt: e.lastSeenAt,
    }));
    return c.json({ others });
  });
