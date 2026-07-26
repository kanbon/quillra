export const E2B_PROJECT_USER = "quillra-project";
export const E2B_RELAY_USER = "quillra-relay";
export const E2B_PROJECT_HOME = "/home/quillra-project";
// A privileged port is intentional: if the relay crashes, untrusted project
// code must be unable to bind its public ingress and capture E2B's token.
export const E2B_PREVIEW_RELAY_PORT = 733;
export const E2B_ENVD_PORT = 49_983;
export const E2B_PREVIEW_TARGET_MIN_PORT = 1_024;
export const E2B_PREVIEW_TARGET_MAX_PORT = 32_767;
// E2B's default template deliberately makes /usr/local writable by its
// developer user. Relay trust material therefore lives below /opt, whose
// root-owned parent is not project-writable and persists across pause/resume.
export const E2B_RELAY_RUNTIME_ROOT = "/opt/quillra";
export const E2B_RELAY_BIN_ROOT = `${E2B_RELAY_RUNTIME_ROOT}/bin`;
export const E2B_RELAY_STAGING_ROOT = `${E2B_RELAY_RUNTIME_ROOT}/staging`;
export const E2B_RELAY_INSTALL_PATH = `${E2B_RELAY_BIN_ROOT}/quillra-preview-relay.mjs`;
export const E2B_RELAY_NODE_PATH = `${E2B_RELAY_BIN_ROOT}/node`;

export type E2BTrustedEnvironmentStage =
  | "bootstrap"
  | "project-isolation"
  | "project-quiesce"
  | "relay-stop"
  | "relay-target"
  | "relay-start"
  | "relay-ready";

export type E2BTrustedEnvironmentCleanupStatus = "confirmed" | "failed";

/**
 * A deliberately sanitized error boundary. Provider responses and command
 * output can contain credentials, so callers receive only a stable stage.
 */
export class E2BTrustedEnvironmentError extends Error {
  readonly code = "trusted-environment-failed" as const;

  constructor(
    readonly stage: E2BTrustedEnvironmentStage,
    readonly cleanupStatus?: E2BTrustedEnvironmentCleanupStatus,
    readonly sandboxId?: string,
  ) {
    super(
      cleanupStatus === "failed"
        ? "The E2B trusted execution environment failed and its cleanup could not be confirmed."
        : "The E2B trusted execution environment could not be prepared.",
    );
    this.name = "E2BTrustedEnvironmentError";
  }
}

export function assertE2BPreviewTargetPort(port: number): void {
  if (
    !Number.isSafeInteger(port) ||
    port < E2B_PREVIEW_TARGET_MIN_PORT ||
    port > E2B_PREVIEW_TARGET_MAX_PORT ||
    port === E2B_PREVIEW_RELAY_PORT ||
    port === E2B_ENVD_PORT
  ) {
    throw new E2BTrustedEnvironmentError("relay-target");
  }
}

/**
 * This source is installed root-owned inside each sandbox. It intentionally
 * has no dependency outside Node's standard library so the E2B base template
 * works without an operator-built image.
 */
