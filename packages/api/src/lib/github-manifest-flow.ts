import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { controlPlaneCookieName } from "./cookies.js";

export const GITHUB_MANIFEST_FLOW_COOKIE = controlPlaneCookieName("quillra_github_manifest_flow");
export const GITHUB_MANIFEST_FLOW_COOKIE_PATH = "/";
export const GITHUB_MANIFEST_FLOW_TTL_MS = 10 * 60_000;

const MAX_ACTIVE_FLOWS = 64;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type ConsumeFailure = "missing" | "mismatch" | "invalid" | "expired";

export type ManifestFlowConsumeResult = { ok: true } | { ok: false; reason: ConsumeFailure };

/** Build a readable, globally-disambiguated GitHub App name (max 34 chars). */
export function githubAppManifestName(
  instanceName: string,
  origin: string,
  installationSecret: string,
): string {
  const host = new URL(origin).host;
  const readable = `${instanceName.trim() || "Quillra"} @ ${host}`;
  const suffix = createHash("sha256")
    .update(`quillra-github-app-name:${installationSecret}`)
    .digest("base64url")
    .slice(0, 8);
  const prefix = readable.slice(0, 34 - suffix.length - 1).trimEnd();
  return `${prefix}-${suffix}`;
}

function digest(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

function statesMatch(callbackState: string, cookieState: string): boolean {
  if (!STATE_PATTERN.test(callbackState) || !STATE_PATTERN.test(cookieState)) return false;
  const callbackBytes = Buffer.from(callbackState);
  const cookieBytes = Buffer.from(cookieState);
  return timingSafeEqual(callbackBytes, cookieBytes);
}

/**
 * Short-lived, process-local store for GitHub App manifest hand-offs.
 *
 * Quillra runs one API process per installation. Keeping only a digest in
 * memory avoids persisting or logging the browser nonce, and a restart fails
 * closed by invalidating in-flight setup hand-offs.
 */
export class GitHubManifestFlowStore {
  readonly #expiresByDigest = new Map<string, number>();

  issue(now = Date.now()): { value: string; expires: Date } {
    this.#prune(now);
    while (this.#expiresByDigest.size >= MAX_ACTIVE_FLOWS) {
      const oldest = this.#expiresByDigest.keys().next().value;
      if (!oldest) break;
      this.#expiresByDigest.delete(oldest);
    }

    const value = randomBytes(32).toString("base64url");
    const expiresAt = now + GITHUB_MANIFEST_FLOW_TTL_MS;
    this.#expiresByDigest.set(digest(value), expiresAt);
    return { value, expires: new Date(expiresAt) };
  }

  consume(
    callbackState: string | undefined,
    cookieState: string | undefined,
    now = Date.now(),
  ): ManifestFlowConsumeResult {
    if (!callbackState || !cookieState) return { ok: false, reason: "missing" };
    if (!statesMatch(callbackState, cookieState)) return { ok: false, reason: "mismatch" };

    const key = digest(callbackState);
    const expiresAt = this.#expiresByDigest.get(key);
    if (expiresAt === undefined) return { ok: false, reason: "invalid" };

    // Delete synchronously before the caller starts the network conversion.
    // Concurrent callbacks and browser replays therefore cannot reuse it.
    this.#expiresByDigest.delete(key);
    if (expiresAt <= now) return { ok: false, reason: "expired" };
    return { ok: true };
  }

  clear(): void {
    this.#expiresByDigest.clear();
  }

  #prune(now: number): void {
    for (const [key, expiresAt] of this.#expiresByDigest) {
      if (expiresAt <= now) this.#expiresByDigest.delete(key);
    }
  }
}

export const githubManifestFlowStore = new GitHubManifestFlowStore();
