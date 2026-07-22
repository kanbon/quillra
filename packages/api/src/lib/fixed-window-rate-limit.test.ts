import { describe, expect, it } from "vitest";
import {
  FixedWindowRateLimiter,
  consumeSubjectAndIpRateLimit,
  fixedWindowRateLimiter,
  rateLimitFingerprint,
  resolveRequestIp,
} from "./fixed-window-rate-limit.js";

describe("FixedWindowRateLimiter", () => {
  it("blocks attempts beyond the limit until the window expires", () => {
    const limiter = new FixedWindowRateLimiter();
    const rule = { key: "login:test", limit: 2, windowMs: 10_000 };

    expect(limiter.consume(rule, 1_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume(rule, 2_000)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume(rule, 3_000)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 8,
    });
    expect(limiter.consume(rule, 11_000)).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("creates stable fingerprints without retaining the source value", () => {
    const first = rateLimitFingerprint("owner@example.com");

    expect(first).toBe(rateLimitFingerprint("owner@example.com"));
    expect(first).not.toContain("owner@example.com");
    expect(first).not.toBe(rateLimitFingerprint("other@example.com"));
  });

  it("limits a subject and source address independently", () => {
    fixedWindowRateLimiter.clear();
    const baseRule = {
      namespace: "test:otp",
      ip: "198.51.100.7",
      subjectLimit: 2,
      ipLimit: 2,
      windowMs: 60_000,
    };

    expect(
      consumeSubjectAndIpRateLimit({ ...baseRule, subject: "first@example.com" }).allowed,
    ).toBe(true);
    expect(
      consumeSubjectAndIpRateLimit({ ...baseRule, subject: "second@example.com" }).allowed,
    ).toBe(true);
    expect(
      consumeSubjectAndIpRateLimit({ ...baseRule, subject: "third@example.com" }).allowed,
    ).toBe(false);
    fixedWindowRateLimiter.clear();
  });

  it("uses only the proxy-appended address from a trusted private hop", () => {
    expect(resolveRequestIp("172.18.0.1", "spoofed, 198.51.100.7")).toBe("198.51.100.7");
    expect(resolveRequestIp("::ffff:127.0.0.1", "203.0.113.4")).toBe("203.0.113.4");
  });

  it("ignores forwarding headers on public or unbound sockets", () => {
    expect(resolveRequestIp("198.51.100.9", "203.0.113.4")).toBe("198.51.100.9");
    expect(resolveRequestIp(undefined, "203.0.113.4")).toBe("unknown");
  });
});
