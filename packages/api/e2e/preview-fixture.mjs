import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import {
  issuePreviewCapability,
  issuePreviewHandoff,
  revokePreviewCapability,
} from "../dist/services/preview-capability.js";
import {
  PREVIEW_WEBSOCKET_MAX_PAYLOAD_BYTES,
  createPreviewGateway,
} from "../dist/services/preview-gateway.js";
import {
  buildHostPreviewUrl,
  getPreviewOriginConfig,
  previewHostAuthorityForProject,
} from "../dist/services/preview-origin.js";
import {
  markPreviewPortActive,
  registerPreviewPort,
  unregisterPreviewPort,
} from "../dist/services/preview-status.js";
import {
  E2B_TRAFFIC_ACCESS_HEADER,
  registerLoopbackPreviewUpstreamForTests,
  unregisterPreviewUpstream,
} from "../dist/services/preview-upstream.js";

const gatewayPort = Number(process.argv[2]);
const upstreamPort = Number(process.argv[3]);
const parentPort = Number(process.argv[4]);
const statePath = process.argv[5];
if (!gatewayPort || !upstreamPort || !parentPort || !statePath) {
  throw new Error(
    "Usage: preview-fixture.mjs <gateway-port> <upstream-port> <parent-port> <state-path>",
  );
}

const projectId = "preview-browser-fixture";
const environment = {
  BETTER_AUTH_URL: `http://localhost:${gatewayPort}`,
  BETTER_AUTH_SECRET: "preview-browser-fixture-secret",
  PORT: String(gatewayPort),
  TRUSTED_ORIGINS: `http://localhost:${parentPort}`,
};
const requests = [];

function spaHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Transparent preview fixture</title>
    <script type="module" src="/asset.js?build=browser"></script>
  </head>
  <body>
    <main>
      <h1 data-testid="route"></h1>
      <a data-testid="beratung-link" href="/beratung?from=client#details">Open Beratung</a>
      <p data-testid="asset">asset pending</p>
      <p data-testid="api">api pending</p>
      <p data-testid="post">post pending</p>
      <p data-testid="worker">worker pending</p>
      <p data-testid="hmr">hmr pending</p>
      <img data-testid="logo" src="/logo.svg?asset=root" alt="Fixture logo" />
    </main>
    <script>
      function render() {
        document.querySelector('[data-testid="route"]').textContent =
          location.pathname === '/beratung' ? 'Beratung route' : 'Home route';
      }
      addEventListener('popstate', render);
      document.addEventListener('click', function (event) {
        var link = event.target.closest('a[href]');
        if (!link) return;
        event.preventDefault();
        history.pushState({}, '', link.href);
        render();
      });
      render();
      fetch('/api/data?source=browser')
        .then(function (response) { return response.json(); })
        .then(function (data) { document.querySelector('[data-testid="api"]').textContent = data.message; });
      fetch('/api/echo?source=browser', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'exact-post-body' })
        .then(function (response) { return response.text(); })
        .then(function (data) { document.querySelector('[data-testid="post"]').textContent = data; });
      var worker = new Worker('/worker.js?worker=root', { type: 'module' });
      worker.addEventListener('message', function (event) {
        document.querySelector('[data-testid="worker"]').textContent = event.data;
      });
      var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/hmr?channel=browser', 'vite-hmr');
      ws.addEventListener('message', function (event) {
        document.querySelector('[data-testid="hmr"]').textContent = event.data;
      });
    </script>
  </body>
</html>`;
}

const upstream = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    requests.push({
      method: request.method,
      url: request.url,
      body,
      cookie: request.headers.cookie ?? "",
      acceptEncoding: request.headers["accept-encoding"] ?? "",
      trafficToken: request.headers[E2B_TRAFFIC_ACCESS_HEADER] ?? "",
      serviceWorker: request.headers["service-worker"] ?? "",
    });
    if (request.headers[E2B_TRAFFIC_ACCESS_HEADER] !== fixtureTrafficToken) {
      response.writeHead(403);
      response.end("missing E2B traffic token");
      return;
    }

    const url = new URL(request.url ?? "/", `http://127.0.0.1:${upstreamPort}`);
    if (url.pathname === "/asset.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=UTF-8" });
      response.end(
        `document.querySelector('[data-testid="asset"]').textContent = 'root asset loaded';`,
      );
      return;
    }
    if (url.pathname === "/logo.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#16a34a"/></svg>',
      );
      return;
    }
    if (url.pathname === "/worker.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=UTF-8" });
      response.end("postMessage('dedicated worker loaded');");
      return;
    }
    if (url.pathname === "/api/data") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "root API loaded", literal: '"/must-stay-root"' }));
      return;
    }
    if (url.pathname === "/api/echo") {
      response.writeHead(200, { "content-type": "text/plain; charset=UTF-8" });
      response.end(`${request.method}:${url.searchParams.get("source")}:${body}`);
      return;
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/beratung?from=redirect#anchor" });
      response.end();
      return;
    }
    if (url.pathname === "/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("self.addEventListener('fetch', function () {});");
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
    response.end(spaHtml());
  });
});

