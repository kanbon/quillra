import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { getTrustedOrigins } from "./trusted-origins.js";

export const PREVIEW_ACCESS_QUERY = "__quillra_preview";
export const PREVIEW_ACCESS_COOKIE = "__Host-quillra_preview";
export const LOCAL_PREVIEW_ACCESS_COOKIE = "quillra_preview";

export type PreviewOriginConfig = {
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
  controlOrigins: string[];
  accessCookieName: string;
};

type PreviewEnvironment = Record<string, string | undefined>;

function parseHttpUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Resolve the optional host-based preview gateway. Production installations
 * opt in with PREVIEW_DOMAIN. Localhost uses *.localhost automatically so a
 * fresh checkout gets router-correct previews without DNS configuration.
 */
export function getPreviewOriginConfig(
  environment: PreviewEnvironment = process.env,
): PreviewOriginConfig | null {
  const controlUrl =
    parseHttpUrl(environment.BETTER_AUTH_URL) ??
    new URL(`http://localhost:${environment.PORT ?? "3000"}`);
  const configuredDomain = environment.PREVIEW_DOMAIN?.trim();

  let previewUrl: URL;
  if (configuredDomain) {
    previewUrl =
      parseHttpUrl(configuredDomain) ??
      new URL(`${controlUrl.protocol}//${configuredDomain.replace(/^\/+|\/+$/g, "")}`);
  } else if (controlUrl.hostname === "localhost") {
    previewUrl = new URL(controlUrl.origin);
  } else {
    return null;
  }

  const hostname = previewUrl.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname ||
    previewUrl.username ||
    previewUrl.password ||
    (previewUrl.pathname && previewUrl.pathname !== "/") ||
    previewUrl.search ||
    previewUrl.hash ||
    isIP(hostname) !== 0 ||
    (isLoopbackHostname(hostname) && hostname !== "localhost")
  ) {
    return null;
  }

  const origins = new Set<string>(getTrustedOrigins(environment));
  origins.add(controlUrl.origin);

  return {
    protocol: previewUrl.protocol as "http:" | "https:",
    hostname,
    port: previewUrl.port || (configuredDomain ? "" : controlUrl.port),
    controlOrigins: [
      controlUrl.origin,
      ...[...origins].filter((origin) => origin !== controlUrl.origin),
    ],
    accessCookieName:
      previewUrl.protocol === "https:" || hostname === "localhost"
        ? PREVIEW_ACCESS_COOKIE
        : LOCAL_PREVIEW_ACCESS_COOKIE,
  };
}

/** A stable, non-enumerable DNS label keeps TLS certificates reusable. */
export function previewHostLabel(
  projectId: string,
  environment: PreviewEnvironment = process.env,
): string {
  const secret = environment.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for host-based previews");
  const digest = createHmac("sha256", secret)
    .update(`quillra-preview-host\0${projectId}`)
    .digest("hex")
    .slice(0, 40);
  return `p-${digest}`;
}

export function previewHostnameForProject(
  projectId: string,
  config: PreviewOriginConfig,
  environment: PreviewEnvironment = process.env,
): string {
  return `${previewHostLabel(projectId, environment)}.${config.hostname}`;
}

function hostnameFromHostHeader(hostHeader: string): string | null {
  const value = hostHeader.trim().toLowerCase();
  if (!value || value.includes("/") || value.includes("@")) return null;
  try {
    return new URL(`http://${value}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** Return the opaque project label only for an exact preview-domain child. */
export function previewLabelFromHost(
  hostHeader: string,
  config: PreviewOriginConfig,
): string | null {
  const hostname = hostnameFromHostHeader(hostHeader);
  const suffix = `.${config.hostname}`;
  if (!hostname?.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return /^p-[a-f0-9]{40}$/.test(label) ? label : null;
}

export function isPreviewDomainChild(hostHeader: string, config: PreviewOriginConfig): boolean {
  return hostnameFromHostHeader(hostHeader)?.endsWith(`.${config.hostname}`) ?? false;
}

export function isPreviewHostForProject(
  hostHeader: string,
  projectId: string,
  config: PreviewOriginConfig,
  environment: PreviewEnvironment = process.env,
): boolean {
  return previewLabelFromHost(hostHeader, config) === previewHostLabel(projectId, environment);
}

export function buildHostPreviewUrl(
  projectId: string,
  capability: string,
  config: PreviewOriginConfig,
  environment: PreviewEnvironment = process.env,
): string {
  const hostname = previewHostnameForProject(projectId, config, environment);
  const port = config.port ? `:${config.port}` : "";
  const url = new URL(`${config.protocol}//${hostname}${port}/`);
  url.searchParams.set(PREVIEW_ACCESS_QUERY, capability);
  return url.toString();
}
