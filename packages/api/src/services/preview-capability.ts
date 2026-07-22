import { randomBytes } from "node:crypto";
import { getActiveProjectByPort, getProjectByPort } from "./preview-status.js";

export const PREVIEW_CAPABILITY_TTL_MS = 8 * 60 * 60 * 1_000;

type PreviewCapability = {
  token: string;
  projectId: string;
  port: number;
  expiresAt: number;
};

const capabilitiesByToken = new Map<string, PreviewCapability>();
const tokenByProject = new Map<string, string>();

function removeCapability(record: PreviewCapability): void {
  capabilitiesByToken.delete(record.token);
  if (tokenByProject.get(record.projectId) === record.token) {
    tokenByProject.delete(record.projectId);
  }
}

/**
 * Mint a bearer capability only after the caller has authorized project
 * access. One active token per project keeps restarts/revocation predictable.
 */
export function issuePreviewCapability(
  projectId: string,
  port: number,
  now = Date.now(),
): PreviewCapability {
  const existingToken = tokenByProject.get(projectId);
  const existing = existingToken ? capabilitiesByToken.get(existingToken) : undefined;
  if (existing && existing.port === port && existing.expiresAt > now) return existing;
  if (existing) removeCapability(existing);

  const record: PreviewCapability = {
    token: randomBytes(24).toString("base64url"),
    projectId,
    port,
    expiresAt: now + PREVIEW_CAPABILITY_TTL_MS,
  };
  capabilitiesByToken.set(record.token, record);
  tokenByProject.set(projectId, record.token);
  return record;
}

export type PreviewCapabilityResult =
  | { ok: true; projectId: string; port: number; expiresAt: number }
  | { ok: false };

/** Validate an opaque capability without relying on sandbox-blocked cookies. */
export function resolvePreviewCapability(
  rawPort: string,
  token: string,
  now = Date.now(),
): PreviewCapabilityResult {
  if (!/^\d{1,5}$/.test(rawPort) || !/^[A-Za-z0-9_-]{32}$/.test(token)) return { ok: false };
  const port = Number(rawPort);
  const record = capabilitiesByToken.get(token);
  if (!record || record.port !== port) return { ok: false };
  if (record.expiresAt <= now) {
    removeCapability(record);
    return { ok: false };
  }
  return {
    ok: true,
    projectId: record.projectId,
    port: record.port,
    expiresAt: record.expiresAt,
  };
}

/**
 * Capabilities are usable only while their project still owns the port.
 * This prevents a stopped preview (or a reassigned port) from proxying an
 * unrelated loopback service with a previously issued bearer token.
 */
export function resolveActivePreviewCapability(
  rawPort: string,
  token: string,
  now = Date.now(),
): PreviewCapabilityResult {
  const record = resolvePreviewCapability(rawPort, token, now);
  if (!record.ok || getActiveProjectByPort(record.port) !== record.projectId) return { ok: false };
  return record;
}

/** Validate a capability for the boot/status surface before the child is ready. */
export function resolveReservedPreviewCapability(
  rawPort: string,
  token: string,
  now = Date.now(),
): PreviewCapabilityResult {
  const record = resolvePreviewCapability(rawPort, token, now);
  if (!record.ok || getProjectByPort(record.port) !== record.projectId) return { ok: false };
  return record;
}

export function revokePreviewCapability(projectId: string): void {
  const token = tokenByProject.get(projectId);
  const record = token ? capabilitiesByToken.get(token) : undefined;
  if (record) removeCapability(record);
  else tokenByProject.delete(projectId);
}
