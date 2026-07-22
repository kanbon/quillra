import { createHash } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

type Bucket = {
  count: number;
  resetAt: number;
};

const MAX_BUCKETS = 10_000;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export type RateLimitRule = {
  key: string;
  limit: number;
  windowMs: number;
};

export type SubjectAndIpRateLimitRule = {
  namespace: string;
  subject: string;
  ip: string;
  subjectLimit: number;
  ipLimit: number;
  windowMs: number;
};

/**
 * Small process-local limiter for abuse-sensitive endpoints. It intentionally
 * has no background timer, so importing it never keeps a CLI or test alive.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private checksSinceSweep = 0;

  consume({ key, limit, windowMs }: RateLimitRule, now = Date.now()): RateLimitResult {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError("Rate limit and window must be positive");
    }

    this.sweepExpiredBuckets(now);
    const current = this.buckets.get(key);
    const bucket =
      !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
    if (bucket.count >= limit) {
      this.buckets.set(key, bucket);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, limit - bucket.count),
      retryAfterSeconds,
    };
  }

  /** Useful when an operator rotates access state, and for isolated tests. */
  clear(): void {
    this.buckets.clear();
    this.checksSinceSweep = 0;
  }

  private sweepExpiredBuckets(now: number): void {
    this.checksSinceSweep += 1;
    if (this.checksSinceSweep < 256 && this.buckets.size < MAX_BUCKETS) return;
    this.checksSinceSweep = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    while (this.buckets.size >= MAX_BUCKETS) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }
}

/** Shared limiter used by login and setup routes in this API process. */
export const fixedWindowRateLimiter = new FixedWindowRateLimiter();

/** Avoid retaining raw email addresses or access tokens in limiter keys. */
export function rateLimitFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Apply independent limits to an account-like subject and its source address. */
export function consumeSubjectAndIpRateLimit({
  namespace,
  subject,
  ip,
  subjectLimit,
  ipLimit,
  windowMs,
}: SubjectAndIpRateLimitRule): RateLimitResult {
  const subjectResult = fixedWindowRateLimiter.consume({
    key: `${namespace}:subject:${rateLimitFingerprint(subject)}`,
    limit: subjectLimit,
    windowMs,
  });
  if (!subjectResult.allowed) return subjectResult;

  return fixedWindowRateLimiter.consume({
    key: `${namespace}:ip:${rateLimitFingerprint(ip)}`,
    limit: ipLimit,
    windowMs,
  });
}

function isPrivateAddress(address: string): boolean {
  const lowerAddress = address.toLowerCase();
  const normalized = lowerAddress.startsWith("::ffff:") ? lowerAddress.slice(7) : lowerAddress;
  if (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  ) {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

/**
 * Resolve an address through one trusted local/private reverse proxy.
 *
 * A proxy appends its observed peer to X-Forwarded-For, so the right-most
 * entry is the only one a public client cannot choose. Direct public sockets
 * never get to override their address with a forwarding header.
 */
export function resolveRequestIp(
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
): string {
  if (!socketAddress || !isPrivateAddress(socketAddress)) return socketAddress ?? "unknown";
  const proxyAddress = forwardedFor
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  return proxyAddress ?? socketAddress;
}

/** Resolve the originating address both behind a proxy and in direct Node requests. */
export function getRequestIp(c: Context): string {
  let socketAddress: string | undefined;
  try {
    socketAddress = getConnInfo(c).remote.address;
  } catch {
    // Hono's in-memory request helper has no Node socket binding.
  }

  return resolveRequestIp(socketAddress, c.req.header("x-forwarded-for"));
}
