import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "NODE_ENV",
] as const;
const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));

let tempDirectory: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;

function restoreEnvironment() {
  for (const key of CONTROLLED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-chat-revocation-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "quillra-chat-revocation-test-secret";
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

describe("chat WebSocket authorization", () => {
  it("rejects the next message after membership is removed from an open socket", async () => {
    vi.resetModules();
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES ('member-1', 'Member', 'member@example.com', 1, 'member', ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO projects (id, name, github_repo_full_name, created_at, updated_at)
         VALUES ('project-1', 'Project', 'example/project', ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES ('membership-1', 'project-1', 'member-1', 'editor', ?)`,
      )
      .run(now);
    rawSqlite
      .prepare(
        `INSERT INTO team_sessions (id, user_id, token, expires_at)
         VALUES ('team-session-1', 'member-1', 'team-token', ?)`,
      )
      .run(now + 60_000);

    const memberUser = {
      id: "member-1",
      name: "Member",
      email: "member@example.com",
    };
    const cookie = "quillra_team_session=team-token";
    const context = {
      req: {
        param: (name: string) => (name === "projectId" ? "project-1" : undefined),
        raw: { headers: new Headers({ Cookie: cookie }) },
        header: (name: string) => (name.toLowerCase() === "cookie" ? cookie : undefined),
      },
      get: (name: string) => (name === "user" ? memberUser : null),
    } as unknown as Parameters<typeof chatWsHandler>[0];
    const handlers = await chatWsHandler(context);
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    expect(onMessage).toBeTypeOf("function");
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");

    rawSqlite.prepare("DELETE FROM project_members WHERE id = 'membership-1'").run();
    const send = vi.fn();
    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Update the headline" }) },
      { send },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
      type: "error",
      message: "Not a project member",
    });
  });

  it("rejects the next message after the captured client session is deleted", async () => {
    vi.resetModules();
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES ('client-1', 'Client', 'client@example.com', 1, ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO projects (id, name, github_repo_full_name, created_at, updated_at)
         VALUES ('project-1', 'Project', 'example/project', ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES ('membership-1', 'project-1', 'client-1', 'client', ?)`,
      )
      .run(now);
    rawSqlite
      .prepare(
        `INSERT INTO client_sessions (id, user_id, project_id, token, expires_at)
         VALUES ('client-session-1', 'client-1', 'project-1', 'client-token', ?)`,
      )
      .run(now + 60_000);

    const cookie = "quillra_client_session=client-token";
    const context = {
      req: {
        param: (name: string) => (name === "projectId" ? "project-1" : undefined),
        raw: { headers: new Headers({ Cookie: cookie }) },
        header: (name: string) => (name.toLowerCase() === "cookie" ? cookie : undefined),
      },
      get: (name: string) =>
        name === "user"
          ? { id: "client-1", name: "Client", email: "client@example.com" }
          : name === "clientSession"
            ? { projectId: "project-1" }
            : null,
    } as unknown as Parameters<typeof chatWsHandler>[0];
    const handlers = await chatWsHandler(context);
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");

    rawSqlite.prepare("DELETE FROM client_sessions WHERE id = 'client-session-1'").run();
    const send = vi.fn();
    const close = vi.fn();
    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Update the headline" }) },
      { send, close },
    );

    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
      type: "error",
      message: "Session expired. Please sign in again.",
    });
    expect(close).toHaveBeenCalledWith(4401, "Session expired");
  });

  it("does not let a non-admin send while an admin migration is pending", async () => {
    vi.resetModules();
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES ('editor-1', 'Editor', 'editor@example.com', 1, 'member', ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO projects
           (id, name, github_repo_full_name, migration_target, created_at, updated_at)
         VALUES ('project-1', 'Project', 'example/project', 'astro', ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES ('membership-1', 'project-1', 'editor-1', 'editor', ?)`,
      )
      .run(now);
    rawSqlite
      .prepare(
        `INSERT INTO team_sessions (id, user_id, token, expires_at)
         VALUES ('team-session-1', 'editor-1', 'team-token', ?)`,
      )
      .run(now + 60_000);

    const cookie = "quillra_team_session=team-token";
    const context = {
      req: {
        param: (name: string) => (name === "projectId" ? "project-1" : undefined),
        raw: { headers: new Headers({ Cookie: cookie }) },
        header: (name: string) => (name.toLowerCase() === "cookie" ? cookie : undefined),
      },
      get: (name: string) =>
        name === "user" ? { id: "editor-1", name: "Editor", email: "editor@example.com" } : null,
    } as unknown as Parameters<typeof chatWsHandler>[0];
    const handlers = await chatWsHandler(context);
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");

    const send = vi.fn();
    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Edit during migration" }) },
      { send },
    );

    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
      type: "error",
      message: "A project admin must run the migration before editing can continue.",
    });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM conversations").get()).toEqual({
      count: 0,
    });
  });
});
