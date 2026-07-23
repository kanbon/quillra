import { randomBytes } from "node:crypto";
import {
  type PreviewOriginConfig,
  isPreviewHostForProject,
  normalizePreviewHostAuthority,
} from "./preview-origin.js";
import { getActiveProjectByPort, getProjectByPort } from "./preview-status.js";

export const PREVIEW_CAPABILITY_TTL_MS = 8 * 60 * 60 * 1_000;
export const PREVIEW_HANDOFF_TTL_MS = 60 * 1_000;
const MAX_PENDING_HANDOFFS_PER_PROJECT = 64;
export const MAX_PREVIEW_SESSIONS_PER_PROJECT = 64;

type PreviewCapability = {
  token: string;
  projectId: string;
  port: number;
  expiresAt: number;
};

type PreviewHostHandoff = PreviewCapability & {
  host: string;
  capabilityToken: string;
};

type PreviewHostSession = PreviewHostHandoff;

const capabilitiesByToken = new Map<string, PreviewCapability>();
const tokenByProject = new Map<string, string>();
const handoffsByToken = new Map<string, PreviewHostHandoff>();
const handoffTokensByProject = new Map<string, Set<string>>();
const sessionsByToken = new Map<string, PreviewHostSession>();
const sessionTokensByProject = new Map<string, Set<string>>();

function randomToken(): string {
  let token = "";
  do {
    token = randomBytes(24).toString("base64url");
  } while (
    capabilitiesByToken.has(token) ||
    handoffsByToken.has(token) ||
    sessionsByToken.has(token)
  );
  return token;
}

function trackProjectToken(
  projectTokens: Map<string, Set<string>>,
  projectId: string,
  token: string,
): void {
  const tokens = projectTokens.get(projectId) ?? new Set<string>();
  tokens.add(token);
  projectTokens.set(projectId, tokens);
}

function untrackProjectToken(
  projectTokens: Map<string, Set<string>>,
  projectId: string,
  token: string,
): void {
  const tokens = projectTokens.get(projectId);
  tokens?.delete(token);
  if (tokens?.size === 0) projectTokens.delete(projectId);
}

function removeHandoff(record: PreviewHostHandoff): void {
  handoffsByToken.delete(record.token);
  untrackProjectToken(handoffTokensByProject, record.projectId, record.token);
}

function removeSession(record: PreviewHostSession): void {
  sessionsByToken.delete(record.token);
  untrackProjectToken(sessionTokensByProject, record.projectId, record.token);
}

function revokeProjectHostCredentials(projectId: string): void {
  for (const token of handoffTokensByProject.get(projectId) ?? []) {
    const record = handoffsByToken.get(token);
    if (record) handoffsByToken.delete(record.token);
  }
  handoffTokensByProject.delete(projectId);

  for (const token of sessionTokensByProject.get(projectId) ?? []) {
    const record = sessionsByToken.get(token);
    if (record) sessionsByToken.delete(record.token);
  }
  sessionTokensByProject.delete(projectId);
}

function pruneProjectHostCredentials(projectId: string, now: number): void {
  for (const token of [...(handoffTokensByProject.get(projectId) ?? [])]) {
    const record = handoffsByToken.get(token);
    if (!record || record.expiresAt <= now) {
      if (record) removeHandoff(record);
      else untrackProjectToken(handoffTokensByProject, projectId, token);
    }
  }
  for (const token of [...(sessionTokensByProject.get(projectId) ?? [])]) {
    const record = sessionsByToken.get(token);
    if (!record || record.expiresAt <= now) {
      if (record) removeSession(record);
      else untrackProjectToken(sessionTokensByProject, projectId, token);
    }
  }
}

