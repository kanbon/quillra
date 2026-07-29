import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  vi.doUnmock("../services/agent.js");
  vi.doUnmock("../services/workspace.js");
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

function mockChatRuntime(
  events: Record<string, unknown>[],
  options: { workspaceMutation?: "diff" | "tree" | "sync" | "none" } = {},
) {
  const workspaceMutation = options.workspaceMutation ?? "diff";
  let fingerprintReads = 0;
  const repoPath = path.join(tempDirectory, "repo");
  mkdirSync(path.join(repoPath, ".git"), { recursive: true });
  vi.doMock("../services/workspace.js", () => ({
    ensureRepoCloned: vi.fn(async () => repoPath),
    projectRepoPath: vi.fn(() => repoPath),
    runInProjectLock: vi.fn(async (_projectId: string, operation: () => Promise<unknown>) =>
      operation(),
    ),
    simpleGitForProject: vi.fn(() => ({
      revparse: vi.fn(async () =>
        workspaceMutation === "tree" && fingerprintReads > 2
          ? "tree-after"
          : workspaceMutation === "sync" && fingerprintReads > 0
            ? "tree-synced"
            : "tree-before",
      ),
      diff: vi.fn(async () => {
        const read = fingerprintReads++;
        return workspaceMutation === "diff" && read > 2 ? "changed" : "";
      }),
      raw: vi.fn(async () => ""),
    })),
  }));
  vi.doMock("../services/agent.js", () => ({
    runProjectAgent: async function* (params: {
      onSessionId?: (sessionId: string) => void;
      onResult?: (usage: {
        totalCostUsd: number;
        numTurns: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        modelUsage: Record<string, unknown>;
      }) => void;
    }) {
      params.onSessionId?.("durable-agent-session");
      params.onSessionId?.("durable-agent-session");
      params.onSessionId?.("durable-agent-session");
      let usageReported = false;
      for (const event of events) {
        if (!usageReported && (event.type === "done" || event.type === "error")) {
          usageReported = true;
          params.onResult?.({
            totalCostUsd: 0.01,
            numTurns: 1,
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 5,
            cacheCreationTokens: 5,
            modelUsage: {},
          });
        }
        yield event;
      }
    },
  }));
}

function seedAuthorizedEditor(rawSqlite: NonNullable<typeof openDatabase>) {
  const now = Date.now();
  rawSqlite
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
       VALUES ('editor-1', 'Editor', 'editor@example.com', 1, 'member', ?, ?)`,
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
       VALUES ('membership-1', 'project-1', 'editor-1', 'editor', ?)`,
    )
    .run(now);
  rawSqlite
    .prepare(
      `INSERT INTO team_sessions (id, user_id, token, expires_at)
       VALUES ('team-session-1', 'editor-1', 'team-token', ?)`,
    )
    .run(now + 60_000);
}

function createTeamContext(chatWsHandler: typeof import("./chat-handler.js")["chatWsHandler"]) {
  const cookie = "quillra_team_session=team-token";
  return {
    req: {
      param: (name: string) => (name === "projectId" ? "project-1" : undefined),
      raw: { headers: new Headers({ Cookie: cookie }) },
      header: (name: string) => (name.toLowerCase() === "cookie" ? cookie : undefined),
    },
    get: (name: string) =>
      name === "user" ? { id: "editor-1", name: "Editor", email: "editor@example.com" } : null,
  } as unknown as Parameters<typeof chatWsHandler>[0];
}

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