const websocketServer = new WebSocketServer({
  noServer: true,
  handleProtocols(protocols) {
    return protocols.has("vite-hmr") ? "vite-hmr" : false;
  },
});
upstream.on("upgrade", (request, socket, head) => {
  requests.push({
    method: "WS",
    url: request.url,
    body: "",
    cookie: request.headers.cookie ?? "",
    acceptEncoding: request.headers["accept-encoding"] ?? "",
    trafficToken: request.headers[E2B_TRAFFIC_ACCESS_HEADER] ?? "",
    serviceWorker: "",
  });
  if (request.headers[E2B_TRAFFIC_ACCESS_HEADER] !== fixtureTrafficToken) {
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    websocketServer.emit("connection", websocket, request);
  });
});
websocketServer.on("connection", (websocket) => {
  websocket.send("vite-hmr connected");
});

await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(upstreamPort, "127.0.0.1", () => {
    upstream.off("error", reject);
    resolve();
  });
});

registerPreviewPort(upstreamPort, projectId);
const fixtureTrafficToken = "preview-fixture-traffic-token";
registerLoopbackPreviewUpstreamForTests(projectId, upstreamPort, {
  origin: `http://127.0.0.1:${upstreamPort}`,
  headers: { [E2B_TRAFFIC_ACCESS_HEADER]: fixtureTrafficToken },
});
markPreviewPortActive(projectId, upstreamPort);
issuePreviewCapability(projectId, upstreamPort);
const config = getPreviewOriginConfig(environment);
if (!config) throw new Error("Expected localhost preview origin configuration");
const previewHost = previewHostAuthorityForProject(projectId, config, environment);
const handoff = issuePreviewHandoff(projectId, upstreamPort, previewHost);
const previewUrl = buildHostPreviewUrl(projectId, handoff.token, config, environment);

const app = new Hono();
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: PREVIEW_WEBSOCKET_MAX_PAYLOAD_BYTES,
});
const gateway = createPreviewGateway(upgradeWebSocket, environment);
app.use("*", gateway.middleware);
app.get("/api/caddy-check", gateway.caddyCheck);
app.get("/fixture-state", (context) =>
  context.json({
    previewOrigin: new URL(previewUrl).origin,
    handoffUrl: previewUrl,
    requests,
  }),
);
app.post("/fixture-revoke", (context) => {
  revokePreviewCapability(projectId);
  unregisterPreviewUpstream(projectId, upstreamPort);
  return context.json({ ok: true });
});

const gatewayServer = serve({
  fetch: app.fetch,
  hostname: "127.0.0.1",
  port: gatewayPort,
  websocket: { server: wss },
});
if (!gatewayServer.listening) {
  await new Promise((resolve, reject) => {
    gatewayServer.once("listening", resolve);
    gatewayServer.once("error", reject);
  });
}

const parentApp = new Hono();
parentApp.get("/fixture-parent", (context) =>
  context.html(`<!doctype html><html><body style="margin:0">
    <iframe id="preview" name="preview" title="Preview fixture" sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-same-origin" referrerpolicy="no-referrer" src=${JSON.stringify(previewUrl)} style="width:100vw;height:100vh;border:0"></iframe>
  </body></html>`),
);
const parentServer = serve({ fetch: parentApp.fetch, hostname: "127.0.0.1", port: parentPort });
if (!parentServer.listening) {
  await new Promise((resolve, reject) => {
    parentServer.once("listening", resolve);
    parentServer.once("error", reject);
  });
}
writeFileSync(
  statePath,
  JSON.stringify({ parentUrl: `http://localhost:${parentPort}/fixture-parent` }),
  { mode: 0o600 },
);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  revokePreviewCapability(projectId);
  unregisterPreviewUpstream(projectId, upstreamPort);
  unregisterPreviewPort(projectId, upstreamPort);
  websocketServer.close();
  parentServer.close(() => {
    gatewayServer.close(() => {
      upstream.close(() => process.exit(0));
    });
  });
  setTimeout(() => process.exit(1), 2_000).unref();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
