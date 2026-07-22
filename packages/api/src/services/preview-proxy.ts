const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cf-access-jwt-assertion",
  "cf-authorization-token",
  "cookie",
  "cookie2",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "sec-websocket-protocol",
  "x-access-token",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-forwarded-client-cert",
  "x-xsrf-token",
]);

const UNSAFE_RESPONSE_HEADERS = [
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "clear-site-data",
  "content-security-policy",
  "content-security-policy-report-only",
  "nel",
  "origin-agent-cluster",
  "proxy-authenticate",
  "refresh",
  "report-to",
  "service-worker-allowed",
  "set-cookie",
  "set-cookie2",
  "transfer-encoding",
  "www-authenticate",
] as const;

/**
 * A repository's dev server is untrusted. Forward only browser metadata and
 * request content, never Quillra credentials or reverse-proxy identity data.
 */
export function sanitizePreviewRequestHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (
      SENSITIVE_REQUEST_HEADERS.has(lower) ||
      lower === "forwarded" ||
      lower === "x-real-ip" ||
      lower.startsWith("cf-") ||
      lower.startsWith("x-forwarded-") ||
      lower.startsWith("x-quillra-")
    ) {
      headers.delete(name);
    }
  }
  return headers;
}

function isRewritableContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return (
    value.includes("text/html") ||
    value.includes("text/css") ||
    value.includes("javascript") ||
    value.includes("ecmascript") ||
    value.includes("application/json") ||
    value.includes("image/svg+xml") ||
    value.includes("application/manifest+json")
  );
}

/**
 * Dev servers commonly emit root-relative asset and API paths. Prefix those
 * paths so they stay inside the guarded proxy instead of hitting Quillra's own
 * routes. This covers markup, transformed Vite imports, CSS URLs, and runtime
 * string URLs without touching absolute or protocol-relative URLs.
 */
export async function rewritePreviewResourcePaths(
  upstream: Response,
  port: number,
  capability: string,
): Promise<Response> {
  if (!isRewritableContentType(upstream.headers.get("content-type") ?? "")) return upstream;

  const cloned = upstream.clone();
  try {
    const prefix = previewRootPath(port, capability);
    const body = (await cloned.text())
      .replace(/(["'`])\/(?!\/|__preview\/)/g, `$1${prefix}`)
      .replace(/(url\(\s*)\/(?!\/|__preview\/)/gi, `$1${prefix}`)
      .replace(/(\s(?:action|href|poster|src)=)\/(?!\/|__preview\/)/gi, `$1${prefix}`);
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return upstream;
  }
}

function previewRootPath(port: number, capability: string): string {
  return `/__preview/${port}/${encodeURIComponent(capability)}/`;
}

function previewContentSecurityPolicy(
  requestUrl: string,
  port: number,
  capability: string,
): string {
  const origin = new URL(requestUrl).origin;
  const previewRoot = `${origin}${previewRootPath(port, capability)}`;
  const statusEndpoint = `${origin}/api/preview-status`;

  return [
    "sandbox allow-scripts allow-forms allow-modals allow-downloads",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${previewRoot}`,
    `style-src 'unsafe-inline' ${previewRoot} https:`,
    `img-src data: blob: ${previewRoot} https:`,
    `font-src data: ${previewRoot} https:`,
    `media-src data: blob: ${previewRoot} https:`,
    `connect-src ${previewRoot} ${statusEndpoint}`,
    `worker-src blob: ${previewRoot}`,
    `manifest-src ${previewRoot}`,
    `form-action ${previewRoot}`,
    `frame-ancestors ${origin}`,
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** Keep upstream redirects inside the authenticated preview proxy. */
function rewritePreviewLocation(
  location: string,
  requestUrl: string,
  port: number,
  capability: string,
): string | null {
  const previewRoot = previewRootPath(port, capability);
  const outer = new URL(requestUrl);
  const upstreamPath = outer.pathname.startsWith(previewRoot)
    ? `/${outer.pathname.slice(previewRoot.length)}`
    : "/";

  try {
    if (!/^[A-Za-z][A-Za-z\d+.-]*:/.test(location) && !location.startsWith("//")) {
      const internal = new URL(location, `http://127.0.0.1:${port}${upstreamPath}${outer.search}`);
      return `${previewRoot}${internal.pathname.replace(/^\//, "")}${internal.search}${internal.hash}`;
    }

    const external = new URL(location, outer);
    if (!["http:", "https:"].includes(external.protocol)) return null;
    if (
      ["127.0.0.1", "localhost", "[::1]"].includes(external.hostname) &&
      (!external.port || Number(external.port) === port)
    ) {
      return `${previewRoot}${external.pathname.replace(/^\//, "")}${external.search}${external.hash}`;
    }
    if (external.origin === outer.origin) {
      if (external.pathname.startsWith(previewRoot)) {
        return `${external.pathname}${external.search}${external.hash}`;
      }
      return `${previewRoot}${external.pathname.replace(/^\//, "")}${external.search}${external.hash}`;
    }
    return external.toString();
  } catch {
    return null;
  }
}

/**
 * Apply browser isolation to all proxied responses. The CSP sandbox also
 * protects the "open in new tab" view, where an iframe sandbox is absent.
 */
export function securePreviewResponseHeaders(
  input: Headers,
  requestUrl: string,
  port: number,
  capability: string,
): Headers {
  const headers = new Headers(input);
  for (const name of UNSAFE_RESPONSE_HEADERS) headers.delete(name);

  const location = headers.get("location");
  if (location) {
    const rewritten = rewritePreviewLocation(location, requestUrl, port, capability);
    if (rewritten) headers.set("location", rewritten);
    else headers.delete("location");
  }

  const link = headers.get("link");
  if (link) {
    headers.set(
      "link",
      link.replace(/<\/(?!\/|__preview\/)/g, `<${previewRootPath(port, capability)}`),
    );
  }

  const vary = headers.get("vary");
  const varies = vary
    ? vary
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  if (!varies.some((value) => value.toLowerCase() === "origin")) varies.push("Origin");
  headers.set("vary", varies.join(", "));
  headers.set("access-control-allow-origin", "null");
  headers.set("access-control-allow-headers", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    previewContentSecurityPolicy(requestUrl, port, capability),
  );
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "SAMEORIGIN");
  return headers;
}

export function securePreviewResponse(
  upstream: Response,
  requestUrl: string,
  port: number,
  capability: string,
): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: securePreviewResponseHeaders(upstream.headers, requestUrl, port, capability),
  });
}
