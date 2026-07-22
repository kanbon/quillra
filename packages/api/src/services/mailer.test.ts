import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "QUILLRA_ENCRYPTION_KEY",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "RESEND_API_KEY",
] as const;

const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));

let tempDirectory: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;

function restoreEnvironment() {
  for (const key of CONTROLLED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
}

async function sendMessage() {
  vi.resetModules();
  const { sendEmail } = await import("./mailer.js");
  const { rawSqlite } = await import("../db/index.js");
  openDatabase = rawSqlite;
  const send = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ id: "email-1" }),
  );
  vi.stubGlobal("fetch", send);

  await expect(
    sendEmail({
      to: "recipient@example.test",
      subject: "Your sign-in code",
      text: "Code: 123456",
    }),
  ).resolves.toEqual({ sent: true, backend: "resend", id: "email-1" });

  const request = send.mock.calls[0]?.[1];
  return JSON.parse(String(request?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-mailer-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.EMAIL_PROVIDER = "resend";
  process.env.RESEND_API_KEY = "re_mailer_test_placeholder";
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("transactional email envelope", () => {
  it("uses the configured sender without adding bulk-mail headers", async () => {
    process.env.EMAIL_FROM = "Example CMS <mail@example.test>";

    await expect(sendMessage()).resolves.toEqual({
      from: "Example CMS <mail@example.test>",
      to: ["recipient@example.test"],
      subject: "Your sign-in code",
      text: "Code: 123456",
    });
  });

  it("uses a neutral local sender when EMAIL_FROM is not configured", async () => {
    Reflect.deleteProperty(process.env, "EMAIL_FROM");

    await expect(sendMessage()).resolves.toMatchObject({
      from: "Quillra <noreply@localhost>",
    });
  });
});
