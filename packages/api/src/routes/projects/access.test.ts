import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../lib/auth.js";

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "NODE_ENV",
] as const;

const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));

let tempDirectory: string;
let openDatabase: typeof import("../../db/index.js")["rawSqlite"] | null = null;

function restoreEnvironment() {
  for (const key of CONTROLLED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-client-scope-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "quillra-client-scope-test-auth-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function createClientApp() {
  vi.resetModules();
  const [{ rawSqlite }, { projectsRouter }, { githubRouter }, { teamRouter }] = await Promise.all([
    import("../../db/index.js"),
    import("./index.js"),
    import("../github.js"),
    import("../team.js"),
  ]);
  openDatabase = rawSqlite;
  const now = Date.now();

  rawSqlite
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?), (?, ?, ?, 1, ?, ?)`,
    )
    .run(
      "client-1",
      "Client One",
      "client@example.com",
      now,
      now,
      "client-2",
      "Client Two",
      "other@example.com",
      now,
      now,
    );
  rawSqlite
    .prepare(
      `INSERT INTO projects (id, name, github_repo_full_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    )
    .run(
      "project-1",
      "Pinned project",
      "example/pinned",
      now,
      now,
      "project-2",
      "Other project",
      "example/other",
      now,
      now,
    );
  rawSqlite
    .prepare(
      `INSERT INTO project_members (id, project_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    )
    .run(
      "member-pinned",
      "project-1",
      "client-1",
      "client",
      now,
      "member-other-admin",
      "project-2",
      "client-1",
      "admin",
      now,
      "member-other-client",
      "project-1",
      "client-2",
      "client",
      now,
    );

  const sessionUser = {
    id: "client-1",
    name: "Client One",
    email: "client@example.com",
  } as SessionUser;
  type TestVariables = {
    user: SessionUser | null;
    clientSession: { projectId: string } | null;
  };
  const app = new Hono<{ Variables: TestVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", sessionUser);
    c.set("clientSession", { projectId: "project-1" });
    await next();
  });
  app.route("/projects", projectsRouter);
  app.route("/github", githubRouter);
  app.route("/team", teamRouter);
  return { app, rawSqlite };
}

describe("project-scoped client sessions", () => {
  it("lists only the pinned project and blocks cross-project REST access", async () => {
    const { app, rawSqlite } = await createClientApp();

    const list = await app.request("/projects");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      projects: [{ id: "project-1", role: "client" }],
    });

    expect((await app.request("/projects/project-2")).status).toBe(404);
    expect((await app.request("/projects/project-2/file?path=package.json")).status).toBe(404);
    expect(
      (
        await app.request("/projects/project-2", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Cross-project write" }),
        })
      ).status,
    ).toBe(404);

    const create = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Client-created project",
        githubRepoFullName: "example/new",
        defaultBranch: "main",
      }),
    });
    expect(create.status).toBe(403);
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({ count: 2 });
  });

  it("blocks private GitHub discovery but leaves the framework catalog public", async () => {
    const { app } = await createClientApp();

    expect((await app.request("/github/repos")).status).toBe(403);
    expect((await app.request("/github/repos/example/repo/branches")).status).toBe(403);
    expect((await app.request("/github/repos/example/repo/framework?ref=main")).status).toBe(403);
    expect((await app.request("/projects/project-1/framework")).status).toBe(403);
    expect((await app.request("/projects/project-1/sync-status")).status).toBe(403);
    expect((await app.request("/github/frameworks")).status).toBe(200);
  });

  it("blocks destructive workspace operations and the project member directory", async () => {
    const { app } = await createClientApp();

    expect(
      (
        await app.request("/projects/project-1/asset-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "package.json" }),
        })
      ).status,
    ).toBe(403);
    for (const action of ["fast-forward", "merge", "discard"]) {
      expect(
        (
          await app.request(`/projects/project-1/sync/${action}`, {
            method: "POST",
          })
        ).status,
      ).toBe(403);
    }
    expect((await app.request("/team/projects/project-1/members")).status).toBe(403);
    // The same user is an admin on project-2, but this request is still a
    // client session and must not inherit that unrelated membership.
    expect((await app.request("/team/projects/project-2/members")).status).toBe(403);
  });

  it("shows clients only messages and costs from their own conversations", async () => {
    const { app, rawSqlite } = await createClientApp();
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO conversations
           (id, project_id, created_by_user_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "own-conversation",
        "project-1",
        "client-1",
        "Mine",
        now,
        now,
        "other-conversation",
        "project-1",
        "client-2",
        "Theirs",
        now,
        now,
      );
    rawSqlite
      .prepare(
        `INSERT INTO messages (project_id, conversation_id, user_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "project-1",
        "own-conversation",
        "client-1",
        "user",
        "own message",
        now,
        "project-1",
        "other-conversation",
        "client-2",
        "user",
        "other client's message",
        now,
      );
    rawSqlite
      .prepare(
        `INSERT INTO agent_runs (id, project_id, conversation_id, user_id, cost_usd)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .run(
        "own-run",
        "project-1",
        "own-conversation",
        "client-1",
        "1.25",
        "other-run",
        "project-1",
        "other-conversation",
        "client-2",
        "99.00",
      );

    const messages = await app.request("/projects/project-1/messages");
    expect(messages.status).toBe(200);
    await expect(messages.json()).resolves.toMatchObject({
      messages: [{ content: "own message", conversationId: "own-conversation" }],
    });

    const otherMessages = await app.request(
      "/projects/project-1/messages?conversationId=other-conversation",
    );
    await expect(otherMessages.json()).resolves.toEqual({ messages: [] });

    const ownCost = await app.request(
      "/projects/project-1/conversations/own-conversation/cost-total",
    );
    expect(ownCost.status).toBe(200);
    await expect(ownCost.json()).resolves.toEqual({ totalCostUsd: 1.25 });
    expect(
      (await app.request("/projects/project-1/conversations/other-conversation/cost-total")).status,
    ).toBe(404);
  });

  it("uses the same project-pin predicate for WebSocket access", async () => {
    const { clientSessionCanAccessProject } = await import("./shared.js");

    expect(clientSessionCanAccessProject({ projectId: "project-1" }, "project-1")).toBe(true);
    expect(clientSessionCanAccessProject({ projectId: "project-1" }, "project-2")).toBe(false);
    expect(clientSessionCanAccessProject(null, "project-2")).toBe(true);
    expect(clientSessionCanAccessProject(undefined, "project-2")).toBe(true);
  });
});
