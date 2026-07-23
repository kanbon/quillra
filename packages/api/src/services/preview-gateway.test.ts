import {
  type IncomingHttpHeaders,
  type Server,
  createServer,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { issuePreviewCapability, revokePreviewCapability } from "./preview-capability.js";
import {
  PREVIEW_WEBSOCKET_MAX_PAYLOAD_BYTES,
  type PreviewGatewayEnv,
  createPreviewGateway,
} from "./preview-gateway.js";
import {
  PREVIEW_ACCESS_QUERY,
  getPreviewOriginConfig,
  previewHostnameForProject,
} from "./preview-origin.js";
import {
  markPreviewPortActive,
  registerPreviewPort,
  unregisterPreviewPort,
} from "./preview-status.js";

const PROJECT_ID = "preview-gateway-integration";
const ENVIRONMENT = {
  BETTER_AUTH_SECRET: "preview-gateway-integration-secret",
  BETTER_AUTH_URL: "http://localhost",
};

type UpstreamRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

type WebSocketUpgrade = {
  url: string;
  protocol: string | undefined;
  cookie: string | undefined;
};

type GatewayRequestInit = {
  method?: string;
  headers?: HeadersInit;
  body?: string | Buffer | Uint8Array;
};

let upstreamServer: Server;
let gatewayServer: Server;
let upstreamWebSockets: WebSocketServer;
let upstreamPort: number;
let gatewayPort: number;
let previewHost: string;
let capability: ReturnType<typeof issuePreviewCapability>;
let upstreamRequests: UpstreamRequest[] = [];
let webSocketUpgrades: WebSocketUpgrade[] = [];

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
  return (address as AddressInfo).port;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function gatewayFetch(
  path: string,
  init: GatewayRequestInit = {},
  host = previewHost,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: gatewayPort,
      path,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers),
    });
    request.once("error", reject);
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          responseHeaders.append(
            response.rawHeaders[index] ?? "",
            response.rawHeaders[index + 1] ?? "",
          );
        }
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            statusText: response.statusMessage,
            headers: responseHeaders,
          }),
        );
      });
    });
    if (init.body) request.write(init.body);
    request.end();
  });
}

