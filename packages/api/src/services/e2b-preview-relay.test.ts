import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  Agent,
  type IncomingHttpHeaders,
  type Server,
  createServer,
  request as httpRequest,
} from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  E2B_PREVIEW_RELAY_PORT,
  E2B_PREVIEW_RELAY_SOURCE,
  E2B_PREVIEW_TARGET_MAX_PORT,
  E2B_PREVIEW_TARGET_MIN_PORT,
  E2B_RELAY_STATUS_HEADER,
  E2B_RELAY_UPSTREAM_UNAVAILABLE,
  E2B_RELAY_USER,
} from "./e2b-preview-relay.js";

const LOOPBACK = "127.0.0.1";
const PUBLIC_HOST = "project-123.preview.example";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const PROVIDER_TOKEN_HEADER = "e2b-traffic-access-token";
const RELAY_HEADER_PREFIX = "x-quillra-relay-";

type RecordedHttpRequest = {
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  bodyChunks: number;
  socket: Socket;
};

type RelayHttpResponse = {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  chunks: Buffer[];
};

let fixtureDirectory: string | undefined;
let upstreamServer: Server | undefined;
let upstreamWebSockets: WebSocketServer | undefined;
let upstreamPort = 0;
let relayPort = 0;
let relayProcess: ChildProcess | undefined;
let relayStderr = "";
let clientAgent: Agent | undefined;
let activeClient: WebSocket | undefined;
let httpRequests: RecordedHttpRequest[] = [];
let webSocketHeaders: IncomingHttpHeaders[] = [];

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK, port, exclusive: true });
  });
}

