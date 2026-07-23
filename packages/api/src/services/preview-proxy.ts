const SENSITIVE_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "authorization",
  "cf-access-jwt-assertion",
  "cf-authorization-token",
  "connection",
  "cookie",
  "cookie2",
  "host",
  "keep-alive",
  "origin",
  "proxy-authorization",
  "proxy-connection",
  "referer",
  "sec-websocket-protocol",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-access-token",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-forwarded-client-cert",
  "x-xsrf-token",
]);

const UNSAFE_RESPONSE_HEADERS = [
  "alt-svc",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "clear-site-data",
  "connection",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "keep-alive",
  "nel",
  "origin-agent-cluster",
  "proxy-connection",
  "proxy-authenticate",
  "refresh",
  "report-to",
  "service-worker-allowed",
  "set-cookie",
  "set-cookie2",
  "strict-transport-security",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "www-authenticate",
] as const;

const HIDE_DEV_TOOLBARS_CSS = `
<style data-quillra-preview>
  astro-dev-toolbar { display: none !important; }
  #__next-build-watcher, [data-nextjs-toast-wrapper] { display: none !important; }
  #svelte-kit-toolbar, [data-sveltekit-dev-toolbar] { display: none !important; }
</style>
`;

/** Hide framework chrome without suppressing compile/runtime error overlays. */
export async function injectPreviewToolbarCss(upstream: Response): Promise<Response> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (upstream.status !== 200 || !contentType.includes("text/html")) return upstream;
  const cloned = upstream.clone();
  try {
    const html = await cloned.text();
    const injected = html.includes("</head>")
      ? html.replace("</head>", `${HIDE_DEV_TOOLBARS_CSS}</head>`)
      : `${HIDE_DEV_TOOLBARS_CSS}${html}`;
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(injected, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return upstream;
  }
}

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

/**
 * Host previews use one private cookie to prove access. It is consumed by the
 * gateway and must never reach repository code. Quillra control-plane cookies
 * are stripped as defense in depth; unrelated project cookies may pass.
 */
export function sanitizeHostPreviewRequestHeaders(
  input: Headers,
  accessCookieName: string,
): Headers {
  const originalCookie = input.get("cookie") ?? "";
  const headers = sanitizePreviewRequestHeaders(input);
  const projectCookies = originalCookie
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      const separator = value.indexOf("=");
      const name = separator === -1 ? value : value.slice(0, separator);
      return !isControlPlaneCookie(name, accessCookieName);
    });
  if (projectCookies.length > 0) headers.set("cookie", projectCookies.join("; "));
  return headers;
}

function isControlPlaneCookie(name: string, accessCookieName: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === accessCookieName.toLowerCase() ||
    normalized.startsWith("quillra_") ||
    normalized.startsWith("better-auth.") ||
    normalized.startsWith("__secure-better-auth.") ||
    normalized.startsWith("__host-better-auth.")
  );
}

function safeProjectSetCookies(input: Headers, accessCookieName: string): string[] {
  const getSetCookie = (input as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (!getSetCookie) return [];

  return getSetCookie
    .call(input)
    .map((value) => {
      const parts = value.split(";");
      const pair = parts.shift()?.trim() ?? "";
      const separator = pair.indexOf("=");
      if (separator <= 0 || isControlPlaneCookie(pair.slice(0, separator), accessCookieName)) {
        return null;
      }
      // A project may use cookies on its own isolated host, but it may never
      // widen them to the Quillra parent or another preview hostname.
      const attributes = parts.filter((part) => !/^\s*domain\s*=/i.test(part));
      return [pair, ...attributes].join(";");
    })
    .filter((value): value is string => Boolean(value));
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
  // Undici transparently decompresses fetch responses. Never forward the
  // upstream representation metadata alongside the decoded body.
  headers.delete("content-encoding");
  headers.delete("content-length");

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

function hostPreviewContentSecurityPolicy(publicUrl: string, controlOrigins: string[]): string {
  const url = new URL(publicUrl);
  const websocketOrigin = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  const frameAncestors = controlOrigins.length > 0 ? controlOrigins.join(" ") : "'none'";

  return [
    "sandbox allow-scripts allow-forms allow-modals allow-downloads allow-same-origin",
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "media-src 'self' data: blob: https:",
    `connect-src 'self' ${websocketOrigin} https: wss:`,
    // Blob workers remain available, but persistent same-origin Service
    // Workers must not outlive a revoked preview capability.
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'self' https:",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

function rewriteHostPreviewLocation(
  location: string,
  publicUrl: string,
  port: number,
  controlOrigins: string[],
): string | null {
  const outer = new URL(publicUrl);
  try {
    if (!/^[A-Za-z][A-Za-z\d+.-]*:/.test(location) && !location.startsWith("//")) {
      const internal = new URL(
        location,
        `http://127.0.0.1:${port}${outer.pathname}${outer.search}`,
      );
      return `${internal.pathname}${internal.search}${internal.hash}`;
    }

    const target = new URL(location, outer);
    if (!["http:", "https:"].includes(target.protocol)) return null;
    if (
      ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) &&
      (!target.port || Number(target.port) === port)
    ) {
      return `${outer.origin}${target.pathname}${target.search}${target.hash}`;
    }
    if (controlOrigins.includes(target.origin)) return null;
    return target.toString();
  } catch {
    return null;
  }
}

/** Security headers for a real per-project preview origin. */
export function secureHostPreviewResponseHeaders(
  input: Headers,
  publicUrl: string,
  port: number,
  controlOrigins: string[],
  accessCookieName = "__Host-quillra_preview",
): Headers {
  const projectCookies = safeProjectSetCookies(input, accessCookieName);
  const headers = new Headers(input);
  for (const name of UNSAFE_RESPONSE_HEADERS) headers.delete(name);
  headers.delete("content-encoding");
  headers.delete("content-length");
  for (const cookie of projectCookies) headers.append("set-cookie", cookie);

  const location = headers.get("location");
  if (location) {
    const rewritten = rewriteHostPreviewLocation(location, publicUrl, port, controlOrigins);
    if (rewritten) headers.set("location", rewritten);
    else headers.delete("location");
  }

  headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    hostPreviewContentSecurityPolicy(publicUrl, controlOrigins),
  );
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.delete("x-frame-options");
  return headers;
}

export function secureHostPreviewResponse(
  upstream: Response,
  publicUrl: string,
  port: number,
  controlOrigins: string[],
  accessCookieName?: string,
): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: secureHostPreviewResponseHeaders(
      upstream.headers,
      publicUrl,
      port,
      controlOrigins,
      accessCookieName,
    ),
  });
}