async function acquireAccessCookie(extraQuery = ""): Promise<string> {
  const separator = extraQuery ? "&" : "";
  const response = await gatewayFetch(
    `/?${PREVIEW_ACCESS_QUERY}=${encodeURIComponent(capability.token)}${separator}${extraQuery}`,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(extraQuery ? `/?${extraQuery}` : "/");
  expect(response.headers.get("location")).not.toContain(capability.token);
  expect(upstreamRequests).toHaveLength(0);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("__Host-quillra_preview=");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=None");
  expect(setCookie).toContain("Partitioned");
  return setCookie?.split(";", 1)[0] ?? "";
}

function requestFor(url: string): UpstreamRequest {
  for (let index = upstreamRequests.length - 1; index >= 0; index -= 1) {
    const request = upstreamRequests[index];
    if (request?.url === url) return request;
  }
  throw new Error(`No upstream request recorded for ${url}`);
}

beforeAll(async () => {
  upstreamWebSockets = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has("vite-hmr") ? "vite-hmr" : false;
    },
  });
  upstreamWebSockets.on("connection", (socket, request) => {
    webSocketUpgrades.push({
      url: request.url ?? "",
      protocol: request.headers["sec-websocket-protocol"],
      cookie: request.headers.cookie,
    });
    socket.on("message", (data, isBinary) => {
      socket.send(data, { binary: isBinary });
    });
  });

  upstreamServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      upstreamRequests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      });

      const url = new URL(request.url ?? "/", "http://upstream.test");
      if (url.pathname === "/src/main.js") {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        response.end('fetch("/api/session"); import "/@vite/client";');
        return;
      }
      if (url.pathname === "/api/session") {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end('{"asset":"/assets/logo.svg","authenticated":true}');
        return;
      }
      if (url.pathname === "/submit") {
        response.setHeader("content-type", "application/octet-stream");
        response.end(body);
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<html><head></head><body data-path="${url.pathname}">preview</body></html>`);
    });
  });
  upstreamServer.on("upgrade", (request, socket, head) => {
    upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
      upstreamWebSockets.emit("connection", webSocket, request);
    });
  });
  await listen(upstreamServer);
  upstreamPort = portOf(upstreamServer);

  const app = new Hono<PreviewGatewayEnv>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: PREVIEW_WEBSOCKET_MAX_PAYLOAD_BYTES,
  });
  const gateway = createPreviewGateway(upgradeWebSocket, ENVIRONMENT);
  app.use("*", gateway.middleware);
  app.get("/api/caddy-check", gateway.caddyCheck);
  app.all("*", (c) => c.text("control-plane"));
  gatewayServer = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: 0,
    websocket: { server: wss },
  }) as Server;
  if (!gatewayServer.listening) {
    await new Promise<void>((resolve, reject) => {
      gatewayServer.once("listening", resolve);
      gatewayServer.once("error", reject);
    });
  }
  gatewayPort = portOf(gatewayServer);

  const config = getPreviewOriginConfig(ENVIRONMENT);
  if (!config) throw new Error("Expected localhost preview configuration");
  previewHost = previewHostnameForProject(PROJECT_ID, config, ENVIRONMENT);
});

beforeEach(() => {
  upstreamRequests = [];
  webSocketUpgrades = [];
  if (!registerPreviewPort(upstreamPort, PROJECT_ID)) {
    throw new Error("Unable to reserve the upstream fixture port");
  }
  capability = issuePreviewCapability(PROJECT_ID, upstreamPort);
  if (!markPreviewPortActive(PROJECT_ID, upstreamPort)) {
    throw new Error("Unable to activate the upstream fixture port");
  }
});

afterEach(() => {
  revokePreviewCapability(PROJECT_ID);
  unregisterPreviewPort(PROJECT_ID, upstreamPort);
});

afterAll(async () => {
  for (const client of upstreamWebSockets?.clients ?? []) client.terminate();
  upstreamWebSockets?.close();
  await Promise.all([close(gatewayServer), close(upstreamServer)]);
});

describe("host preview gateway integration", () => {
  it("exchanges the query capability for a private cookie without touching upstream", async () => {
    const cookie = await acquireAccessCookie("view=wide");

    expect(cookie).toMatch(/^__Host-quillra_preview=[A-Za-z0-9_-]{32}$/);
    const response = await gatewayFetch("/", {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("worker-src 'self' blob:");
    expect(await response.text()).toContain('data-path="/"');
    expect(upstreamRequests).toHaveLength(1);
    expect(requestFor("/").headers.cookie).toBeUndefined();
  });

  it("forwards native root, deep, asset, and API paths and keeps bodies unmodified", async () => {
    const cookie = await acquireAccessCookie();
    const headers = { cookie };

    await expect(
      gatewayFetch("/?theme=dark", { headers }).then((response) => response.text()),
    ).resolves.toContain('data-path="/"');
    await expect(
      gatewayFetch("/beratung?lang=de", { headers }).then((response) => response.text()),
    ).resolves.toContain('data-path="/beratung"');
    await expect(
      gatewayFetch("/src/main.js?v=17", { headers }).then((response) => response.text()),
    ).resolves.toBe('fetch("/api/session"); import "/@vite/client";');
    await expect(
      gatewayFetch("/api/session?include=user", { headers }).then((response) => response.text()),
    ).resolves.toBe('{"asset":"/assets/logo.svg","authenticated":true}');

    expect(upstreamRequests.map((request) => request.url)).toEqual([
      "/?theme=dark",
      "/beratung?lang=de",
      "/src/main.js?v=17",
      "/api/session?include=user",
    ]);
    for (const request of upstreamRequests) {
      expect(request.headers["accept-encoding"]).toBe("identity");
    }
  });

  it("streams a POST body unchanged", async () => {
    const cookie = await acquireAccessCookie();
    const body = JSON.stringify({ title: "Fugenlos", path: "/beratung" });
    const response = await gatewayFetch("/submit?draft=1", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    const request = requestFor("/submit?draft=1");
    expect(request.method).toBe("POST");
    expect(request.body).toEqual(Buffer.from(body));
  });

  it("authorizes Caddy only for a reserved host and rejects invalid or revoked access", async () => {
    const encodedHost = encodeURIComponent(previewHost);
    const valid = await gatewayFetch(`/api/caddy-check?domain=${encodedHost}`, {}, "localhost");
    const invalid = await gatewayFetch(
      "/api/caddy-check?domain=not-a-preview.localhost",
      {},
      "localhost",
    );
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe("ok");
    expect(invalid.status).toBe(403);

    const malformedHost = await gatewayFetch("/", {}, "not-a-preview.localhost");
    expect(malformedHost.status).toBe(404);

    const cookie = await acquireAccessCookie();
    revokePreviewCapability(PROJECT_ID);
    const revoked = await gatewayFetch("/src/main.js", { headers: { cookie } });
    const revokedCaddy = await gatewayFetch(
      `/api/caddy-check?domain=${encodedHost}`,
      {},
      "localhost",
    );
    expect(revoked.status).toBe(404);
    expect(revokedCaddy.status).toBe(403);
  });

  it("rejects service-worker scripts before they reach the project", async () => {
    const cookie = await acquireAccessCookie();
    const response = await gatewayFetch("/service-worker.js", {
      headers: { cookie, "service-worker": "script" },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Service workers are disabled in previews");
    expect(upstreamRequests).toHaveLength(0);
  });

  it("bridges vite-hmr-style WebSocket text and binary frames on the exact path", async () => {
    const cookie = await acquireAccessCookie();
    const socket = new WebSocket(
      `ws://127.0.0.1:${gatewayPort}/@vite/client?token=hmr-token`,
      "vite-hmr",
      { headers: { cookie, host: previewHost } },
    );
    const messages: Array<{ data: Buffer; isBinary: boolean }> = [];
    socket.on("message", (data, isBinary) => {
      messages.push({ data: Buffer.from(data as Buffer), isBinary });
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    expect(socket.protocol).toBe("vite-hmr");
    socket.send("vite-ready");
    socket.send(Buffer.from([0, 1, 2, 255]));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for HMR frames")),
        2_000,
      );
      const check = () => {
        if (messages.length !== 2) return;
        clearTimeout(timeout);
        socket.off("message", check);
        resolve();
      };
      socket.on("message", check);
      check();
    });
    expect(messages[0]).toEqual({ data: Buffer.from("vite-ready"), isBinary: false });
    expect(messages[1]).toEqual({ data: Buffer.from([0, 1, 2, 255]), isBinary: true });
    expect(webSocketUpgrades).toEqual([
      {
        url: "/@vite/client?token=hmr-token",
        protocol: "vite-hmr",
        cookie: undefined,
      },
    ]);

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close(1_000, "done");
    await closed;
  });
});
