import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "qra_";
const TOKEN_PURPOSE = "quillra.server-access.v1";
const SESSION_PURPOSE = "quillra.server-access-session.v1";
const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1_000;

export const SERVER_ACCESS_COOKIE = "quillra_server_access";

let loggedInstructions = false;

function signingSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is required before server access can be verified.");
  }
  return secret;
}

function hmac(value: string): string {
  return createHmac("sha256", signingSecret()).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function configuredToken(): { token: string; explicit: boolean } {
  const explicitToken = process.env.QUILLRA_SETUP_TOKEN?.trim();
  if (explicitToken) return { token: explicitToken, explicit: true };

  return {
    token: `${TOKEN_PREFIX}${hmac(TOKEN_PURPOSE).slice(0, 32)}`,
    explicit: false,
  };
}

/**
 * Validate the operator-only token used for first-run setup and emergency
 * no-email account recovery. A deterministic fallback is derived from the
 * instance's own auth secret, so a fresh install remains usable without
 * introducing a shared or hard-coded credential.
 */
export function verifyServerAccessToken(candidate: string | undefined): boolean {
  const normalized = candidate?.trim();
  if (!normalized) return false;
  return safeEqual(normalized, configuredToken().token);
}

/** Mint a short-lived, signed browser session after the operator proves server access. */
export function issueServerAccessSession(now = Date.now()): {
  value: string;
  expires: Date;
} {
  const expires = new Date(now + DEFAULT_SESSION_TTL_MS);
  const payload = `v1.${expires.getTime().toString(36)}.${randomBytes(12).toString("base64url")}`;
  return { value: `${payload}.${hmac(`${SESSION_PURPOSE}:${payload}`)}`, expires };
}

export function verifyServerAccessSession(value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const payload = parts.slice(0, 3).join(".");
  const signature = parts[3] ?? "";
  if (!safeEqual(signature, hmac(`${SESSION_PURPOSE}:${payload}`))) return false;
  const expiresAt = Number.parseInt(parts[1] ?? "", 36);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/**
 * Tell the server operator how to obtain access without returning the token
 * to the browser. The derived fallback is intentionally visible only in
 * local/container logs, the same trust boundary as shell access.
 */
export function logServerAccessInstructions(): void {
  if (loggedInstructions) return;
  loggedInstructions = true;
  const access = configuredToken();
  if (access.explicit) {
    console.info(
      "[setup] Server access is protected by QUILLRA_SETUP_TOKEN. Enter that value in the setup or recovery screen.",
    );
    return;
  }
  console.warn(
    `[setup] Server access token: ${access.token} (set QUILLRA_SETUP_TOKEN to choose your own value)`,
  );
}

/** Reset one-time logging between isolated module tests. */
export function resetServerAccessLogForTests(): void {
  loggedInstructions = false;
}
