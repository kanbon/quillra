import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  issueServerAccessSession,
  verifyServerAccessSession,
  verifyServerAccessToken,
} from "./server-access.js";

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "server-access-test-secret");
  vi.stubEnv("QUILLRA_SETUP_TOKEN", "operator-chosen-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server access", () => {
  it("accepts only the configured token", () => {
    expect(verifyServerAccessToken("operator-chosen-token")).toBe(true);
    expect(verifyServerAccessToken("wrong-token")).toBe(false);
    expect(verifyServerAccessToken(undefined)).toBe(false);
  });

  it("issues signed sessions that expire and reject tampering", () => {
    const now = Date.now();
    const session = issueServerAccessSession(now);

    expect(verifyServerAccessSession(session.value, now + 1_000)).toBe(true);
    expect(verifyServerAccessSession(`${session.value}x`, now + 1_000)).toBe(false);
    expect(verifyServerAccessSession(session.value, session.expires.getTime())).toBe(false);
  });

  it("derives an instance-specific fallback when no token is configured", () => {
    vi.stubEnv("QUILLRA_SETUP_TOKEN", "");
    const expected = `qra_${createHmac("sha256", "server-access-test-secret")
      .update("quillra.server-access.v1")
      .digest("base64url")
      .slice(0, 32)}`;
    expect(verifyServerAccessToken(expected)).toBe(true);
    expect(verifyServerAccessToken("operator-chosen-token")).toBe(false);
  });
});