export const E2B_PREVIEW_RELAY_SOURCE = String.raw`
import http from "node:http";
import { readFileSync } from "node:fs";

const trafficHeader = "e2b-traffic-access-token";
const relayHeaderPrefix = "x-quillra-relay-";
const relayPort = ${E2B_PREVIEW_RELAY_PORT};
const envdPort = ${E2B_ENVD_PORT};
const minTargetPort = ${E2B_PREVIEW_TARGET_MIN_PORT};
const maxTargetPort = ${E2B_PREVIEW_TARGET_MAX_PORT};
const targetPortText = process.argv[2] ?? "";
const targetPort = Number(targetPortText);

if (
  !/^[0-9]+$/.test(targetPortText) ||
  !Number.isSafeInteger(targetPort) ||
  targetPort < minTargetPort ||
  targetPort > maxTargetPort ||
  targetPort === relayPort ||
  targetPort === envdPort
) {
  process.exit(64);
}

const targetHost = "127.0.0.1";
const normalHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function headerText(headers, name) {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function safeHost(value) {
  if (
    !value ||
    value.length > 512 ||
    /[\u0000-\u0020\u007f,@/\\?#]/.test(value)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL("https://" + value);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function safeProtocol(value) {
  return value === "http" || value === "https" ? value : undefined;
}

function safePort(value) {
  if (!value || !/^[0-9]+$/.test(value)) return undefined;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535
    ? String(port)
    : undefined;
}

function safeOrigin(value) {
  if (!value || value.length > 2048) return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function relayMetadata(headers) {
  const hostHeader = relayHeaderPrefix + "host";
  const protocolHeader = relayHeaderPrefix + "proto";
  const portHeader = relayHeaderPrefix + "port";
  const originHeader = relayHeaderPrefix + "origin";
  const rawHost = headerText(headers, hostHeader);
  const rawProtocol = headerText(headers, protocolHeader);
  const rawPort = headerText(headers, portHeader);
  const rawOrigin = headerText(headers, originHeader);
  const supplied = [hostHeader, protocolHeader, portHeader, originHeader].some(
    (name) => Object.hasOwn(headers, name),
  );
  if (!supplied) return {};

  const host = safeHost(rawHost);
  const protocol = safeProtocol(rawProtocol);
  const port = rawPort === undefined ? undefined : safePort(rawPort);
  const origin = rawOrigin === undefined ? undefined : safeOrigin(rawOrigin);
  if (!host || !protocol || (rawPort !== undefined && !port) || (rawOrigin !== undefined && !origin)) {
    return null;
  }
  return { host, protocol, port, origin };
}

function connectionHeaderNames(headers) {
  const value = headerText(headers, "connection") ?? "";
  return new Set(
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

function requestHeaders(headers, metadata, upgrade) {
  const result = Object.create(null);
  const connectionNames = connectionHeaderNames(headers);
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      value === undefined ||
      name === trafficHeader ||
      name.startsWith(relayHeaderPrefix) ||
      name === "host" ||
      name === "origin" ||
      name === "forwarded" ||
      name.startsWith("x-forwarded-") ||
      connectionNames.has(name) ||
      (!upgrade && normalHopHeaders.has(name)) ||
      (upgrade &&
        normalHopHeaders.has(name) &&
        name !== "connection" &&
        name !== "upgrade")
    ) {
      continue;
    }
    result[name] = value;
  }

  result.host = metadata.host ?? (targetHost + ":" + targetPort);
  if (metadata.origin) result.origin = metadata.origin;
  if (metadata.host) result["x-forwarded-host"] = metadata.host;
  if (metadata.protocol) result["x-forwarded-proto"] = metadata.protocol;
  if (metadata.port) result["x-forwarded-port"] = metadata.port;
  if (upgrade) {
    const requestedUpgrade = headerText(headers, "upgrade");
    if (!requestedUpgrade || !/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/.test(requestedUpgrade)) {
      return null;
    }
    result.connection = "Upgrade";
    result.upgrade = requestedUpgrade;
  }
  return result;
}

function responseHeaders(headers) {
  const result = Object.create(null);
  const connectionNames = connectionHeaderNames(headers);
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      value === undefined ||
      name === trafficHeader ||
      name.startsWith(relayHeaderPrefix) ||
      connectionNames.has(name) ||
      normalHopHeaders.has(name)
    ) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

function validRequestTarget(value) {
  return value === "*" || value.startsWith("/");
}

function failHttp(response, status, body) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 8,
  timeout: 30000,
});

function handleHttpRequest(request, response) {
  if (
    request.method === "CONNECT" ||
    !request.url ||
    !validRequestTarget(request.url)
  ) {
    failHttp(response, 400, "Invalid preview request");
    return;
  }
  const metadata = relayMetadata(request.headers);
  const headers = metadata && requestHeaders(request.headers, metadata, false);
  if (!metadata || !headers) {
    failHttp(response, 400, "Invalid preview metadata");
    return;
  }

  const upstream = http.request(
    {
      host: targetHost,
      port: targetPort,
      method: request.method,
      path: request.url,
      headers,
      agent,
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        responseHeaders(upstreamResponse.headers),
      );
      upstreamResponse.on("error", () => response.destroy());
      upstreamResponse.pipe(response);
    },
  );
  upstream.setTimeout(120000, () => upstream.destroy());
  upstream.on("error", () => failHttp(response, 502, "Preview upstream unavailable"));
  request.on("aborted", () => upstream.destroy());
  request.on("error", () => upstream.destroy());
  request.pipe(upstream);
}

const server = http.createServer({
  maxHeaderSize: 64 * 1024,
  requestTimeout: 120000,
  headersTimeout: 10000,
  keepAliveTimeout: 5000,
});

function socketResponseHead(response, upgrade) {
  const status = response.statusCode ?? 502;
  const reason = http.STATUS_CODES[status] ?? "";
  const lines = ["HTTP/1.1 " + status + " " + reason];
  const connectionNames = connectionHeaderNames(response.headers);
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const rawName = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (!rawName || value === undefined) continue;
    const name = rawName.toLowerCase();
    if (
      name === trafficHeader ||
      name.startsWith(relayHeaderPrefix) ||
      (upgrade &&
        normalHopHeaders.has(name) &&
        name !== "connection" &&
        name !== "upgrade") ||
      (!upgrade && (normalHopHeaders.has(name) || connectionNames.has(name))) ||
      (upgrade && name !== "connection" && name !== "upgrade" && connectionNames.has(name))
    ) {
      continue;
    }
    lines.push(rawName + ": " + value);
  }
  if (!upgrade) lines.push("Connection: close");
  return lines.join("\r\n") + "\r\n\r\n";
}

function handleUpgrade(request, downstream, downstreamHead) {
  if (
    request.method !== "GET" ||
    !request.url ||
    !validRequestTarget(request.url)
  ) {
    downstream.destroy();
    return;
  }
  const metadata = relayMetadata(request.headers);
  const headers = metadata && requestHeaders(request.headers, metadata, true);
  if (!metadata || !headers) {
    downstream.destroy();
    return;
  }

  const upstreamRequest = http.request({
    host: targetHost,
    port: targetPort,
    method: "GET",
    path: request.url,
    headers,
    agent: false,
  });
  const fail = () => {
    upstreamRequest.destroy();
    downstream.destroy();
  };
  upstreamRequest.setTimeout(10000, fail);
  upstreamRequest.on("error", fail);
  downstream.on("error", () => upstreamRequest.destroy());
  downstream.on("close", () => upstreamRequest.destroy());
  upstreamRequest.on("upgrade", (upstreamResponse, upstream, upstreamHead) => {
    downstream.write(socketResponseHead(upstreamResponse, true));
    if (upstreamHead.length > 0) downstream.write(upstreamHead);
    if (downstreamHead.length > 0) upstream.write(downstreamHead);
    upstream.on("error", () => downstream.destroy());
    downstream.pipe(upstream).pipe(downstream);
  });
  upstreamRequest.on("response", (upstreamResponse) => {
    downstream.write(socketResponseHead(upstreamResponse, false));
    upstreamResponse.pipe(downstream);
  });
  upstreamRequest.end();
}

function handleClientError(_error, socket) {
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  } else {
    socket.destroy();
  }
}

function dropRelayPrivileges() {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    process.getuid() !== 0
  ) {
    throw new Error("privilege-drop-failed");
  }
  process.setgroups([]);
  process.setgid("${E2B_RELAY_USER}");
  process.setuid("${E2B_RELAY_USER}");
  const uid = process.getuid();
  const gid = process.getgid();
  const groups = process.getgroups();
  if (uid === 0 || gid === 0 || groups.some((group) => group !== gid)) {
    throw new Error("privilege-drop-failed");
  }
  const status = readFileSync("/proc/self/status", "utf8");
  const field = (name) => status.match(new RegExp("^" + name + ":\\s*(\\S+)", "m"))?.[1];
  if (
    field("NoNewPrivs") !== "1" ||
    !["CapInh", "CapPrm", "CapEff", "CapAmb"].every(
      (name) => /^0+$/.test(field(name) ?? ""),
    )
  ) {
    throw new Error("privilege-drop-failed");
  }
}

server.maxConnections = 256;
server.maxRequestsPerSocket = 1000;
server.listen({ host: "0.0.0.0", port: relayPort, exclusive: true }, () => {
  try {
    // Node binds while root, then drops every identity/capability before any
    // request handler is attached. A dead relay therefore leaves a privileged
    // port that project code cannot squat.
    dropRelayPrivileges();
  } catch {
    server.close();
    process.exit(77);
    return;
  }
  server.on("request", handleHttpRequest);
  server.on("upgrade", handleUpgrade);
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("clientError", handleClientError);
});

function shutDown() {
  server.close(() => process.exit(0));
  agent.destroy();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.once("SIGINT", shutDown);
process.once("SIGTERM", shutDown);
`;