describe("durable chat transcript", () => {
  it("persists every completed visible event and conversation state before done", async () => {
    mockChatRuntime(
      [
        { type: "thinking_start" },
        { type: "thinking", text: "Considering the request" },
        { type: "stream", text: "I changed " },
        { type: "tool_call", toolUseId: "tool-1", label: "Updating the homepage" },
        { type: "tool_progress", toolName: "Edit", elapsed: 2 },
        { type: "tool", detail: "Updated the homepage" },
        { type: "stream", text: "the homepage successfully." },
        { type: "done", costUsd: 0.01 },
      ],
      { workspaceMutation: "tree" },
    );
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);
    rawSqlite.exec(`
      CREATE TABLE session_update_audit (conversation_id TEXT NOT NULL);
      CREATE TRIGGER audit_agent_session_change
      AFTER UPDATE OF agent_session_id ON conversations
      WHEN OLD.agent_session_id IS NOT NEW.agent_session_id
      BEGIN
        INSERT INTO session_update_audit (conversation_id) VALUES (NEW.id);
      END;
    `);

    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");

    const frames: Record<string, unknown>[] = [];
    let doneSnapshot:
      | {
          kinds: string[];
          messageRoles: string[];
          agentSessionId: string | null;
          usageRows: number;
          sessionWrites: number;
        }
      | undefined;
    const send = vi.fn((raw: string) => {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "done") {
        doneSnapshot = {
          kinds: (
            rawSqlite
              .prepare("SELECT kind FROM chat_events WHERE project_id = ? ORDER BY id ASC")
              .all("project-1") as { kind: string }[]
          ).map((row) => row.kind),
          messageRoles: (
            rawSqlite
              .prepare("SELECT role FROM messages WHERE project_id = ? ORDER BY id ASC")
              .all("project-1") as { role: string }[]
          ).map((row) => row.role),
          agentSessionId: (
            rawSqlite
              .prepare("SELECT agent_session_id FROM conversations WHERE project_id = ?")
              .get("project-1") as { agent_session_id: string | null }
          ).agent_session_id,
          usageRows: (
            rawSqlite.prepare("SELECT count(*) AS count FROM agent_runs").get() as {
              count: number;
            }
          ).count,
          sessionWrites: (
            rawSqlite.prepare("SELECT count(*) AS count FROM session_update_audit").get() as {
              count: number;
            }
          ).count,
        };
      }
    });

    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Update the homepage design" }) },
      { send },
    );

    expect(doneSnapshot).toEqual({
      kinds: [
        "user",
        "thinking",
        "assistant",
        "tool_call",
        "tool",
        "assistant",
        "checkpoint",
        "done",
      ],
      messageRoles: ["user", "assistant"],
      agentSessionId: "durable-agent-session",
      usageRows: 1,
      sessionWrites: 1,
    });
    expect(frames.find((frame) => frame.type === "turn_accepted")).toMatchObject({
      conversationId: expect.any(String),
      turnId: expect.any(String),
      userEventId: expect.any(String),
    });
    expect(frames.at(-1)?.type).toBe("done");
    expect(frames.at(-1)?.status).toBe("completed");
    expect(frames.some((frame) => frame.type === "refresh_preview")).toBe(true);

    const durableIds = new Set(
      (rawSqlite.prepare("SELECT event_id FROM chat_events").all() as { event_id: string }[]).map(
        (row) => row.event_id,
      ),
    );
    const visibleStableIds = frames
      .filter((frame) =>
        ["thinking_start", "thinking", "stream", "tool_call", "tool", "done"].includes(
          String(frame.type),
        ),
      )
      .map((frame) => frame.eventId)
      .filter((eventId): eventId is string => typeof eventId === "string");
    expect(visibleStableIds.length).toBeGreaterThan(0);
    expect(visibleStableIds.every((eventId) => durableIds.has(eventId))).toBe(true);
    expect(
      (
        rawSqlite
          .prepare("SELECT count(*) AS count FROM chat_events WHERE kind = 'tool_progress'")
          .get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("finishes and persists the turn when the initiating socket disconnects", async () => {
    mockChatRuntime([
      { type: "stream", text: "The requested update is complete." },
      { type: "done", costUsd: 0.02 },
    ]);
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);

    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");

    const send = vi.fn(() => {
      throw new Error("socket closed");
    });
    await expect(
      onMessage(
        { data: JSON.stringify({ type: "message", content: "Update the homepage design" }) },
        { send },
      ),
    ).resolves.toBeUndefined();

    expect(
      (
        rawSqlite.prepare("SELECT kind FROM chat_events ORDER BY id ASC").all() as {
          kind: string;
        }[]
      ).map((row) => row.kind),
    ).toEqual(["user", "assistant", "checkpoint", "done"]);
    expect(
      (
        rawSqlite.prepare("SELECT role FROM messages ORDER BY id ASC").all() as {
          role: string;
        }[]
      ).map((row) => row.role),
    ).toEqual(["user", "assistant"]);
  });

  it("durably restores an ask-only turn without inventing an assistant message", async () => {
    mockChatRuntime(
      [
        {
          type: "stream",
          text: '<ask>{"question":"Which layout?","options":["Grid","List"]}</ask>',
        },
        { type: "done", costUsd: 0.001 },
      ],
      { workspaceMutation: "none" },
    );
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);

    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");
    const frames: Record<string, unknown>[] = [];

    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Choose a layout" }) },
      {
        send: (raw) => {
          frames.push(JSON.parse(raw) as Record<string, unknown>);
        },
      },
    );

    expect(
      (
        rawSqlite.prepare("SELECT kind FROM chat_events ORDER BY id ASC").all() as {
          kind: string;
        }[]
      ).map((row) => row.kind),
    ).toEqual(["user", "ask", "done"]);
    expect(
      (
        rawSqlite.prepare("SELECT role FROM messages ORDER BY id ASC").all() as {
          role: string;
        }[]
      ).map((row) => row.role),
    ).toEqual(["user"]);
    expect(frames.find((frame) => frame.type === "ask")?.eventId).toBeTypeOf("string");
    expect(frames.at(-1)?.type).toBe("done");
    expect(frames.at(-1)?.pausedForQuestion).toBe(true);
    expect(frames.at(-1)?.status).toBe("paused");
    expect(frames.some((frame) => frame.type === "refresh_preview")).toBe(false);
  });

  it("refreshes the preview when repository sync changed HEAD before a read-only agent turn", async () => {
    mockChatRuntime(
      [
        { type: "stream", text: "The repository is already up to date." },
        { type: "done", costUsd: 0.01 },
      ],
      { workspaceMutation: "sync" },
    );
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);
    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");
    const frames: Record<string, unknown>[] = [];

    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Check the current state" }) },
      { send: (raw) => frames.push(JSON.parse(raw) as Record<string, unknown>) },
    );

    expect(frames.some((frame) => frame.type === "refresh_preview")).toBe(true);
    expect(frames.at(-1)?.type).toBe("done");
  });

  it("detects same-metadata untracked content and symlink target changes", async () => {
    const repoPath = path.join(tempDirectory, "repo");
    mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    const untrackedFile = path.join(repoPath, "untracked.txt");
    const untrackedLink = path.join(repoPath, "untracked-link");
    writeFileSync(untrackedFile, "aaaa");
    symlinkSync("target-a", untrackedLink);
    const originalTimes = statSync(untrackedFile);
    vi.doMock("../services/workspace.js", () => ({
      ensureRepoCloned: vi.fn(async () => repoPath),
      projectRepoPath: vi.fn(() => repoPath),
      runInProjectLock: vi.fn(async (_projectId: string, operation: () => Promise<unknown>) =>
        operation(),
      ),
      simpleGitForProject: vi.fn(() => ({
        revparse: vi.fn(async () => "tree"),
        diff: vi.fn(async () => ""),
        raw: vi.fn(async () => "untracked-link\0untracked.txt\0"),
      })),
    }));
    vi.doMock("../services/agent.js", () => ({
      runProjectAgent: async function* () {
        writeFileSync(untrackedFile, "bbbb");
        utimesSync(untrackedFile, originalTimes.atime, originalTimes.mtime);
        unlinkSync(untrackedLink);
        symlinkSync("target-b", untrackedLink);
        yield { type: "stream", text: "Updated the untracked project assets." };
        yield { type: "done", costUsd: 0 };
      },
    }));
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);
    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");
    const frames: Record<string, unknown>[] = [];

    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Update the untracked assets" }) },
      { send: (raw) => frames.push(JSON.parse(raw) as Record<string, unknown>) },
    );

    expect(frames.some((frame) => frame.type === "refresh_preview")).toBe(true);
    expect(frames.at(-1)?.type).toBe("done");
  });

  it("uses failed SDK result usage as the terminal turn cost", async () => {
    mockChatRuntime([{ type: "error", message: "The model stopped unexpectedly." }], {
      workspaceMutation: "none",
    });
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);
    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");
    const frames: Record<string, unknown>[] = [];

    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Apply the update" }) },
      { send: (raw) => frames.push(JSON.parse(raw) as Record<string, unknown>) },
    );

    expect(frames.at(-1)).toMatchObject({
      type: "done",
      status: "error",
      costUsd: 0.01,
      checkpointEventId: null,
    });
    const durableDone = rawSqlite
      .prepare("SELECT payload FROM chat_events WHERE kind = 'done'")
      .get() as { payload: string };
    expect(JSON.parse(durableDone.payload)).toMatchObject({ status: "error", costUsd: 0.01 });
    expect(rawSqlite.prepare("SELECT cost_usd FROM agent_runs").get()).toEqual({
      cost_usd: "0.01",
    });
  });

  it("serializes concurrent sends and resumes the session written by the previous turn", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let agentCalls = 0;
    const resumedSessions: Array<string | null> = [];
    let fingerprintReads = 0;
    const repoPath = path.join(tempDirectory, "repo");
    mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    vi.doMock("../services/workspace.js", () => ({
      ensureRepoCloned: vi.fn(async () => repoPath),
      projectRepoPath: vi.fn(() => repoPath),
      runInProjectLock: vi.fn(async (_projectId: string, operation: () => Promise<unknown>) =>
        operation(),
      ),
      simpleGitForProject: vi.fn(() => ({
        revparse: vi.fn(async () => "tree"),
        diff: vi.fn(async () => (fingerprintReads++ === 0 ? "" : "changed")),
        raw: vi.fn(async () => ""),
      })),
    }));
    vi.doMock("../services/agent.js", () => ({
      runProjectAgent: async function* (params: {
        agentSessionId?: string | null;
        onSessionId?: (sessionId: string) => void;
      }) {
        agentCalls += 1;
        const call = agentCalls;
        resumedSessions.push(params.agentSessionId ?? null);
        params.onSessionId?.(`session-${call}`);
        if (call === 1) {
          markFirstEntered();
          await firstGate;
        }
        yield { type: "stream", text: `Completed serialized turn ${call}.` };
        yield { type: "done", costUsd: 0.01 };
      },
    }));

    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO conversations
           (id, project_id, created_by_user_id, title, agent_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("existing-conversation", "project-1", "editor-1", "Existing", "session-0", now, now);

    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");
    const firstFrames: Record<string, unknown>[] = [];
    const secondFrames: Record<string, unknown>[] = [];
    const firstTurn = onMessage(
      {
        data: JSON.stringify({
          type: "message",
          content: "First change",
          conversationId: "existing-conversation",
        }),
      },
      { send: (raw) => firstFrames.push(JSON.parse(raw) as Record<string, unknown>) },
    );
    await firstEntered;
    const secondTurn = onMessage(
      {
        data: JSON.stringify({
          type: "message",
          content: "Second change",
          conversationId: "existing-conversation",
        }),
      },
      { send: (raw) => secondFrames.push(JSON.parse(raw) as Record<string, unknown>) },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(agentCalls).toBe(1);
    expect(
      (
        rawSqlite.prepare("SELECT content FROM chat_events WHERE kind = 'user'").all() as {
          content: string;
        }[]
      ).map((row) => row.content),
    ).toEqual(["First change"]);

    releaseFirst();
    await Promise.all([firstTurn, secondTurn]);

    expect(agentCalls).toBe(2);
    expect(resumedSessions).toEqual(["session-0", "session-1"]);
    expect(
      (
        rawSqlite.prepare("SELECT kind, content FROM chat_events ORDER BY id ASC").all() as {
          kind: string;
          content: string | null;
        }[]
      ).map((row) => [row.kind, row.content]),
    ).toEqual([
      ["user", "First change"],
      ["assistant", "Completed serialized turn 1."],
      ["checkpoint", null],
      ["done", null],
      ["user", "Second change"],
      ["assistant", "Completed serialized turn 2."],
      ["checkpoint", null],
      ["done", null],
    ]);
    expect(firstFrames.find((frame) => frame.type === "turn_accepted")?.userEventId).toBeTypeOf(
      "string",
    );
    expect(secondFrames.find((frame) => frame.type === "turn_accepted")?.userEventId).toBeTypeOf(
      "string",
    );
  });

  it("revalidates an expired session after waiting for the conversation queue", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let agentCalls = 0;
    const repoPath = path.join(tempDirectory, "repo");
    mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    vi.doMock("../services/workspace.js", () => ({
      ensureRepoCloned: vi.fn(async () => repoPath),
      projectRepoPath: vi.fn(() => repoPath),
      runInProjectLock: vi.fn(async (_projectId: string, operation: () => Promise<unknown>) =>
        operation(),
      ),
      simpleGitForProject: vi.fn(() => ({
        revparse: vi.fn(async () => "tree"),
        diff: vi.fn(async () => ""),
        raw: vi.fn(async () => ""),
      })),
    }));
    vi.doMock("../services/agent.js", () => ({
      runProjectAgent: async function* () {
        agentCalls += 1;
        if (agentCalls === 1) {
          markFirstEntered();
          await firstGate;
        }
        yield { type: "stream", text: "Completed the authorized turn." };
        yield { type: "done", costUsd: 0.01 };
      },
    }));
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO conversations
           (id, project_id, created_by_user_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("existing-conversation", "project-1", "editor-1", "Existing", now, now);
    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");
    const firstTurn = onMessage(
      {
        data: JSON.stringify({
          type: "message",
          content: "First change",
          conversationId: "existing-conversation",
        }),
      },
      { send: () => {} },
    );
    await firstEntered;
    const secondFrames: Record<string, unknown>[] = [];
    const close = vi.fn();
    const secondTurn = onMessage(
      {
        data: JSON.stringify({
          type: "message",
          content: "Second change",
          conversationId: "existing-conversation",
        }),
      },
      {
        send: (raw) => secondFrames.push(JSON.parse(raw) as Record<string, unknown>),
        close,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    rawSqlite.prepare("DELETE FROM team_sessions WHERE token = 'team-token'").run();
    releaseFirst();
    await Promise.all([firstTurn, secondTurn]);

    expect(agentCalls).toBe(1);
    expect(secondFrames).toEqual([
      { type: "error", message: "Session expired. Please sign in again." },
    ]);
    expect(close).toHaveBeenCalledWith(4401, "Session expired");
    expect(
      (
        rawSqlite.prepare("SELECT content FROM chat_events WHERE kind = 'user'").all() as {
          content: string;
        }[]
      ).map((row) => row.content),
    ).toEqual(["First change"]);
  });

  it("serializes hard-cap admission across conversations for the same user", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let agentCalls = 0;
    const repoPath = path.join(tempDirectory, "repo");
    mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    vi.doMock("../services/workspace.js", () => ({
      ensureRepoCloned: vi.fn(async () => repoPath),
      projectRepoPath: vi.fn(() => repoPath),
      runInProjectLock: vi.fn(async (_projectId: string, operation: () => Promise<unknown>) =>
        operation(),
      ),
      simpleGitForProject: vi.fn(() => ({
        revparse: vi.fn(async () => "tree"),
        diff: vi.fn(async () => ""),
        raw: vi.fn(async () => ""),
      })),
    }));
    vi.doMock("../services/agent.js", () => ({
      runProjectAgent: async function* (params: {
        onResult?: (usage: {
          totalCostUsd: number;
          numTurns: number;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
          modelUsage: Record<string, unknown>;
        }) => void;
      }) {
        agentCalls += 1;
        markFirstEntered();
        await firstGate;
        params.onResult?.({
          totalCostUsd: 2,
          numTurns: 1,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          modelUsage: {},
        });
        yield { type: "stream", text: "Completed the admitted turn." };
        yield { type: "done", costUsd: 2 };
      },
    }));
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO conversations
           (id, project_id, created_by_user_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "conversation-1",
        "project-1",
        "editor-1",
        "First",
        now,
        now,
        "conversation-2",
        "project-1",
        "editor-1",
        "Second",
        now,
        now,
      );
    rawSqlite
      .prepare(
        `INSERT INTO usage_limits (scope, target, hard_usd, updated_at)
         VALUES ('global', '', 1, ?)`,
      )
      .run(now);
    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");
    const firstTurn = onMessage(
      {
        data: JSON.stringify({
          type: "message",
          content: "First billed change",
          conversationId: "conversation-1",
        }),
      },
      { send: () => {} },
    );
    await firstEntered;
    const secondFrames: Record<string, unknown>[] = [];
    const secondTurn = onMessage(
      {
        data: JSON.stringify({
          type: "message",
          content: "Second billed change",
          conversationId: "conversation-2",
        }),
      },
      { send: (raw) => secondFrames.push(JSON.parse(raw) as Record<string, unknown>) },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(agentCalls).toBe(1);
    releaseFirst();
    await Promise.all([firstTurn, secondTurn]);

    expect(agentCalls).toBe(1);
    expect(secondFrames.at(-1)).toMatchObject({ type: "done", status: "blocked", costUsd: 0 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM agent_runs").get()).toEqual({
      count: 1,
    });
    expect(
      (
        rawSqlite
          .prepare(
            `SELECT kind FROM chat_events
             WHERE conversation_id = 'conversation-2'
             ORDER BY id ASC`,
          )
          .all() as { kind: string }[]
      ).map((row) => row.kind),
    ).toEqual(["user", "error", "done"]);
  });

  it("rechecks the hard cap before the automatic continuation run", async () => {
    let agentCalls = 0;
    const repoPath = path.join(tempDirectory, "repo");
    mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    vi.doMock("../services/workspace.js", () => ({
      ensureRepoCloned: vi.fn(async () => repoPath),
      projectRepoPath: vi.fn(() => repoPath),
      runInProjectLock: vi.fn(async (_projectId: string, operation: () => Promise<unknown>) =>
        operation(),
      ),
      simpleGitForProject: vi.fn(() => ({
        revparse: vi.fn(async () => "tree"),
        diff: vi.fn(async () => ""),
        raw: vi.fn(async () => ""),
      })),
    }));
    vi.doMock("../services/agent.js", () => ({
      runProjectAgent: async function* (params: {
        onResult?: (usage: {
          totalCostUsd: number;
          numTurns: number;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
          modelUsage: Record<string, unknown>;
        }) => void;
      }) {
        agentCalls += 1;
        params.onResult?.({
          totalCostUsd: 2,
          numTurns: 1,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          modelUsage: {},
        });
        yield { type: "tool_call", label: "Updating the page" };
        yield { type: "stream", text: "Done." };
        yield { type: "done", costUsd: 2 };
      },
    }));
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);
    rawSqlite
      .prepare(
        `INSERT INTO usage_limits (scope, target, hard_usd, updated_at)
         VALUES ('global', '', 1, ?)`,
      )
      .run(Date.now());
    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");
    const frames: Record<string, unknown>[] = [];

    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Make the change" }) },
      { send: (raw) => frames.push(JSON.parse(raw) as Record<string, unknown>) },
    );

    expect(agentCalls).toBe(1);
    expect(frames.at(-1)).toMatchObject({ type: "done", status: "error", costUsd: 2 });
    expect(
      (
        rawSqlite.prepare("SELECT kind FROM chat_events ORDER BY id ASC").all() as {
          kind: string;
        }[]
      ).map((row) => row.kind),
    ).toEqual(["user", "tool_call", "assistant", "error", "done"]);
  });

  it("persists and emits a terminal done after an unexpected agent failure", async () => {
    let fingerprintReads = 0;
    const repoPath = path.join(tempDirectory, "repo");
    mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    vi.doMock("../services/workspace.js", () => ({
      ensureRepoCloned: vi.fn(async () => repoPath),
      projectRepoPath: vi.fn(() => repoPath),
      runInProjectLock: vi.fn(async (_projectId: string, operation: () => Promise<unknown>) =>
        operation(),
      ),
      simpleGitForProject: vi.fn(() => ({
        revparse: vi.fn(async () => "tree"),
        diff: vi.fn(async () => (fingerprintReads++ === 0 ? "" : "changed")),
        raw: vi.fn(async () => ""),
      })),
    }));
    vi.doMock("../services/agent.js", () => ({
      runProjectAgent: async function* () {
        yield { type: "stream", text: "I applied part of the requested change." };
        throw new Error("unexpected SDK failure");
      },
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);

    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");
    const frames: Record<string, unknown>[] = [];

    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Apply the change" }) },
      { send: (raw) => frames.push(JSON.parse(raw) as Record<string, unknown>) },
    );

    expect(
      (
        rawSqlite.prepare("SELECT kind FROM chat_events ORDER BY id ASC").all() as {
          kind: string;
        }[]
      ).map((row) => row.kind),
    ).toEqual(["user", "assistant", "error", "done"]);
    const errorIndex = frames.findIndex((frame) => frame.type === "error");
    const doneIndex = frames.findIndex((frame) => frame.type === "done");
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(errorIndex);
    expect(frames.at(-1)?.type).toBe("done");
    expect(frames.at(-1)?.status).toBe("error");
    expect(frames[errorIndex]?.turnId).toBe(frames[doneIndex]?.turnId);
    consoleError.mockRestore();
  });

  it("does not report migration completion when clearing the migration flag fails", async () => {
    mockChatRuntime(
      [
        { type: "stream", text: "The migration completed successfully." },
        { type: "done", costUsd: 0.01 },
      ],
      { workspaceMutation: "diff" },
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { chatWsHandler } = await import("./chat-handler.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    seedAuthorizedEditor(rawSqlite);
    rawSqlite.prepare("UPDATE project_members SET role = 'admin' WHERE id = 'membership-1'").run();
    rawSqlite
      .prepare("UPDATE projects SET migration_target = 'astro' WHERE id = 'project-1'")
      .run();
    rawSqlite.exec(`
      CREATE TRIGGER reject_migration_completion
      BEFORE UPDATE OF migration_target ON projects
      WHEN OLD.migration_target = 'astro' AND NEW.migration_target IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'migration update rejected');
      END;
    `);
    const handlers = await chatWsHandler(createTeamContext(chatWsHandler));
    const onMessage = "onMessage" in handlers ? handlers.onMessage : undefined;
    if (!onMessage) throw new Error("Expected an authorized WebSocket handler");
    const frames: Record<string, unknown>[] = [];

    await onMessage(
      { data: JSON.stringify({ type: "message", content: "Migrate the project" }) },
      { send: (raw) => frames.push(JSON.parse(raw) as Record<string, unknown>) },
    );

    expect(frames.some((frame) => frame.type === "migration_complete")).toBe(false);
    expect(frames.at(-1)).toMatchObject({ type: "done", status: "error" });
    expect(
      (
        rawSqlite.prepare("SELECT migration_target FROM projects WHERE id = 'project-1'").get() as {
          migration_target: string | null;
        }
      ).migration_target,
    ).toBe("astro");
    consoleError.mockRestore();
  });
});
