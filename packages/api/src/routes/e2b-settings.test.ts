import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../lib/auth.js";

const e2bMocks = vi.hoisted(() => {
  class VerificationError extends Error {
    readonly code: "unavailable" | "probe-failed" | "cleanup-failed";

    constructor(code: VerificationError["code"]) {
      super("E2B verification failed safely.");
      this.code = code;
    }
  }
  return {
    VerificationError,
    verify: vi.fn(async () => undefined),
    rotate: vi.fn(async ({ commit }: { commit: () => void | Promise<void> }) => {
      await commit();
    }),
  };
});

vi.mock("../services/e2b-verification.js", () => ({
  E2bVerificationError: e2bMocks.VerificationError,
  verifyE2bConfiguration: e2bMocks.verify,
}));

vi.mock("../services/e2b-runtime.js", () => ({
  rotateE2BRuntimeCredentials: e2bMocks.rotate,
}));

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "QUILLRA_ENCRYPTION_KEY",
  "QUILLRA_SETUP_TOKEN",
  "E2B_ENABLED",
  "E2B_API_KEY",
  "E2B_TEMPLATE_ID",
  "E2B_VERIFIED_AT",
  "NODE_ENV",
] as const;

const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));

let tempDirectory: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;

function restoreEnvironment() {
  for (const key of CONTROLLED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadRuntime() {
  vi.resetModules();
  const [{ setupRouter }, { adminRouter }, database, settings] = await Promise.all([
    import("./setup.js"),
    import("./admin.js"),
    import("../db/index.js"),
    import("../services/instance-settings.js"),
  ]);
  openDatabase = database.rawSqlite;
  return {
    setupRouter,
    adminRouter,
    rawSqlite: database.rawSqlite,
    settings,
  };
}

function insertUser(
  database: typeof import("../db/index.js")["rawSqlite"],
  id: string,
  role: "owner" | "member",
) {
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO user
        (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(id, id, `${id}@example.com`, role, now, now);
}

function adminApp(
  router: Awaited<ReturnType<typeof loadRuntime>>["adminRouter"],
  sessionUser: SessionUser | null,
) {
  const app = new Hono<{ Variables: { user: SessionUser | null } }>();
  app.use("*", async (c, next) => {
    c.set("user", sessionUser);
    await next();
  });
  app.route("/", router);
  return app;
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-e2b-settings-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "quillra-e2b-settings-auth-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.QUILLRA_SETUP_TOKEN = "quillra-e2b-setup-token";
  process.env.NODE_ENV = "test";
  for (const key of ["E2B_ENABLED", "E2B_API_KEY", "E2B_TEMPLATE_ID", "E2B_VERIFIED_AT"] as const) {
    delete process.env[key];
  }
  e2bMocks.verify.mockReset();
  e2bMocks.verify.mockResolvedValue(undefined);
  e2bMocks.rotate.mockReset();
  e2bMocks.rotate.mockImplementation(async ({ commit }: { commit: () => void | Promise<void> }) => {
    await commit();
  });
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("E2B setup configuration", () => {
  it("requires setup access, validates input, verifies live, and never returns the key", async () => {
    const { setupRouter, rawSqlite, settings } = await loadRuntime();
    const apiKey = "e2b_setup_secret_never_returned";

    const unauthorized = await setupRouter.request("/e2b", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    expect(unauthorized.status).toBe(401);
    expect(e2bMocks.verify).not.toHaveBeenCalled();

    const unlock = await setupRouter.request("/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "quillra-e2b-setup-token" }),
    });
    const cookie = unlock.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const before = await setupRouter.request("/status", {
      headers: { Cookie: cookie },
    });
    expect((await before.json()) as { missing: string[] }).toMatchObject({
      missing: expect.arrayContaining(["E2B"]),
    });

    const invalid = await setupRouter.request("/e2b", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ apiKey: "not-an-e2b-key", templateId: "base" }),
    });
    expect(invalid.status).toBe(400);
    expect(e2bMocks.verify).not.toHaveBeenCalled();

    const configured = await setupRouter.request("/e2b", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ apiKey, templateId: "quillra-secure" }),
    });
    expect(configured.status).toBe(200);
    const responseText = await configured.text();
    expect(responseText).not.toContain(apiKey);
    const payload = JSON.parse(responseText) as {
      e2b: Record<string, unknown>;
      status: { missing: string[] };
    };
    expect(payload).toMatchObject({
      ok: true,
      e2b: {
        configured: true,
        enabled: true,
        source: "db",
        templateId: "quillra-secure",
      },
    });
    expect(payload.status.missing).not.toContain("E2B");
    expect(e2bMocks.verify).toHaveBeenCalledWith({
      apiKey,
      templateId: "quillra-secure",
    });
    expect(settings.getInstanceSetting("E2B_API_KEY")).toBe(apiKey);
    expect(settings.getInstanceSetting("E2B_ENABLED")).toBe("true");
    const stored = rawSqlite
      .prepare("SELECT value FROM instance_settings WHERE key = ?")
      .get("E2B_API_KEY") as { value: string };
    expect(stored.value).toMatch(/^v1:/);
    expect(stored.value).not.toContain(apiKey);
  });

  it("requires persisted verification state but can verify an environment-managed key", async () => {
    const apiKey = "e2b_environment_managed_secret";
    process.env.E2B_API_KEY = apiKey;
    process.env.E2B_ENABLED = "true";
    process.env.E2B_VERIFIED_AT = "2026-07-01T00:00:00.000Z";
    const { setupRouter, settings } = await loadRuntime();
    const unlock = await setupRouter.request("/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "quillra-e2b-setup-token" }),
    });
    const cookie = unlock.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect(settings.getInstanceSetting("E2B_API_KEY")).toBe(apiKey);
    expect(settings.getInstanceSetting("E2B_ENABLED")).toBeUndefined();
    expect(settings.getSetupStatus().missing).toContain("E2B");

    const response = await setupRouter.request("/e2b", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ templateId: "base" }),
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain(apiKey);
    expect(e2bMocks.verify).toHaveBeenCalledWith({ apiKey, templateId: "base" });
    expect(settings.getInstanceSetting("E2B_ENABLED")).toBe("true");
    expect(settings.getSetupStatus().missing).not.toContain("E2B");
  });

  it("rejects generic E2B writes before applying any other setup value", async () => {
    const { setupRouter, settings } = await loadRuntime();
    const unlock = await setupRouter.request("/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "quillra-e2b-setup-token" }),
    });
    const cookie = unlock.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const response = await setupRouter.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        values: {
          E2B_API_KEY: "e2b_bypass_attempt",
          INSTANCE_NAME: "Must not be written",
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(settings.getInstanceSetting("E2B_API_KEY")).toBeUndefined();
    expect(settings.getInstanceSetting("INSTANCE_NAME")).toBeUndefined();
    expect(e2bMocks.verify).not.toHaveBeenCalled();
  });
});

