import { Buffer } from "node:buffer";
import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { WebSocket as UpstreamWebSocket } from "ws";
import { previewBootHtml } from "./preview-boot.js";
import {
  consumeReservedPreviewHandoff,
  resolveActivePreviewSessionToken,
  resolveReservedPreviewHost,
  resolveReservedPreviewSessionToken,
} from "./preview-capability.js";
import {
  PREVIEW_ACCESS_QUERY,
  getPreviewOriginConfig,
  isPreviewDomainChild,
  isPreviewHostForProject,
  previewHostnameForProject,
  previewLabelFromHost,
} from "./preview-origin.js";
import {
  PREVIEW_UPSTREAM_TIMEOUT_MS,
  injectPreviewToolbarCss,
  sanitizeHostPreviewRequestHeaders,
  secureHostPreviewResponse,
} from "./preview-proxy.js";
import { readPreviewStatus } from "./preview-status.js";
import { previewUpstreamUrl } from "./preview-upstream.js";

type PreviewEnvironment = Record<string, string | undefined>;

export const PREVIEW_WEBSOCKET_MAX_PAYLOAD_BYTES = 8_000_000;

export type PreviewGatewayAccess = {
  token: string;
  projectId: string;
  port: number;
  expiresAt: number;
  publicUrl: string;
};

export type PreviewGatewayEnv = {
  Variables: { previewAccess: PreviewGatewayAccess | null };
};

function closeWebSocket<RawWebSocket>(
  ws: WSContext<RawWebSocket> | undefined,
  code: number,
  reason: string,
): void {
  try {
    ws?.close(sendableCloseCode(code), truncateCloseReason(reason));
  } catch {
    /* already closed */
  }
}

function bufferedWebSocketBytes(ws: WSContext<unknown> | undefined): number {
  const raw = ws?.raw as { bufferedAmount?: unknown } | undefined;
  return typeof raw?.bufferedAmount === "number" ? raw.bufferedAmount : 0;
}

function isSendableCloseCode(code: number): boolean {
  return (
    (code >= 1_000 && code <= 1_014 && ![1_004, 1_005, 1_006].includes(code)) ||
    (code >= 3_000 && code <= 4_999)
  );
}

function sendableCloseCode(code: number): number {
  return isSendableCloseCode(code) ? code : 1_011;
}

function truncateCloseReason(reason: string): string {
  let result = "";
  for (const character of reason) {
    if (Buffer.byteLength(result + character) > 123) break;
    result += character;
  }
  return result;
}

function closeUpstreamWebSocket(
  websocket: UpstreamWebSocket | undefined,
  code: number,
  reason: string,
): void {
  if (!websocket || websocket.readyState === UpstreamWebSocket.CLOSED) return;
  try {
    if (!isSendableCloseCode(code) || websocket.readyState !== UpstreamWebSocket.OPEN) {
      websocket.terminate();
      return;
    }
    websocket.close(code, truncateCloseReason(reason));
  } catch {
    try {
      websocket.terminate();
    } catch {
      /* already closed */
    }
  }
}

function messageByteLength(data: string | ArrayBuffer | Uint8Array): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}