async function listenOnValidTargetPort(server: Server): Promise<number> {
  const range = E2B_PREVIEW_TARGET_MAX_PORT - E2B_PREVIEW_TARGET_MIN_PORT + 1;
  const firstCandidate = E2B_PREVIEW_TARGET_MIN_PORT + ((process.pid * 97) % range);

  for (let offset = 0; offset < range; offset += 1) {
    const candidate =
      E2B_PREVIEW_TARGET_MIN_PORT +
      ((firstCandidate - E2B_PREVIEW_TARGET_MIN_PORT + offset) % range);
    if (candidate === E2B_PREVIEW_RELAY_PORT) continue;
    if (await tryListen(server, candidate)) return candidate;
  }

  throw new Error("Unable to reserve a valid E2B preview target port");
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

function relayIsAcceptingConnections(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: LOOPBACK, port: relayPort });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(200, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForRelay(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await relayIsAcceptingConnections()) return;
    if (relayProcess && (relayProcess.exitCode !== null || relayProcess.signalCode !== null)) {
      throw new Error(`Preview relay exited during startup: ${relayStderr.trim()}`);
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for the preview relay: ${relayStderr.trim()}`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopRelay(): Promise<void> {
  const child = relayProcess;
  relayProcess = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 1_500)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 1_500);
}

async function closeActiveClient(): Promise<void> {
  const socket = activeClient;
  activeClient = undefined;
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  if (socket.readyState === WebSocket.OPEN) socket.close(1_000, "test cleanup");
  else socket.terminate();
  await Promise.race([closed, delay(500)]);
  socket.terminate();
}

async function cleanup(): Promise<void> {
  await closeActiveClient();
  clientAgent?.destroy();
  clientAgent = undefined;
  await stopRelay();
  for (const socket of upstreamWebSockets?.clients ?? []) socket.terminate();
  upstreamWebSockets?.close();
  upstreamWebSockets = undefined;
  await closeServer(upstreamServer);
  upstreamServer = undefined;
  if (fixtureDirectory) {
    await rm(fixtureDirectory, { recursive: true, force: true });
    fixtureDirectory = undefined;
  }
}

function relayHeaders(): Record<string, string> {
  return {
    host: "spoofed.attacker.invalid:8443",
    origin: "https://spoofed.attacker.invalid",
    forwarded: "for=192.0.2.123;host=spoofed.attacker.invalid",
    "x-forwarded-for": "192.0.2.123",
    "x-forwarded-host": "spoofed.attacker.invalid",
    "x-forwarded-port": "8443",
    "x-forwarded-proto": "http",
    [PROVIDER_TOKEN_HEADER]: "provider-secret",
    "x-quillra-relay-host": PUBLIC_HOST,
    "x-quillra-relay-proto": "https",
    "x-quillra-relay-port": "443",
    "x-quillra-relay-origin": PUBLIC_ORIGIN,
    "x-safe-request": "visible",
  };
}

async function relayHttpRequest(options: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  bodyChunks?: string[];
}): Promise<RelayHttpResponse> {
  const response = new Promise<RelayHttpResponse>((resolve, reject) => {
    const request = httpRequest({
      host: LOOPBACK,
      port: relayPort,
      path: options.path,
      method: options.method ?? "GET",
      headers: options.headers,
      agent: clientAgent,
    });
    request.once("error", reject);
    request.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.once("error", reject);
      incoming.once("end", () => {
        resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          chunks,
        });
      });
    });

    void (async () => {
      try {
        for (const chunk of options.bodyChunks ?? []) {
          request.write(chunk);
          await delay(20);
        }
        request.end();
      } catch (error) {
        request.destroy();
        reject(error);
      }
    })();
  });

  return response;
}

function expectTrustedForwarding(headers: IncomingHttpHeaders): void {
  expect(headers.host).toBe(PUBLIC_HOST);
  expect(headers.origin).toBe(PUBLIC_ORIGIN);
  expect(headers.forwarded).toBeUndefined();
  expect(headers["x-forwarded-for"]).toBeUndefined();
  expect(headers["x-forwarded-host"]).toBe(PUBLIC_HOST);
  expect(headers["x-forwarded-proto"]).toBe("https");
  expect(headers["x-forwarded-port"]).toBe("443");
  expect(headers[PROVIDER_TOKEN_HEADER]).toBeUndefined();
  expect(headers["x-safe-request"]).toBe("visible");
  expect(Object.keys(headers).filter((name) => name.startsWith(RELAY_HEADER_PREFIX))).toEqual([]);
}

describe.sequential("E2B preview relay", () => {
  beforeAll(async () => {
    try {
      fixtureDirectory = await mkdtemp(path.join(tmpdir(), "quillra-e2b-relay-"));
      const relayPath = path.join(fixtureDirectory, "preview-relay.mjs");

      upstreamWebSockets = new WebSocketServer({ noServer: true });
      upstreamWebSockets.on("headers", (headers) => {
        headers.push(`${PROVIDER_TOKEN_HEADER}: upstream-response-secret`);
        headers.push("x-quillra-relay-internal: upstream-response-secret");
        headers.push("x-safe-websocket: visible");
      });
      upstreamWebSockets.on("connection", (socket, request) => {
        webSocketHeaders.push(request.headers);
        socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
      });

      upstreamServer = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          httpRequests.push({
            url: request.url ?? "",
            headers: request.headers,
            body: Buffer.concat(chunks),
            bodyChunks: chunks.length,
            socket: request.socket,
          });
          response.setHeader(PROVIDER_TOKEN_HEADER, "upstream-response-secret");
          response.setHeader("x-quillra-relay-internal", "upstream-response-secret");
          response.setHeader(E2B_RELAY_STATUS_HEADER, E2B_RELAY_UPSTREAM_UNAVAILABLE);
          response.setHeader("x-safe-response", "visible");
          if (request.url === "/stream") {
            response.write("first-");
            setTimeout(() => response.end("second"), 30);
            return;
          }
          response.end("reused");
        });
      });
      upstreamServer.on("upgrade", (request, socket, head) => {
        upstreamWebSockets?.handleUpgrade(request, socket, head, (webSocket) => {
          upstreamWebSockets?.emit("connection", webSocket, request);
        });
      });
      upstreamPort = await listenOnValidTargetPort(upstreamServer);

      const relayPortProbe = createServer();
      await new Promise<void>((resolve, reject) => {
        relayPortProbe.once("error", reject);
        relayPortProbe.listen({ host: LOOPBACK, port: 0, exclusive: true }, resolve);
      });
      const relayAddress = relayPortProbe.address();
      if (!relayAddress || typeof relayAddress === "string") {
        throw new Error("Unable to reserve an integration-test relay port");
      }
      relayPort = relayAddress.port;
      await closeServer(relayPortProbe);

      const fixtureSource = E2B_PREVIEW_RELAY_SOURCE.replace(
        `const relayPort = ${E2B_PREVIEW_RELAY_PORT};`,
        `const relayPort = ${relayPort};`,
      ).replace(
        "    dropRelayPrivileges();",
        "    // Integration fixture already runs unprivileged on a high port.",
      );
      if (
        fixtureSource === E2B_PREVIEW_RELAY_SOURCE ||
        fixtureSource.includes("    dropRelayPrivileges();")
      ) {
        throw new Error("Unable to derive the unprivileged relay integration fixture");
      }
      await writeFile(relayPath, fixtureSource, { mode: 0o600 });

      relayProcess = spawn(process.execPath, [relayPath, String(upstreamPort)], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      relayProcess.stderr?.on("data", (chunk) => {
        relayStderr = `${relayStderr}${String(chunk)}`.slice(-4_096);
      });
      await waitForRelay();

      clientAgent = new Agent({ keepAlive: true, maxSockets: 1 });
    } catch (error) {
      await cleanup();
      throw error;
    }
  }, 10_000);

  afterAll(cleanup);

  it("uses a privileged production port and drops identity before attaching handlers", () => {
    expect(E2B_PREVIEW_RELAY_PORT).toBeGreaterThan(0);
    expect(E2B_PREVIEW_RELAY_PORT).toBeLessThan(1_024);
    expect(E2B_PREVIEW_RELAY_SOURCE).toContain(`const relayPort = ${E2B_PREVIEW_RELAY_PORT};`);
    expect(E2B_PREVIEW_RELAY_SOURCE).toContain("process.setgroups([])");
    expect(E2B_PREVIEW_RELAY_SOURCE).toContain(`process.setgid("${E2B_RELAY_USER}")`);
    expect(E2B_PREVIEW_RELAY_SOURCE).toContain(`process.setuid("${E2B_RELAY_USER}")`);
    expect(E2B_PREVIEW_RELAY_SOURCE).toContain('field("NoNewPrivs") !== "1"');
    expect(E2B_PREVIEW_RELAY_SOURCE).toContain('new RegExp("^" + name + ":\\\\s*(\\\\S+)", "m")');
    expect(E2B_PREVIEW_RELAY_SOURCE).not.toContain(
      'new RegExp("^" + name + ":\\\\\\\\s*(\\\\\\\\S+)", "m")',
    );

    const listen = E2B_PREVIEW_RELAY_SOURCE.indexOf("server.listen(");
    const drop = E2B_PREVIEW_RELAY_SOURCE.indexOf("dropRelayPrivileges();", listen);
    const requestHandler = E2B_PREVIEW_RELAY_SOURCE.indexOf(
      'server.on("request", handleHttpRequest)',
      listen,
    );
    expect(listen).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(listen);
    expect(requestHandler).toBeGreaterThan(drop);
  });

  it("streams HTTP through one keep-alive upstream socket and enforces trusted headers", async () => {
    httpRequests = [];
    const streamed = await relayHttpRequest({
      path: "/stream",
      method: "POST",
      headers: relayHeaders(),
      bodyChunks: ["alpha-", "omega"],
    });
    const reused = await relayHttpRequest({
      path: "/reuse",
      headers: relayHeaders(),
    });

    expect(streamed.status).toBe(200);
    expect(Buffer.concat(streamed.chunks).toString()).toBe("first-second");
    expect(streamed.chunks.length).toBeGreaterThanOrEqual(2);
    expect(streamed.headers["x-safe-response"]).toBe("visible");
    expect(streamed.headers[PROVIDER_TOKEN_HEADER]).toBeUndefined();
    expect(streamed.headers[E2B_RELAY_STATUS_HEADER]).toBeUndefined();
    expect(
      Object.keys(streamed.headers).filter((name) => name.startsWith(RELAY_HEADER_PREFIX)),
    ).toEqual([]);

    const streamedRequest = httpRequests.find((request) => request.url === "/stream");
    const reusedRequest = httpRequests.find((request) => request.url === "/reuse");
    expect(streamedRequest?.body.toString()).toBe("alpha-omega");
    expect(streamedRequest?.bodyChunks).toBeGreaterThanOrEqual(2);
    expect(streamedRequest?.socket).toBe(reusedRequest?.socket);
    expectTrustedForwarding(streamedRequest?.headers ?? {});
    expectTrustedForwarding(reusedRequest?.headers ?? {});
    expect(Buffer.concat(reused.chunks).toString()).toBe("reused");
  });

  it("strips private headers from both sides of a WebSocket upgrade", async () => {
    webSocketHeaders = [];
    let upgradeHeaders: IncomingHttpHeaders | undefined;
    const socket = new WebSocket(`ws://${LOOPBACK}:${relayPort}/@vite/client`, {
      headers: relayHeaders(),
    });
    activeClient = socket;
    socket.once("upgrade", (response) => {
      upgradeHeaders = response.headers;
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const echoed = new Promise<{ data: Buffer; isBinary: boolean }>((resolve) => {
      socket.once("message", (data, isBinary) => {
        resolve({ data: Buffer.from(data as Buffer), isBinary });
      });
    });
    socket.send("vite-ready");
    await expect(echoed).resolves.toEqual({
      data: Buffer.from("vite-ready"),
      isBinary: false,
    });

    expect(webSocketHeaders).toHaveLength(1);
    expectTrustedForwarding(webSocketHeaders[0] ?? {});
    expect(upgradeHeaders?.["x-safe-websocket"]).toBe("visible");
    expect(upgradeHeaders?.[PROVIDER_TOKEN_HEADER]).toBeUndefined();
    expect(
      Object.keys(upgradeHeaders ?? {}).filter((name) => name.startsWith(RELAY_HEADER_PREFIX)),
    ).toEqual([]);

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close(1_000, "done");
    await closed;
    activeClient = undefined;
  });

  it("marks only the relay's own unavailable response after the target stops", async () => {
    await closeServer(upstreamServer);
    upstreamServer = undefined;

    const unavailable = await relayHttpRequest({
      path: "/not-ready",
      headers: relayHeaders(),
    });

    expect(unavailable.status).toBe(502);
    expect(Buffer.concat(unavailable.chunks).toString()).toBe("Preview upstream unavailable");
    expect(unavailable.headers[E2B_RELAY_STATUS_HEADER]).toBe(E2B_RELAY_UPSTREAM_UNAVAILABLE);
  });
});
