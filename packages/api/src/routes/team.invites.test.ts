import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../lib/auth.js";

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "QUILLRA_SETUP_TOKEN",
  "EMAIL_PROVIDER",
  "RESEND_API_KEY",
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

async function loadRuntime() {
  vi.resetModules();
  const [
    { teamRouter },
    { teamLoginRouter },
    { clientsRouter },
    { rawSqlite },
    { issuePreviewCapability, resolvePreviewCapability },
  ] = await Promise.all([
    import("./team.js"),
    import("./team-login.js"),
    import("./clients.js"),
    import("../db/index.js"),
    import("../services/preview-capability.js"),
  ]);
  openDatabase = rawSqlite;
  return {
    clientsRouter,
    issuePreviewCapability,
    resolvePreviewCapability,
    teamRouter,
    teamLoginRouter,
    rawSqlite,
  };
}

function seedProject(
  rawSqlite: typeof import("../db/index.js")["rawSqlite"],
  projectId = "project-1",
) {
  const now = Date.now();
  rawSqlite
    .prepare(
      `INSERT OR IGNORE INTO user
         (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
       VALUES ('owner-1', 'Owner', 'owner@example.com', 1, 'owner', ?, ?)`,
    )
    .run(now, now);
  rawSqlite
    .prepare(
      `INSERT INTO projects (id, name, github_repo_full_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(projectId, projectId, `example/${projectId}`, now, now);
  if (projectId === "project-1") {
    rawSqlite
      .prepare(
        `INSERT INTO project_members
           (id, project_id, user_id, role, invited_by_user_id, created_at)
         VALUES ('owner-membership', ?, 'owner-1', 'admin', NULL, ?)`,
      )
      .run(projectId, now);
  }
}

function teamApp(
  teamRouter: Awaited<ReturnType<typeof loadRuntime>>["teamRouter"],
): Hono<{ Variables: { user: SessionUser | null } }> {
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
  app.route("/", teamRouter);
  return app;
}

async function createInvite(
  app: ReturnType<typeof teamApp>,
  email: string,
  role: "admin" | "editor" | "client" = "editor",
  name?: string,
) {
  const response = await app.request("/projects/project-1/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role, name }),
  });
  expect(response.status).toBe(200);
  return response;
}

async function requestTeamCode(
  teamLoginRouter: Awaited<ReturnType<typeof loadRuntime>>["teamLoginRouter"],
  email: string,
) {
  const response = await teamLoginRouter.request("/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
    body: JSON.stringify({ email, accessToken: "quillra-invite-test-token" }),
  });
  const body = (await response.json()) as { devCode?: string; error?: string };
  return { response, body };
}

async function verifyTeamCode(
  teamLoginRouter: Awaited<ReturnType<typeof loadRuntime>>["teamLoginRouter"],
  email: string,
  code: string,
) {
  return teamLoginRouter.request("/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
    body: JSON.stringify({ email, code }),
  });
}

function mockResend() {
  const send = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ id: "email-1" }),
  );
  vi.stubGlobal("fetch", send);
  return send;
}

function deliveredLoginCode(send: ReturnType<typeof mockResend>): string {
  const loginEmailCall = send.mock.calls.find((call) => {
    const body = JSON.parse(String(call[1]?.body)) as { subject: string };
    return body.subject.includes("sign-in code");
  });
  if (!loginEmailCall) throw new Error("Expected a login-code email");
  const mailBody = JSON.parse(String(loginEmailCall[1]?.body)) as { text: string };
  const code = mailBody.text.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error("Expected a six-digit code in the login email");
  return code;
}

function deliveredEmails(send: ReturnType<typeof mockResend>) {
  return send.mock.calls.map(
    (call) =>
      JSON.parse(String(call[1]?.body)) as {
        subject: string;
        html: string;
        text: string;
      },
  );
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-project-invites-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "quillra-project-invite-test-auth-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.QUILLRA_SETUP_TOKEN = "quillra-invite-test-token";
  process.env.EMAIL_PROVIDER = "none";
  process.env.NODE_ENV = "test";
  // biome-ignore lint/performance/noDelete: tests opt into mail delivery explicitly
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("project invite authorization", () => {
  it("sends project invitations with project branding and inherited group identity", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_project_invite_test";
    const send = mockResend();
    const { teamRouter, rawSqlite } = await loadRuntime();
    seedProject(rawSqlite);
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO project_groups
           (id, name, slug, brand_logo_url, brand_accent_color,
            brand_display_name, brand_tagline, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "group-1",
        "Internal agency group",
        "northstar",
        "https://assets.example.com/northstar-mark.png",
        "#7C3AED",
        "Northstar Group",
        "Editorial clarity, without the busywork.",
        now,
        now,
      );
    rawSqlite
      .prepare(
        `UPDATE projects
         SET name = ?, group_id = ?, brand_display_name = ?, brand_accent_color = ?
         WHERE id = ?`,
      )
      .run("internal-repository-label", "group-1", "Northstar Editorial", "#2D6A4F", "project-1");
    const app = teamApp(teamRouter);

    const response = await createInvite(app, "writer@example.com", "editor");

    await expect(response.json()).resolves.toMatchObject({
      emailConfigured: true,
      emailSent: true,
    });
    const [message] = deliveredEmails(send);
    expect(message.subject).toBe("Owner invited you to Northstar Editorial");
    expect(message.html).toContain("Northstar Editorial");
    expect(message.html).toContain("Editorial clarity, without the busywork.");
    expect(message.html).toContain("https://assets.example.com/northstar-mark.png");
    expect(message.html).toContain("#2D6A4F");
    expect(message.text).toContain("Northstar Editorial");
    expect(message.text).toContain("Editorial clarity, without the busywork.");
    for (const content of [message.subject, message.html, message.text]) {
      expect(content).not.toContain("internal-repository-label");
      expect(content).not.toContain("Northstar Group");
      expect(content).not.toContain("#7C3AED");
    }
  });

  it("does not leave access when an invite is revoked after a code was issued", async () => {
    const { teamRouter, teamLoginRouter, rawSqlite } = await loadRuntime();
    seedProject(rawSqlite);
    const app = teamApp(teamRouter);
    const email = "revoked@example.com";

    const inviteResponse = await createInvite(app, email);
    await expect(inviteResponse.json()).resolves.toMatchObject({
      emailConfigured: false,
      emailSent: false,
    });
    expect(
      rawSqlite.prepare("SELECT count(*) AS count FROM user WHERE email = ?").get(email),
    ).toEqual({ count: 0 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM project_members").get()).toEqual({
      count: 1,
    });

    const requested = await requestTeamCode(teamLoginRouter, email);
    expect(requested.response.status).toBe(200);
    expect(requested.body.devCode).toMatch(/^\d{6}$/);
    const invite = rawSqlite
      .prepare("SELECT id FROM project_invites WHERE lower(email) = ?")
      .get(email) as { id: string };
    const revoked = await app.request(`/projects/project-1/invites/${invite.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(204);

    const verified = await verifyTeamCode(teamLoginRouter, email, requested.body.devCode as string);
    expect(verified.status).toBe(409);
    expect(
      rawSqlite.prepare("SELECT count(*) AS count FROM user WHERE email = ?").get(email),
    ).toEqual({ count: 0 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM project_members").get()).toEqual({
      count: 1,
    });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_sessions").get()).toEqual({
      count: 0,
    });
  });

  it("rejects an invite that expires after a code was issued without granting access", async () => {
    const { teamRouter, teamLoginRouter, rawSqlite } = await loadRuntime();
    seedProject(rawSqlite);
    const app = teamApp(teamRouter);
    const email = "expired@example.com";

    await createInvite(app, email);
    const requested = await requestTeamCode(teamLoginRouter, email);
    expect(requested.body.devCode).toMatch(/^\d{6}$/);
    rawSqlite
      .prepare("UPDATE project_invites SET expires_at = ? WHERE lower(email) = ?")
      .run(Date.now() - 1, email);

    const verified = await verifyTeamCode(teamLoginRouter, email, requested.body.devCode as string);
    expect(verified.status).toBe(409);
    expect(
      rawSqlite.prepare("SELECT count(*) AS count FROM user WHERE email = ?").get(email),
    ).toEqual({ count: 0 });
    expect(
      rawSqlite
        .prepare("SELECT count(*) AS count FROM project_members WHERE project_id = ?")
        .get("project-1"),
    ).toEqual({ count: 1 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM team_sessions").get()).toEqual({
      count: 0,
    });
  });

  it("atomically creates a member and project membership after successful verification", async () => {
    const { teamRouter, teamLoginRouter, rawSqlite } = await loadRuntime();
    seedProject(rawSqlite);
    const app = teamApp(teamRouter);

    await createInvite(app, " New.Member@Example.COM ", "admin", "New Member");
    const requested = await requestTeamCode(teamLoginRouter, "NEW.member@example.com");
    const verified = await verifyTeamCode(
      teamLoginRouter,
      "new.member@EXAMPLE.com",
      requested.body.devCode as string,
    );

    expect(verified.status).toBe(200);
    expect(verified.headers.get("set-cookie")).toContain("quillra_team_session=");
    expect(
      rawSqlite
        .prepare(
          `SELECT id, name, email, instance_role AS role
           FROM user WHERE lower(email) = ?`,
        )
        .get("new.member@example.com"),
    ).toMatchObject({ name: "New Member", email: "new.member@example.com", role: "member" });
    const member = rawSqlite
      .prepare(
        `SELECT user_id AS userId, role, invited_by_user_id AS invitedByUserId
         FROM project_members
         WHERE project_id = 'project-1' AND user_id != 'owner-1'`,
      )
      .get() as { userId: string; role: string; invitedByUserId: string };
    expect(member).toMatchObject({ role: "admin", invitedByUserId: "owner-1" });
    expect(rawSqlite.prepare("SELECT user_id AS userId FROM team_sessions").get()).toEqual({
      userId: member.userId,
    });
    expect(
      rawSqlite.prepare("SELECT accepted_at AS acceptedAt FROM project_invites").get(),
    ).toEqual({ acceptedAt: expect.any(Number) });
  });

  it("reuses a mixed-case user and preserves their other project membership", async () => {
    const { teamRouter, teamLoginRouter, rawSqlite } = await loadRuntime();
    seedProject(rawSqlite);
    seedProject(rawSqlite, "other-project");
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES ('legacy-user', 'Legacy User', 'Legacy.User@Example.COM', 1, ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO project_members
           (id, project_id, user_id, role, invited_by_user_id, created_at)
         VALUES ('other-membership', 'other-project', 'legacy-user', 'client', 'owner-1', ?)`,
      )
      .run(now);
    const app = teamApp(teamRouter);

    await createInvite(app, "legacy.user@example.com", "editor");
    const requested = await requestTeamCode(teamLoginRouter, "LEGACY.USER@example.com");
    const verified = await verifyTeamCode(
      teamLoginRouter,
      "legacy.user@EXAMPLE.com",
      requested.body.devCode as string,
    );

    expect(verified.status).toBe(200);
    expect(
      rawSqlite
        .prepare("SELECT count(*) AS count FROM user WHERE lower(email) = ?")
        .get("legacy.user@example.com"),
    ).toEqual({ count: 1 });
    expect(
      rawSqlite.prepare("SELECT instance_role AS role FROM user WHERE id = 'legacy-user'").get(),
    ).toEqual({ role: "member" });
    expect(
      rawSqlite
        .prepare("SELECT project_id AS projectId, role FROM project_members WHERE user_id = ?")
        .all("legacy-user"),
    ).toEqual([
      { projectId: "other-project", role: "client" },
      { projectId: "project-1", role: "editor" },
    ]);
  });

  it("accepts a client invite only after its project-scoped code is verified", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_project_invite_test";
    const send = mockResend();
    const { clientsRouter, teamRouter, rawSqlite } = await loadRuntime();
    seedProject(rawSqlite);
    const app = teamApp(teamRouter);
    const email = "client.user@example.com";

    await createInvite(app, " Client.User@Example.COM ", "client");
    expect(
      rawSqlite.prepare("SELECT count(*) AS count FROM user WHERE email = ?").get(email),
    ).toEqual({ count: 0 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM project_members").get()).toEqual({
      count: 1,
    });

    const requested = await clientsRouter.request("/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1", email: "CLIENT.USER@example.com" }),
    });
    expect(requested.status).toBe(200);
    const code = deliveredLoginCode(send);

    const verified = await clientsRouter.request("/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        email: "client.user@EXAMPLE.com",
        code,
      }),
    });
    expect(verified.status).toBe(200);
    expect(verified.headers.get("set-cookie")).toContain("quillra_client_session=");
    expect(
      rawSqlite
        .prepare(
          `SELECT user.email, user.instance_role AS instanceRole, project_members.role
           FROM user
           INNER JOIN project_members ON project_members.user_id = user.id
           WHERE project_members.project_id = 'project-1' AND user.id != 'owner-1'`,
        )
        .get(),
    ).toEqual({ email, instanceRole: null, role: "client" });
    expect(
      rawSqlite.prepare("SELECT accepted_at AS acceptedAt FROM project_invites").get(),
    ).toEqual({ acceptedAt: expect.any(Number) });
  });

  it("cannot redeem a client code after the invite is revoked", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_project_invite_test";
    const send = mockResend();
    const { clientsRouter, teamRouter, rawSqlite } = await loadRuntime();
    seedProject(rawSqlite);
    const app = teamApp(teamRouter);
    const email = "revoked.client@example.com";

    await createInvite(app, email, "client");
    const requested = await clientsRouter.request("/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1", email }),
    });
    expect(requested.status).toBe(200);
    const code = deliveredLoginCode(send);
    const invite = rawSqlite.prepare("SELECT id FROM project_invites").get() as { id: string };
    expect(
      (
        await app.request(`/projects/project-1/invites/${invite.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);

    const verified = await clientsRouter.request("/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1", email, code }),
    });
    expect(verified.status).toBe(403);
    expect(
      rawSqlite.prepare("SELECT count(*) AS count FROM user WHERE email = ?").get(email),
    ).toEqual({ count: 0 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM client_sessions").get()).toEqual({
      count: 0,
    });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM project_members").get()).toEqual({
      count: 1,
    });
  });

  it("cannot redeem a client code after the invite expires", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_project_invite_test";
    const send = mockResend();
    const { clientsRouter, teamRouter, rawSqlite } = await loadRuntime();
    seedProject(rawSqlite);
    const app = teamApp(teamRouter);
    const email = "expired.client@example.com";

    await createInvite(app, email, "client");
    expect(
      (
        await clientsRouter.request("/request-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: "project-1", email }),
        })
      ).status,
    ).toBe(200);
    const code = deliveredLoginCode(send);
    rawSqlite.prepare("UPDATE project_invites SET expires_at = ?").run(Date.now() - 1);

    const verified = await clientsRouter.request("/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1", email, code }),
    });
    expect(verified.status).toBe(403);
    expect(
      rawSqlite.prepare("SELECT count(*) AS count FROM user WHERE email = ?").get(email),
    ).toEqual({ count: 0 });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM client_sessions").get()).toEqual({
      count: 0,
    });
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM project_members").get()).toEqual({
      count: 1,
    });
  });

  it("revokes the project preview capability only after a member is removed", async () => {
    const { issuePreviewCapability, rawSqlite, resolvePreviewCapability, teamRouter } =
      await loadRuntime();
    seedProject(rawSqlite);
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES ('member-1', 'Member', 'member@example.com', 1, 'member', ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO project_members
           (id, project_id, user_id, role, invited_by_user_id, created_at)
         VALUES ('member-row', 'project-1', 'member-1', 'editor', 'owner-1', ?)`,
      )
      .run(now);
    const app = teamApp(teamRouter);
    const capability = issuePreviewCapability("project-1", 4173);

    expect(
      (
        await app.request("/projects/project-1/members/missing-member", {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(resolvePreviewCapability("4173", capability.token)).toMatchObject({
      ok: true,
      projectId: "project-1",
    });

    expect(
      (
        await app.request("/projects/project-1/members/member-row", {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(resolvePreviewCapability("4173", capability.token)).toEqual({ ok: false });
  });

  it("cancels active member writers and invalidates stale role checks on role change and removal", async () => {
    const { rawSqlite, teamRouter } = await loadRuntime();
    const { projectWriterAuthorizationEpoch, registerProjectWriter } = await import(
      "../services/project-workspace-lifecycle.js"
    );
    seedProject(rawSqlite);
    const now = Date.now();
    rawSqlite
      .prepare(
        `INSERT INTO user
           (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
         VALUES ('member-1', 'Member', 'member@example.com', 1, 'member', ?, ?)`,
      )
      .run(now, now);
    rawSqlite
      .prepare(
        `INSERT INTO project_members
           (id, project_id, user_id, role, invited_by_user_id, created_at)
         VALUES ('member-row', 'project-1', 'member-1', 'editor', 'owner-1', ?)`,
      )
      .run(now);
    const app = teamApp(teamRouter);

    const staleEpoch = projectWriterAuthorizationEpoch("project-1", "member-1");
    const roleChangeCancel = vi.fn();
    const releaseRoleWriter = registerProjectWriter("project-1", roleChangeCancel, {
      userId: "member-1",
      expectedEpoch: staleEpoch,
    });
    const patched = await app.request("/projects/project-1/members/member-row", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "client" }),
    });
    expect(patched.status).toBe(200);
    expect(roleChangeCancel).toHaveBeenCalledOnce();
    expect(
      rawSqlite.prepare("SELECT role FROM project_members WHERE id = 'member-row'").get(),
    ).toEqual({ role: "client" });
    expect(() =>
      registerProjectWriter("project-1", vi.fn(), {
        userId: "member-1",
        expectedEpoch: staleEpoch,
      }),
    ).toThrow("Project authorization changed");
    releaseRoleWriter();

    const freshEpoch = projectWriterAuthorizationEpoch("project-1", "member-1");
    const removalCancel = vi.fn();
    const releaseRemovalWriter = registerProjectWriter("project-1", removalCancel, {
      userId: "member-1",
      expectedEpoch: freshEpoch,
    });
    const removed = await app.request("/projects/project-1/members/member-row", {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect(removalCancel).toHaveBeenCalledOnce();
    expect(
      rawSqlite
        .prepare("SELECT count(*) AS count FROM project_members WHERE id = 'member-row'")
        .get(),
    ).toEqual({ count: 0 });
    releaseRemovalWriter();
  });
});
