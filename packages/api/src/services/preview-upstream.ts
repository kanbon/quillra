/**
 * Server-only routing information for project previews.
 *
 * The browser receives only Quillra's capability URL. The E2B hostname and
 * traffic token stay in this process and are injected into upstream HTTP and
 * WebSocket requests by the preview gateway.
 */

export const E2B_TRAFFIC_ACCESS_HEADER = "e2b-traffic-access-token";

export type PreviewUpstream = {
  origin: string;
  headers: Readonly<Record<string, string>>;
};

type RegisteredPreviewUpstream = PreviewUpstream & {
  port: number;
};

const upstreamByProject = new Map<string, RegisteredPreviewUpstream>();

function normalizeOrigin(rawOrigin: string, allowInsecureLoopback = false): string {
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new Error("Preview upstream must be an absolute URL");
  }
  const insecureLoopback =
    allowInsecureLoopback &&
    origin.protocol === "http:" &&
    (origin.hostname === "127.0.0.1" || origin.hostname === "localhost");
  if (
    (origin.protocol !== "https:" && !insecureLoopback) ||
    origin.username ||
    origin.password ||
    (origin.pathname !== "/" && origin.pathname !== "") ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Preview upstream must be a credential-free HTTPS origin");
  }
  return origin.origin;
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const token = headers[E2B_TRAFFIC_ACCESS_HEADER]?.trim();
  if (
    !token ||
    Object.keys(headers).some((name) => name.toLowerCase() !== E2B_TRAFFIC_ACCESS_HEADER)
  ) {
    throw new Error("Preview upstream requires exactly one E2B traffic access token");
  }
  return Object.freeze({ [E2B_TRAFFIC_ACCESS_HEADER]: token });
}

export function registerPreviewUpstream(
  projectId: string,
  port: number,
  upstream: PreviewUpstream,
): void {
  if (!projectId || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid preview upstream registration");
  }
  upstreamByProject.set(projectId, {
    port,
    origin: normalizeOrigin(upstream.origin),
    headers: normalizeHeaders(upstream.headers),
  });
}

/** Used only by the standalone browser fixture, never by the application. */
export function registerLoopbackPreviewUpstreamForTests(
  projectId: string,
  port: number,
  upstream: PreviewUpstream,
): void {
  upstreamByProject.set(projectId, {
    port,
    origin: normalizeOrigin(upstream.origin, true),
    headers: normalizeHeaders(upstream.headers),
  });
}

export function unregisterPreviewUpstream(projectId: string, expectedPort?: number): void {
  const existing = upstreamByProject.get(projectId);
  if (!existing || (expectedPort !== undefined && existing.port !== expectedPort)) return;
  upstreamByProject.delete(projectId);
}

export function getPreviewUpstream(projectId: string, port: number): PreviewUpstream | null {
  const upstream = upstreamByProject.get(projectId);
  if (!upstream || upstream.port !== port) return null;
  return { origin: upstream.origin, headers: upstream.headers };
}

export function previewUpstreamUrl(
  projectId: string,
  port: number,
  pathname: string,
  search = "",
  websocket = false,
): { url: URL; headers: Readonly<Record<string, string>> } | null {
  const upstream = getPreviewUpstream(projectId, port);
  if (!upstream) return null;
  const url = new URL(upstream.origin);
  url.pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  url.search = search;
  if (websocket) url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return { url, headers: upstream.headers };
}
