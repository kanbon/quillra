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
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
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

  it("revokes preview capabilities for every project when an instance member is removed", async () => {
    vi.resetModules();
    const { adminRouter } = await import("./admin.js");
    const { rawSqlite } = await import("../db/index.js");
    const { issuePreviewCapability, resolvePreviewCapability } = await import(
      "../services/preview-capability.js"
    );
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

    const response = await app.request("/members/member-1", { method: "DELETE" });

    expect(response.status).toBe(204);
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
  });
});
