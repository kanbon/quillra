import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateOtpCode, hashOtpCode, otpCodeMatches } from "./otp.js";

describe("OTP helpers", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "otp-test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generates six-digit numeric codes", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it("hashes and compares codes without accepting another value", () => {
    const digest = hashOtpCode("012345");

    expect(digest).toMatch(/^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(digest).not.toContain("012345");
    expect(hashOtpCode("012345")).not.toBe(digest);
    expect(otpCodeMatches("012345", digest)).toBe(true);
    expect(otpCodeMatches("012346", digest)).toBe(false);
    expect(otpCodeMatches("012345", "not-a-valid-digest")).toBe(false);
  });

  it("accepts a legacy digest only for in-flight upgrade compatibility", () => {
    const legacy = "2224512ef44a62e580bb1c0dcb33aff688f4e7da8a488aeb4e7ca402c5cacf45";
    expect(otpCodeMatches("012345", legacy)).toBe(true);
    expect(otpCodeMatches("999999", legacy)).toBe(false);
  });
});