export function createPreviewGateway<RawWebSocket>(
  upgradeWebSocket: UpgradeWebSocket<RawWebSocket>,
  environment: PreviewEnvironment = process.env,
): {
  caddyCheck: MiddlewareHandler<PreviewGatewayEnv>;
  middleware: MiddlewareHandler<PreviewGatewayEnv>;
} {
  const config = getPreviewOriginConfig(environment);

  function publicPreviewUrl(c: Context<PreviewGatewayEnv>, projectId: string): URL {
    if (!config) throw new Error("Host preview is not configured");
    const hostname = previewHostnameForProject(projectId, config, environment);
    const port = config.port ? `:${config.port}` : "";
    const requestUrl = new URL(c.req.url);
    const publicUrl = new URL(`${config.protocol}//${hostname}${port}${requestUrl.pathname}`);
    publicUrl.search = requestUrl.search;
    return publicUrl;
  }

  function accessCookie(token: string, expiresAt: number): string {
    if (!config) throw new Error("Host preview is not configured");
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1_000));
    const attributes = [
      `${config.accessCookieName}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      `Max-Age=${maxAge}`,
    ];
    // Chromium treats *.localhost iframe navigation as cross-site even though
    // localhost itself is trustworthy. A partitioned Secure cookie therefore
    // keeps the one-time handoff working both in production HTTPS and local
    // embedded previews without exposing the capability to repository JS.
    if (config.protocol === "https:" || config.hostname === "localhost") {
      attributes.push("Secure", "SameSite=None", "Partitioned");
    } else {
      attributes.push("SameSite=Lax");
    }
    return attributes.join("; ");
  }

  function resolveAccess(c: Context<PreviewGatewayEnv>, options: { active: boolean }) {
    if (!config) return null;
    const host = c.req.header("host") ?? "";
    const cookieToken = getCookie(c, config.accessCookieName);
    if (!cookieToken) return null;
    const access = options.active
      ? resolveActivePreviewSessionToken(cookieToken, host)
      : resolveReservedPreviewSessionToken(cookieToken, host);
    if (access.ok && isPreviewHostForProject(host, access.projectId, config, environment)) {
      return { ...access, token: cookieToken };
    }
    return null;
  }

  const webSocketUpgrade = upgradeWebSocket((c) => {
    const access = c.get("previewAccess") as PreviewGatewayAccess | null;
    let downstream: WSContext<RawWebSocket> | undefined;
    let upstream: UpstreamWebSocket | undefined;
    let validityTimer: ReturnType<typeof setInterval> | undefined;
    const queued: Array<{ data: string | ArrayBuffer; bytes: number }> = [];
    let queuedBytes = 0;
    const maxQueuedBytes = 1_000_000;
    const maxMessageBytes = PREVIEW_WEBSOCKET_MAX_PAYLOAD_BYTES;
    const maxBufferedBytes = 4_000_000;

    const cleanUp = () => {
      if (validityTimer) clearInterval(validityTimer);
      validityTimer = undefined;
    };

    const sendUpstream = (data: string | ArrayBuffer) => {
      if (upstream?.readyState === UpstreamWebSocket.OPEN) {
        if (upstream.bufferedAmount > maxBufferedBytes) {
          closeWebSocket(downstream, 1_013, "Preview connection is overloaded");
          closeUpstreamWebSocket(upstream, 1_013, "Preview connection is overloaded");
          return;
        }
        upstream.send(data);
        return;
      }
      const bytes = messageByteLength(data);
      if (queuedBytes + bytes > maxQueuedBytes) {
        closeWebSocket(downstream, 1013, "Preview connection is still starting");
        closeUpstreamWebSocket(upstream, 1_013, "Preview connection is still starting");
        return;
      }
      queued.push({ data, bytes });
      queuedBytes += bytes;
    };

    return {
      onOpen(_event, ws) {
        downstream = ws;
        if (!access || !config) {
          closeWebSocket(downstream, 1008, "Preview not found");
          return;
        }

        const requestUrl = new URL(c.req.url);
        const upstreamAccess = previewUpstreamUrl(
          access.projectId,
          access.port,
          requestUrl.pathname,
          requestUrl.search,
          true,
        );
        if (!upstreamAccess) {
          closeWebSocket(downstream, 1011, "Preview upstream is unavailable");
          return;
        }
        // Mirror the protocol already selected by the downstream server. If
        // the upstream selected a different item from the offered list, the
        // two sides would otherwise disagree about the wire format.
        const protocols = downstream.protocol ? [downstream.protocol] : [];
        const sanitized = sanitizeHostPreviewRequestHeaders(
          c.req.raw.headers,
          config.accessCookieName,
        );
        const projectCookie = sanitized.get("cookie");
        const headers: Record<string, string> = {
          ...upstreamAccess.headers,
          origin: new URL(upstreamAccess.url).origin.replace(/^wss:/, "https:"),
          "x-forwarded-host": new URL(access.publicUrl).host,
          "x-forwarded-proto": config.protocol.slice(0, -1),
        };
        if (projectCookie) headers.cookie = projectCookie;

        upstream = new UpstreamWebSocket(upstreamAccess.url, protocols, {
          headers,
          handshakeTimeout: 5_000,
          maxPayload: maxMessageBytes,
        });
        upstream.binaryType = "arraybuffer";
        upstream.on("open", () => {
          for (const message of queued.splice(0)) upstream?.send(message.data);
          queuedBytes = 0;
        });
        upstream.on("message", (data, isBinary) => {
          if (!downstream) return;
          const payload = isBinary ? new Uint8Array(data as ArrayBuffer) : data.toString();
          if (
            messageByteLength(payload) > maxMessageBytes ||
            bufferedWebSocketBytes(downstream) > maxBufferedBytes
          ) {
            closeUpstreamWebSocket(upstream, 1_009, "Preview message is too large");
            closeWebSocket(downstream, 1_009, "Preview message is too large");
            return;
          }
          downstream.send(payload);
        });
        upstream.on("close", (code, reason) => {
          cleanUp();
          closeWebSocket(downstream, code, reason.toString());
        });
        upstream.on("error", (error) => {
          console.warn(
            `[preview-ws] upstream failed for project ${access.projectId} on port ${access.port}: ${error.message}`,
          );
          cleanUp();
          closeWebSocket(downstream, 1011, "Preview connection failed");
        });

        validityTimer = setInterval(() => {
          const current = resolveActivePreviewSessionToken(
            access.token,
            new URL(access.publicUrl).host,
          );
          if (
            !current.ok ||
            current.projectId !== access.projectId ||
            current.port !== access.port
          ) {
            closeUpstreamWebSocket(upstream, 1_008, "Preview access expired");
            closeWebSocket(downstream, 1008, "Preview access expired");
            cleanUp();
          }
        }, 30_000);
        validityTimer.unref?.();
      },
      onMessage(event) {
        if (
          !access ||
          !resolveActivePreviewSessionToken(access.token, new URL(access.publicUrl).host).ok
        ) {
          closeWebSocket(downstream, 1008, "Preview access expired");
          closeUpstreamWebSocket(upstream, 1_008, "Preview access expired");
          return;
        }
        const bytes =
          typeof event.data === "string"
            ? Buffer.byteLength(event.data)
            : event.data instanceof Blob
              ? event.data.size
              : event.data.byteLength;
        if (bytes > maxMessageBytes) {
          closeWebSocket(downstream, 1_009, "Preview message is too large");
          closeUpstreamWebSocket(upstream, 1_009, "Preview message is too large");
          return;
        }
        if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
          sendUpstream(event.data);
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then(sendUpstream);
        } else {
          sendUpstream(new Uint8Array(event.data).slice().buffer);
        }
      },
      onClose(event) {
        cleanUp();
        closeUpstreamWebSocket(upstream, event.code, event.reason);
      },
      onError() {
        cleanUp();
        closeUpstreamWebSocket(upstream, 1_011, "Preview connection failed");
      },
    };
  });

  const caddyCheck: MiddlewareHandler<PreviewGatewayEnv> = async (c) => {
    if (!config) return c.text("denied", 403);
    const domain = c.req.query("domain") ?? "";
    return resolveReservedPreviewHost(domain, config, Date.now(), environment).ok
      ? c.text("ok", 200)
      : c.text("denied", 403);
  };

  const middleware: MiddlewareHandler<PreviewGatewayEnv> = async (c, next: Next) => {
    if (!config) return next();
    const host = c.req.header("host") ?? "";
    if (!isPreviewDomainChild(host, config)) return next();
    if (!previewLabelFromHost(host, config)) return c.text("Preview not found", 404);

    const requestUrl = new URL(c.req.url);
    if (requestUrl.searchParams.has(PREVIEW_ACCESS_QUERY)) {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        return c.text("Preview not found", 404);
      }
      const handoff = consumeReservedPreviewHandoff(
        requestUrl.searchParams.get(PREVIEW_ACCESS_QUERY) ?? "",
        host,
      );
      if (!handoff.ok || !isPreviewHostForProject(host, handoff.projectId, config, environment)) {
        return c.text("Preview not found", 404);
      }
      const publicUrl = publicPreviewUrl(c, handoff.projectId);
      publicUrl.searchParams.delete(PREVIEW_ACCESS_QUERY);
      return new Response(null, {
        status: 302,
        headers: {
          "cache-control": "no-store",
          location: `${publicUrl.pathname}${publicUrl.search}${publicUrl.hash}`,
          "referrer-policy": "no-referrer",
          "set-cookie": accessCookie(handoff.token, handoff.expiresAt),
        },
      });
    }

    if (c.req.path === "/.quillra/preview-status") {
      const access = resolveAccess(c, { active: false });
      if (!access) return c.json({ error: "Preview not found" }, 404);
      c.header("Cache-Control", "no-store");
      return c.json(await readPreviewStatus(access.projectId, access.port));
    }

    const reserved = resolveAccess(c, { active: false });
    if (!reserved) return c.text("Preview not found", 404);
    const publicUrl = publicPreviewUrl(c, reserved.projectId);

    const active = resolveAccess(c, { active: true });
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      if (!active) return c.text("Preview not found", 404);
      c.set("previewAccess", { ...active, publicUrl: publicUrl.toString() });
      return webSocketUpgrade(c, next);
    }

    if (!active) {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        return c.text("Preview is starting", 503);
      }
      const statusUrl = "/.quillra/preview-status";
      const boot = new Response(
        c.req.method === "HEAD" ? null : previewBootHtml(reserved.port, "", statusUrl, "include"),
        { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } },
      );
      return secureHostPreviewResponse(
        boot,
        publicUrl.toString(),
        reserved.port,
        config.controlOrigins,
        config.accessCookieName,
      );
    }

    const upstreamAccess = previewUpstreamUrl(
      active.projectId,
      active.port,
      requestUrl.pathname,
      requestUrl.search,
    );
    if (!upstreamAccess) return c.text("Preview upstream is unavailable", 503);
    const headers = sanitizeHostPreviewRequestHeaders(c.req.raw.headers, config.accessCookieName);
    for (const [name, value] of Object.entries(upstreamAccess.headers)) {
      headers.set(name, value);
    }
    headers.set("accept-encoding", "identity");
    headers.set("x-forwarded-host", publicUrl.host);
    headers.set("x-forwarded-proto", config.protocol.slice(0, -1));
    if (config.port) headers.set("x-forwarded-port", config.port);
    if (c.req.raw.headers.has("origin")) {
      headers.set("origin", new URL(upstreamAccess.url).origin);
    }
    if (c.req.header("service-worker")?.toLowerCase() === "script") {
      return c.text("Service workers are disabled in previews", 403);
    }

    try {
      const init: RequestInit & { duplex?: "half" } = {
        method: c.req.method,
        headers,
        body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
        redirect: "manual",
        signal: AbortSignal.any([
          c.req.raw.signal,
          AbortSignal.timeout(PREVIEW_UPSTREAM_TIMEOUT_MS),
        ]),
      };
      if (init.body) init.duplex = "half";
      const upstream = await fetch(upstreamAccess.url, init);
      const withCss = await injectPreviewToolbarCss(upstream);
      return secureHostPreviewResponse(
        withCss,
        publicUrl.toString(),
        active.port,
        config.controlOrigins,
        config.accessCookieName,
        new URL(upstreamAccess.url).origin,
      );
    } catch (error) {
      console.warn(
        `[preview-http] ${c.req.method} ${requestUrl.pathname} failed for project ${active.projectId} on port ${active.port}: ${error instanceof Error ? error.message : String(error)}`,
      );
      const isNavigation =
        c.req.method === "GET" &&
        (c.req.header("sec-fetch-dest") === "iframe" ||
          c.req.header("sec-fetch-dest") === "document" ||
          (c.req.header("accept") ?? "").includes("text/html"));
      if (!isNavigation) return c.text("Preview upstream unavailable", 502);
      const statusUrl = "/.quillra/preview-status";
      return secureHostPreviewResponse(
        new Response(previewBootHtml(active.port, "", statusUrl, "include"), {
          status: 200,
          headers: { "content-type": "text/html; charset=UTF-8" },
        }),
        publicUrl.toString(),
        active.port,
        config.controlOrigins,
        config.accessCookieName,
      );
    }
  };

  return { caddyCheck, middleware };
}