function removeCapability(record: PreviewCapability): void {
  capabilitiesByToken.delete(record.token);
  if (tokenByProject.get(record.projectId) === record.token) {
    tokenByProject.delete(record.projectId);
  }
  revokeProjectHostCredentials(record.projectId);
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
    token: randomToken(),
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

export type PreviewHandoffExchangeResult =
  | {
      ok: true;
      token: string;
      projectId: string;
      port: number;
      host: string;
      expiresAt: number;
    }
  | { ok: false };

function resolveToken(token: string, now: number): PreviewCapabilityResult {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return { ok: false };
  const record = capabilitiesByToken.get(token);
  if (!record) return { ok: false };
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

/** Resolve the long-lived bearer used only by the compatibility path proxy. */
export function resolvePreviewCapabilityToken(
  token: string,
  now = Date.now(),
): PreviewCapabilityResult {
  return resolveToken(token, now);
}

/** Validate an opaque capability without relying on sandbox-blocked cookies. */
export function resolvePreviewCapability(
  rawPort: string,
  token: string,
  now = Date.now(),
): PreviewCapabilityResult {
  if (!/^\d{1,5}$/.test(rawPort)) return { ok: false };
  const port = Number(rawPort);
  const record = resolveToken(token, now);
  return record.ok && record.port === port ? record : { ok: false };
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

export function resolveActivePreviewCapabilityToken(
  token: string,
  now = Date.now(),
): PreviewCapabilityResult {
  const record = resolveToken(token, now);
  if (!record.ok || getActiveProjectByPort(record.port) !== record.projectId) return { ok: false };
  return record;
}

export function resolveReservedPreviewCapabilityToken(
  token: string,
  now = Date.now(),
): PreviewCapabilityResult {
  const record = resolveToken(token, now);
  if (!record.ok || getProjectByPort(record.port) !== record.projectId) return { ok: false };
  return record;
}

/**
 * Mint a short-lived browser-navigation handoff. It is deliberately separate
 * from the long-lived path-mode capability and may only be exchanged once for
 * a host-bound HttpOnly session.
 */
export function issuePreviewHandoff(
  projectId: string,
  port: number,
  hostHeader: string,
  now = Date.now(),
): PreviewCapability {
  pruneProjectHostCredentials(projectId, now);
  const host = normalizePreviewHostAuthority(hostHeader);
  const capabilityToken = tokenByProject.get(projectId);
  const capability = capabilityToken ? capabilitiesByToken.get(capabilityToken) : undefined;
  if (!host || !capability || capability.port !== port || capability.expiresAt <= now) {
    throw new Error("Cannot issue a preview handoff without a live project capability");
  }

  const record: PreviewHostHandoff = {
    token: randomToken(),
    projectId,
    port,
    host,
    capabilityToken: capability.token,
    expiresAt: Math.min(capability.expiresAt, now + PREVIEW_HANDOFF_TTL_MS),
  };
  const pending = handoffTokensByProject.get(projectId);
  while ((pending?.size ?? 0) >= MAX_PENDING_HANDOFFS_PER_PROJECT) {
    const oldestToken = pending?.values().next().value;
    if (typeof oldestToken !== "string") break;
    const oldest = handoffsByToken.get(oldestToken);
    if (oldest) removeHandoff(oldest);
    else untrackProjectToken(handoffTokensByProject, projectId, oldestToken);
  }
  handoffsByToken.set(record.token, record);
  trackProjectToken(handoffTokensByProject, projectId, record.token);
  return {
    token: record.token,
    projectId: record.projectId,
    port: record.port,
    expiresAt: record.expiresAt,
  };
}

/**
 * Atomically consume a one-time handoff and mint a different host session
 * token. There are no awaits between deleting the handoff and storing the
 * session, so two requests in this process cannot both exchange it.
 */
export function consumeReservedPreviewHandoff(
  token: string,
  hostHeader: string,
  now = Date.now(),
): PreviewHandoffExchangeResult {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return { ok: false };
  const host = normalizePreviewHostAuthority(hostHeader);
  const handoff = handoffsByToken.get(token);
  if (!host || !handoff) return { ok: false };
  if (handoff.expiresAt <= now) {
    removeHandoff(handoff);
    return { ok: false };
  }
  if (handoff.host !== host || getProjectByPort(handoff.port) !== handoff.projectId) {
    return { ok: false };
  }
  const capability = resolveToken(handoff.capabilityToken, now);
  if (
    !capability.ok ||
    capability.projectId !== handoff.projectId ||
    capability.port !== handoff.port
  ) {
    removeHandoff(handoff);
    return { ok: false };
  }

  // Consume before minting. Even if entropy generation unexpectedly fails,
  // this bearer can never be replayed.
  removeHandoff(handoff);
  pruneProjectHostCredentials(handoff.projectId, now);
  const activeSessions = sessionTokensByProject.get(handoff.projectId);
  while ((activeSessions?.size ?? 0) >= MAX_PREVIEW_SESSIONS_PER_PROJECT) {
    const oldestToken = activeSessions?.values().next().value;
    if (typeof oldestToken !== "string") break;
    const oldest = sessionsByToken.get(oldestToken);
    if (oldest) removeSession(oldest);
    else untrackProjectToken(sessionTokensByProject, handoff.projectId, oldestToken);
  }
  const session: PreviewHostSession = {
    ...handoff,
    token: randomToken(),
    expiresAt: capability.expiresAt,
  };
  sessionsByToken.set(session.token, session);
  trackProjectToken(sessionTokensByProject, session.projectId, session.token);
  return {
    ok: true,
    token: session.token,
    projectId: session.projectId,
    port: session.port,
    host: session.host,
    expiresAt: session.expiresAt,
  };
}

function resolveHostSession(
  token: string,
  hostHeader: string,
  now: number,
): PreviewCapabilityResult {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return { ok: false };
  const host = normalizePreviewHostAuthority(hostHeader);
  const session = sessionsByToken.get(token);
  if (!host || !session) return { ok: false };
  if (session.expiresAt <= now) {
    removeSession(session);
    return { ok: false };
  }
  if (session.host !== host) return { ok: false };
  const capability = resolveToken(session.capabilityToken, now);
  if (
    !capability.ok ||
    capability.projectId !== session.projectId ||
    capability.port !== session.port
  ) {
    removeSession(session);
    return { ok: false };
  }
  return {
    ok: true,
    projectId: session.projectId,
    port: session.port,
    expiresAt: session.expiresAt,
  };
}

export function resolveActivePreviewSessionToken(
  token: string,
  hostHeader: string,
  now = Date.now(),
): PreviewCapabilityResult {
  const record = resolveHostSession(token, hostHeader, now);
  if (!record.ok || getActiveProjectByPort(record.port) !== record.projectId) {
    return { ok: false };
  }
  return record;
}

export function resolveReservedPreviewSessionToken(
  token: string,
  hostHeader: string,
  now = Date.now(),
): PreviewCapabilityResult {
  const record = resolveHostSession(token, hostHeader, now);
  if (!record.ok || getProjectByPort(record.port) !== record.projectId) return { ok: false };
  return record;
}

/**
 * Caddy asks whether a preview hostname may receive an on-demand certificate
 * before the browser's HTTP request (and access token) reaches Quillra.
 * Only a currently reserved, opaque project hostname is eligible.
 */
export function resolveReservedPreviewHost(
  hostHeader: string,
  config: PreviewOriginConfig,
  now = Date.now(),
  environment: Record<string, string | undefined> = process.env,
): PreviewCapabilityResult {
  for (const record of capabilitiesByToken.values()) {
    if (record.expiresAt <= now) {
      removeCapability(record);
      continue;
    }
    if (
      getProjectByPort(record.port) === record.projectId &&
      isPreviewHostForProject(hostHeader, record.projectId, config, environment)
    ) {
      return {
        ok: true,
        projectId: record.projectId,
        port: record.port,
        expiresAt: record.expiresAt,
      };
    }
  }
  return { ok: false };
}

export function revokePreviewCapability(projectId: string): void {
  const token = tokenByProject.get(projectId);
  const record = token ? capabilitiesByToken.get(token) : undefined;
  if (record) removeCapability(record);
  else {
    tokenByProject.delete(projectId);
    revokeProjectHostCredentials(projectId);
  }
}