describe("E2B owner settings", () => {
  it("enforces owner access and returns status without a credential value", async () => {
    const { adminRouter, rawSqlite, settings } = await loadRuntime();
    insertUser(rawSqlite, "owner-1", "owner");
    insertUser(rawSqlite, "member-1", "member");
    settings.setInstanceSettingsAtomically([
      { key: "E2B_API_KEY", value: "e2b_status_secret" },
      { key: "E2B_ENABLED", value: "true" },
      { key: "E2B_TEMPLATE_ID", value: "base" },
    ]);

    const unauthenticated = await adminApp(adminRouter, null).request("/e2b");
    expect(unauthenticated.status).toBe(401);
    const member = await adminApp(adminRouter, {
      id: "member-1",
      name: "Member",
      email: "member-1@example.com",
    } as SessionUser).request("/e2b");
    expect(member.status).toBe(403);

    const owner = adminApp(adminRouter, {
      id: "owner-1",
      name: "Owner",
      email: "owner-1@example.com",
    } as SessionUser);
    const response = await owner.request("/e2b");
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain("e2b_status_secret");
    expect(JSON.parse(responseText)).toEqual({
      configured: true,
      enabled: true,
      source: "db",
      templateId: "base",
      verifiedAt: null,
    });
  });

  it("keeps the previous configuration when verification or cleanup fails", async () => {
    const { adminRouter, rawSqlite, settings } = await loadRuntime();
    insertUser(rawSqlite, "owner-1", "owner");
    settings.setInstanceSettingsAtomically([
      { key: "E2B_API_KEY", value: "e2b_previous_secret" },
      { key: "E2B_ENABLED", value: "true" },
      { key: "E2B_TEMPLATE_ID", value: "previous-template" },
      { key: "E2B_VERIFIED_AT", value: "2026-07-01T00:00:00.000Z" },
    ]);
    const owner = adminApp(adminRouter, {
      id: "owner-1",
      name: "Owner",
      email: "owner-1@example.com",
    } as SessionUser);
    const replacementKey = "e2b_replacement_secret";

    e2bMocks.verify.mockRejectedValueOnce(new e2bMocks.VerificationError("unavailable"));
    const verificationFailure = await owner.request("/e2b", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: replacementKey, templateId: "new-template" }),
    });
    expect(verificationFailure.status).toBe(502);
    expect(await verificationFailure.text()).not.toContain(replacementKey);
    expect(settings.getInstanceSetting("E2B_API_KEY")).toBe("e2b_previous_secret");
    expect(settings.getInstanceSetting("E2B_TEMPLATE_ID")).toBe("previous-template");
    expect(e2bMocks.rotate).not.toHaveBeenCalled();

    e2bMocks.verify.mockResolvedValueOnce(undefined);
    e2bMocks.rotate.mockRejectedValueOnce(new Error(`cleanup leaked ${replacementKey}`));
    const cleanupFailure = await owner.request("/e2b", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: replacementKey, templateId: "new-template" }),
    });
    expect(cleanupFailure.status).toBe(502);
    expect(await cleanupFailure.text()).not.toContain(replacementKey);
    expect(settings.getInstanceSetting("E2B_API_KEY")).toBe("e2b_previous_secret");
    expect(settings.getInstanceSetting("E2B_TEMPLATE_ID")).toBe("previous-template");
  });

  it("replaces and resets credentials only inside the runtime rotation hook", async () => {
    const { adminRouter, rawSqlite, settings } = await loadRuntime();
    insertUser(rawSqlite, "owner-1", "owner");
    settings.setInstanceSettingsAtomically([
      { key: "E2B_API_KEY", value: "e2b_old_secret" },
      { key: "E2B_ENABLED", value: "true" },
      { key: "E2B_TEMPLATE_ID", value: "old-template" },
    ]);
    const owner = adminApp(adminRouter, {
      id: "owner-1",
      name: "Owner",
      email: "owner-1@example.com",
    } as SessionUser);

    const replacementKey = "e2b_new_secret";
    const replace = await owner.request("/e2b", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: replacementKey, templateId: "new-template" }),
    });
    expect(replace.status).toBe(200);
    expect(await replace.text()).not.toContain(replacementKey);
    expect(e2bMocks.rotate).toHaveBeenLastCalledWith({
      oldApiKey: "e2b_old_secret",
      commit: expect.any(Function),
    });
    expect(settings.getInstanceSetting("E2B_API_KEY")).toBe(replacementKey);
    expect(settings.getInstanceSetting("E2B_TEMPLATE_ID")).toBe("new-template");

    const reset = await owner.request("/e2b", { method: "DELETE" });
    expect(reset.status).toBe(200);
    expect(await reset.text()).not.toContain(replacementKey);
    expect(e2bMocks.rotate).toHaveBeenLastCalledWith({
      oldApiKey: replacementKey,
      commit: expect.any(Function),
    });
    expect(settings.getInstanceSetting("E2B_ENABLED")).toBe("false");
    expect(settings.getInstanceSetting("E2B_API_KEY")).toBeUndefined();
    expect(settings.getInstanceSetting("E2B_TEMPLATE_ID")).toBeUndefined();
  });

  it("disables an environment-managed key without claiming to delete it", async () => {
    const apiKey = "e2b_environment_reset_secret";
    process.env.E2B_API_KEY = apiKey;
    const { adminRouter, rawSqlite, settings } = await loadRuntime();
    insertUser(rawSqlite, "owner-1", "owner");
    settings.setInstanceSettingsAtomically([
      { key: "E2B_ENABLED", value: "true" },
      { key: "E2B_VERIFIED_AT", value: "2026-07-01T00:00:00.000Z" },
    ]);
    const owner = adminApp(adminRouter, {
      id: "owner-1",
      name: "Owner",
      email: "owner-1@example.com",
    } as SessionUser);

    const response = await owner.request("/e2b", { method: "DELETE" });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain(apiKey);
    expect(JSON.parse(responseText)).toMatchObject({
      e2b: {
        configured: true,
        enabled: false,
        source: "env",
      },
    });
    expect(e2bMocks.rotate).toHaveBeenCalledWith({
      oldApiKey: apiKey,
      commit: expect.any(Function),
    });
    expect(settings.getInstanceSetting("E2B_API_KEY")).toBe(apiKey);
    expect(settings.getInstanceSetting("E2B_ENABLED")).toBe("false");
    expect(settings.getSetupStatus().missing).toContain("E2B");
  });
});
