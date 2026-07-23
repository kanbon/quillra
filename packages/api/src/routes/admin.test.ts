import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../lib/auth.js";

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "QUILLRA_ENCRYPTION_KEY",
  "EMAIL_PROVIDER",
  "RESEND_API_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
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
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-admin-invites-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.EMAIL_PROVIDER = "none";
  process.env.GITHUB_APP_ID = "42";
  process.env.GITHUB_APP_PRIVATE_KEY = "admin-test-private-key";
  process.env.GITHUB_APP_CLIENT_ID = "Iv1.admin-test";
  process.env.GITHUB_APP_CLIENT_SECRET = "admin-test-secret";
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("instance invites", () => {
  it("normalizes and refreshes a mixed-case invite without duplicating it", async () => {
    vi.resetModules();
    const { adminRouter } = await import("./admin.js");
    const { rawSqlite } = await import("../db/index.js");
    openDatabase = rawSqlite;
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, 'owner', ?, ?)`,
      )
      .run("owner-1", "Owner", "owner@example.com", now, now);
    rawSqlite
      .prepare(
        `INSERT INTO instance_invites
           (id, email, token_hash, invited_by_user_id, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("legacy-invite", "New.Member@Example.COM", "old-hash", "owner-1", now - 1);

    const owner = {
      id: "owner-1",
      name: "Owner",
      email: "owner@example.com",
    } as SessionUser;
    const app = new Hono<{ Variables: { user: SessionUser | null } }>();
    app.use("*", async (c, next) => {
      c.set("user", owner);
      await next();
    });
    app.route("/", adminRouter);

    for (const email of [" new.member@example.com ", "NEW.MEMBER@example.com"]) {
      const response = await app.request("/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        email: "new.member@example.com",
        emailConfigured: false,
        emailed: false,
      });
    }

    expect(
      rawSqlite
        .prepare(
          `SELECT id, email, count(*) OVER () AS count, expires_at AS expiresAt
           FROM instance_invites WHERE lower(email) = ?`,
        )
        .get("new.member@example.com"),
    ).toMatchObject({
      id: "legacy-invite",
      email: "new.member@example.com",
      count: 1,
      expiresAt: expect.any(Number),
    });
    const invite = rawSqlite
      .prepare("SELECT expires_at AS expiresAt FROM instance_invites WHERE id = ?")
      .get("legacy-invite") as { expiresAt: number };
    expect(invite.expiresAt).toBeGreaterThan(now);
  });

  it("delivers instance invitations with the configured instance brand", async () => {
    vi.resetModules();
    const { adminRouter } = await import("./admin.js");
    const { rawSqlite } = await import("../db/index.js");
    const { setInstanceSetting } = await import("../services/instance-settings.js");
    openDatabase = rawSqlite;
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, 'owner', ?, ?)`,
      )
      .run("owner-1", "Avery Owner", "owner@example.com", now, now);
    setInstanceSetting("EMAIL_PROVIDER", "resend");
    setInstanceSetting("RESEND_API_KEY", "re_instance_invite_test");
    setInstanceSetting("INSTANCE_NAME", "Atelier North");
    setInstanceSetting("INSTANCE_LOGO_URL", "https://assets.example.test/atelier-north.png");
    setInstanceSetting("INSTANCE_ACCENT_COLOR", "#1f6f5b");

    const send = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: "instance-invite-email-1" }),
    );
    vi.stubGlobal("fetch", send);
    const owner = {
      id: "owner-1",
      name: "Avery Owner",
      email: "owner@example.com",
    } as SessionUser;
    const app = new Hono<{ Variables: { user: SessionUser | null } }>();
    app.use("*", async (c, next) => {
      c.set("user", owner);
      await next();
    });
    app.route("/", adminRouter);

    const response = await app.request("/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new.member@example.com" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      email: "new.member@example.com",
      emailConfigured: true,
      emailed: true,
    });
    expect(send).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = send.mock.calls[0];
    expect(requestUrl).toBe("https://api.resend.com/emails");
    const message = JSON.parse(String(requestInit?.body)) as {
      to: string[];
      subject: string;
      html: string;
      text: string;
    };
    expect(message.to).toEqual(["new.member@example.com"]);
    expect(message.subject).toBe("You're invited to Atelier North");
    expect(message.html).toContain("Atelier North");
    expect(message.html).toContain("https://assets.example.test/atelier-north.png");
    expect(message.html).toContain("#1F6F5B");
    expect(message.text).toContain("Atelier North");
    expect(message.text).toContain("Avery Owner invited you to Atelier North.");
  });

  it("revokes preview capabilities for every project when an instance member is removed", async () => {
    vi.resetModules();
    const { adminRouter } = await import("./admin.js");
    const { rawSqlite } = await import("../db/index.js");
    const { issuePreviewCapability, resolvePreviewCapability } = await import(
      "../services/preview-capability.js"
    );
    const { projectWriterAuthorizationEpoch, registerProjectWriter } = await import(
      "../services/project-workspace-lifecycle.js"
    );
    const { encryptSecret } = await import("../services/crypto.js");
    openDatabase = rawSqlite;
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES
           ('owner-1', 'Owner', 'owner@example.com', 1, 'owner', ?, ?),
           ('member-1', 'Member', 'member@example.com', 1, 'member', ?, ?)`,
      )
      .run(now, now, now, now);
    rawSqlite
      .prepare(
        `INSERT INTO github_user_connections
          (user_id, github_user_id, github_login, access_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("member-1", "101", "member", encryptSecret("member-user-token"), now, now);
    for (const projectId of ["project-1", "project-2", "project-3"]) {
      rawSqlite
        .prepare(
          `INSERT INTO projects (id, name, github_repo_full_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(projectId, projectId, `example/${projectId}`, now, now);
    }
    for (const projectId of ["project-1", "project-2"]) {
      rawSqlite
        .prepare(
          `INSERT INTO project_members (id, project_id, user_id, role, created_at)
           VALUES (?, ?, 'member-1', 'editor', ?)`,
        )
        .run(`membership-${projectId}`, projectId, now);
    }

    const affectedOne = issuePreviewCapability("project-1", 4173);
    const affectedTwo = issuePreviewCapability("project-2", 4174);
    const unaffected = issuePreviewCapability("project-3", 4175);
    const owner = {
      id: "owner-1",
      name: "Owner",
      email: "owner@example.com",
    } as SessionUser;
    const app = new Hono<{ Variables: { user: SessionUser | null } }>();
    app.use("*", async (c, next) => {
      c.set("user", owner);
      await next();
    });
    app.route("/", adminRouter);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const writerCancel = vi.fn();
    const releaseWriter = registerProjectWriter("project-1", writerCancel, {
      userId: "member-1",
      expectedEpoch: projectWriterAuthorizationEpoch("project-1", "member-1"),
    });

    const response = await app.request("/members/member-1", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(writerCancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/applications/Iv1.admin-test/grant",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ access_token: "member-user-token" }),
      }),
    );
    expect(resolvePreviewCapability("4173", affectedOne.token)).toEqual({ ok: false });
    expect(resolvePreviewCapability("4174", affectedTwo.token)).toEqual({ ok: false });
    expect(resolvePreviewCapability("4175", unaffected.token)).toMatchObject({
      ok: true,
      projectId: "project-3",
    });
    expect(
      rawSqlite.prepare("SELECT count(*) AS count FROM user WHERE id = ?").get("member-1"),
    ).toEqual({ count: 0 });
    expect(
      rawSqlite
        .prepare("SELECT count(*) AS count FROM project_members WHERE user_id = ?")
        .get("member-1"),
    ).toEqual({ count: 0 });
    releaseWriter();
  });
});
