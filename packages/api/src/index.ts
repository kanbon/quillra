// Resolve and validate Railway's public origin and persistent data mount before
// any module captures environment values or writes boot state.
import "./lib/boot-railway.js";

// Bootstrap BETTER_AUTH_SECRET (and downstream-derived crypto key) after the
// Railway storage guard. Side-effect import; do not move below other imports.
import "./lib/boot-secrets.js";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep the process alive through library-level bugs that throw inside a
// detached async chain, e.g. the Claude Agent SDK's MCP transport
// emitting an uncaught rejection mid-stream. Default node behaviour is
// to crash the whole API container; one broken chat turn shouldn't
// take every other signed-in user with it. Just log so the operator
// still notices in docker logs.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[unhandledRejection]",
    reason instanceof Error ? (reason.stack ?? reason.message) : reason,
  );
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.stack ?? err.message);
});
import { serve, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { user } from "./db/auth-schema.js";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { type Session, type SessionUser, auth } from "./lib/auth.js";
import { API_BODY_MAX_BYTES } from "./lib/request-limits.js";
import { CLIENT_SESSION_COOKIE, TEAM_SESSION_COOKIE } from "./lib/session-cookies.js";
import { adminRouter } from "./routes/admin.js";
import { clientsRouter, getClientSessionFromCookie } from "./routes/clients.js";
import { githubRouter } from "./routes/github.js";
import { instanceRouter } from "./routes/instance.js";
import { projectsRouter } from "./routes/projects/index.js";
import { setupRouter } from "./routes/setup.js";
import { getTeamSessionFromCookie, teamLoginRouter } from "./routes/team-login.js";
import { teamRouter } from "./routes/team.js";
import { resolveListenHost } from "./services/listen-host.js";
import { resolvePreviewAccess } from "./services/preview-access.js";
import { previewBootHtml } from "./services/preview-boot.js";
import {
  resolveActivePreviewCapability,
  resolveReservedPreviewCapability,
} from "./services/preview-capability.js";
import {
  PREVIEW_WEBSOCKET_MAX_PAYLOAD_BYTES,
  type PreviewGatewayAccess,
  createPreviewGateway,
} from "./services/preview-gateway.js";
import {
  PREVIEW_UPSTREAM_TIMEOUT_MS,
  injectPreviewToolbarCss,
  rewritePreviewResourcePaths,
  sanitizePreviewRequestHeaders,
  securePreviewResponse,
} from "./services/preview-proxy.js";
import { readPreviewStatus } from "./services/preview-status.js";
import { previewUpstreamUrl } from "./services/preview-upstream.js";
import { startReportScheduler } from "./services/report-scheduler.js";
import { getTrustedOrigins, isTrustedBrowserRequest } from "./services/trusted-origins.js";
import { getPreviewAddress, sweepOrphanedProjectWorkspaces } from "./services/workspace.js";
import { chatWsHandler } from "./ws/chat-handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

type Variables = {
  user: SessionUser | null;
  session: Session | null;
  /** Set when the request was authenticated via the client session cookie */
  clientSession: { projectId: string } | null;
  previewAccess: PreviewGatewayAccess | null;
};

async function requirePreviewAccess(c: Context<{ Variables: Variables }>, rawPort: string) {
  const result = await resolvePreviewAccess(rawPort, {
    userId: c.get("user")?.id ?? null,
    clientProjectId: c.get("clientSession")?.projectId ?? null,
  });
  if (result.ok) return result;

  if (result.reason === "unauthorized") {
    return { error: c.json({ error: "Unauthorized" }, 401) } as const;
  }
  if (result.reason === "invalid-port") {
    return { error: c.json({ error: "Invalid preview port" }, 400) } as const;
  }
  return { error: c.json({ error: "Preview not found" }, 404) } as const;
}

function externalPreviewRequestUrl(c: Context): string {
  const request = new URL(c.req.url);
  try {
    const publicOrigin = new URL(process.env.BETTER_AUTH_URL ?? request.origin);
    return new URL(`${request.pathname}${request.search}`, publicOrigin).toString();
  } catch {
    return request.toString();
  }
}

const app = new Hono<{ Variables: Variables }>();

// Global error handler. Without this, Hono swallows handler exceptions
// into a bare 500 with no body and no stack in `docker compose logs`,
// which made the original first-run wizard "Internal server error" in
// production almost impossible to triage. Now every unhandled throw in
// a route prints a labelled stack to stderr (visible in container logs)
// and the response body carries a request-id the operator can grep for.
app.onError((err, c) => {
  const requestId = `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const method = c.req.method;
  const url = new URL(c.req.url).pathname;
  console.error(
    `[api-error] ${requestId} ${method} ${url}\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  return c.json(
    {
      error: "Internal server error",
      requestId,
    },
    500,
  );
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: PREVIEW_WEBSOCKET_MAX_PAYLOAD_BYTES,
});
const previewGateway = createPreviewGateway(upgradeWebSocket);
app.use("*", previewGateway.middleware);
app.get("/api/caddy-check", previewGateway.caddyCheck);

function allowSandboxOrigin(c: Context): void {
  c.res.headers.set("Access-Control-Allow-Origin", "null");
  c.res.headers.delete("Access-Control-Allow-Credentials");
  c.res.headers.delete("Access-Control-Expose-Headers");
}

// Capability requests wrap global CORS so opaque-origin module/fetch requests
// receive ACAO:null and never inherit the app's credentialed CORS policy.
app.use("/__preview/:port{[0-9]+}/:cap/*", async (c, next) => {
  const access = resolveReservedPreviewCapability(c.req.param("port"), c.req.param("cap"));
  if (!access.ok) return c.text("Preview not found", 404);

  if (c.req.method === "OPTIONS") {
    const requestedMethod = (c.req.header("access-control-request-method") ?? "GET").toUpperCase();
    const allowedMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
    if (!allowedMethods.has(requestedMethod)) return c.text("Method not allowed", 405);

    const response = securePreviewResponse(
      new Response(null, { status: 204 }),
      externalPreviewRequestUrl(c),
      access.port,
      c.req.param("cap"),
    );
    response.headers.set("access-control-allow-methods", requestedMethod);
    const requestedHeaders = c.req.header("access-control-request-headers");
    if (requestedHeaders) response.headers.set("access-control-allow-headers", requestedHeaders);
    response.headers.set("access-control-max-age", "600");
    return response;
  }

  await next();
  allowSandboxOrigin(c);
});

// The boot page polls status with the same bearer capability but outside the
// proxy path, so it needs the same narrow null-origin response override.
app.use("/api/preview-status", async (c, next) => {
  const capability = c.req.query("cap");
  const access = capability
    ? resolveReservedPreviewCapability(c.req.query("port") ?? "", capability)
    : null;
  await next();
  if (access?.ok) allowSandboxOrigin(c);
});

app.use(
  "*",
  cors({
    origin: (origin) => {
      const list = getTrustedOrigins();
      if (!origin) return list[0] ?? "";
      return list.includes(origin) ? origin : (list[0] ?? "");
    },
    allowHeaders: ["Content-Type", "Cookie"],
    exposeHeaders: ["Content-Length"],
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.use(
  "/api/*",
  bodyLimit({
    maxSize: API_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  }),
);

// Browsers attach Origin to state-changing fetch and form requests. Keep a
// preview, including a same-site deployment, from issuing blind credentialed
// mutations against Quillra's control API. Server and CLI calls without a
// browser origin remain supported.
app.use("/api/*", async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  if (!isTrustedBrowserRequest(c.req.raw.headers)) {
    return c.json({ error: "Untrusted request origin" }, 403);
  }
  return next();
});

app.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user) {
    c.set("user", session.user);
    c.set("session", session.session);
  } else {
    // Fall through to client cookie
    const clientToken = getCookie(c, CLIENT_SESSION_COOKIE);
    const cs = await getClientSessionFromCookie(clientToken);
    if (cs) {
      // Synthesize a SessionUser-shaped object the rest of the app can use
      c.set("user", {
        id: cs.user.id,
        email: cs.user.email,
        name: cs.user.name ?? cs.user.email,
        image: cs.user.image ?? null,
        emailVerified: cs.user.emailVerified,
        createdAt: cs.user.createdAt,
        updatedAt: cs.user.updatedAt,
      } as unknown as SessionUser);
      c.set("session", null);
      // Pin client session info so route guards can refuse cross-project access
      c.set("clientSession", { projectId: cs.projectId });
    } else {
      // Final fallback: team email-code session (admins/editors
      // who don't have or don't want a GitHub account).
      const teamToken = getCookie(c, TEAM_SESSION_COOKIE);
      const ts = await getTeamSessionFromCookie(teamToken);
      if (ts) {
        c.set("user", {
          id: ts.user.id,
          email: ts.user.email,
          name: ts.user.name ?? ts.user.email,
          image: ts.user.image ?? null,
          emailVerified: ts.user.emailVerified,
          createdAt: ts.user.createdAt,
          updatedAt: ts.user.updatedAt,
        } as unknown as SessionUser);
        c.set("session", null);
      } else {
        c.set("user", null);
        c.set("session", null);
      }
    }
  }
  await next();
});

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/api/preview-status", async (c) => {
  const rawPort = c.req.query("port") ?? "";
  const capability = c.req.query("cap");
  let port: number;
  let projectId: string;

  if (capability) {
    const access = resolveReservedPreviewCapability(rawPort, capability);
    if (!access.ok) return c.json({ error: "Preview not found" }, 404);
    ({ port, projectId } = access);
    c.header("Access-Control-Allow-Origin", "null");
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
  } else {
    const access = await requirePreviewAccess(c, rawPort);
    if ("error" in access) return access.error;
    ({ port, projectId } = access);
  }

  // Probe only after resolving this port to an authorized project. Otherwise
  // this endpoint becomes an authenticated localhost port scanner.
  return c.json(await readPreviewStatus(projectId, port));
});

app.get("/api/session", async (c) => {
  const sessionUser = c.get("user");
  if (!sessionUser) return c.json({ user: null, kind: "none" as const, projectId: null });
  const [row] = await db
    .select({ instanceRole: user.instanceRole, language: user.language })
    .from(user)
    .where(eq(user.id, sessionUser.id))
    .limit(1);
  const clientSession = c.get("clientSession");
  const kind = clientSession ? "client" : c.get("session") ? "github" : "team";
  return c.json({
    kind,
    projectId: clientSession?.projectId ?? null,
    user: {
      ...sessionUser,
      // A project-scoped client cookie must not inherit or even advertise the
      // underlying account's instance-wide role.
      instanceRole: clientSession ? null : (row?.instanceRole ?? null),
      language: row?.language ?? null,
    },
  });
});

app.patch("/api/session/language", async (c) => {
  const sessionUser = c.get("user");
  if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { language?: string } | null;
  const lang = body?.language;
  if (lang !== "en" && lang !== "de") return c.json({ error: "Invalid language" }, 400);
  await db.update(user).set({ language: lang }).where(eq(user.id, sessionUser.id));
  return c.json({ ok: true, language: lang });
});

app.route("/api/admin", adminRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/github", githubRouter);
app.route("/api/team", teamRouter);
app.route("/api/clients", clientsRouter);
app.route("/api/team-login", teamLoginRouter);
app.route("/api/setup", setupRouter);
app.route("/api/instance", instanceRouter);

app.use("/ws/chat/*", async (c, next) => {
  if (!isTrustedBrowserRequest(c.req.raw.headers)) {
    return c.json({ error: "Untrusted request origin" }, 403);
  }
  return next();
});
app.get("/ws/chat/:projectId", upgradeWebSocket(chatWsHandler));

app.all("/__preview/:port{[0-9]+}/:cap", (c) => {
  const rawPort = c.req.param("port");
  const capability = c.req.param("cap");
  const access = resolveReservedPreviewCapability(rawPort, capability);
  if (!access.ok) return c.text("Preview not found", 404);
  return securePreviewResponse(
    new Response(null, {
      status: 302,
      headers: { location: `/__preview/${access.port}/${capability}/` },
    }),
    externalPreviewRequestUrl(c),
    access.port,
    capability,
  );
});

/* ── Preview reverse proxy ────────────────────────────────────────────
 * Proxies /__preview/:port/:cap/* → localhost:port/*. The opaque path
 * capability keeps sandbox subresources authorized without app cookies.
 */
app.all("/__preview/:port{[0-9]+}/:cap/*", async (c) => {
  const rawPort = c.req.param("port");
  const capability = c.req.param("cap");
  const access = resolveReservedPreviewCapability(rawPort, capability);
  if (!access.ok) return c.text("Preview not found", 404);
  const { port } = access;
  if (!resolveActivePreviewCapability(rawPort, capability).ok) {
    return securePreviewResponse(
      new Response(previewBootHtml(port, capability), {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
      externalPreviewRequestUrl(c),
      port,
      capability,
    );
  }
  const rest = c.req.path.replace(`/__preview/${rawPort}/${capability}`, "") || "/";
  const requestUrl = new URL(c.req.url);
  const upstreamAccess = previewUpstreamUrl(access.projectId, port, rest, requestUrl.search);
  if (!upstreamAccess) {
    return securePreviewResponse(
      new Response(previewBootHtml(port, capability), {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
      externalPreviewRequestUrl(c),
      port,
      capability,
    );
  }

  const headers = sanitizePreviewRequestHeaders(c.req.raw.headers);
  for (const [name, value] of Object.entries(upstreamAccess.headers)) {
    headers.set(name, value);
  }
  headers.set("accept-encoding", "identity");

  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
      signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(PREVIEW_UPSTREAM_TIMEOUT_MS)]),
    };
    if (init.body) init.duplex = "half";
    const upstream = await fetch(upstreamAccess.url, init);

    const withCss = await injectPreviewToolbarCss(upstream);
    const withScopedPaths = await rewritePreviewResourcePaths(withCss, port, capability);
    return securePreviewResponse(
      withScopedPaths,
      externalPreviewRequestUrl(c),
      port,
      capability,
      new URL(upstreamAccess.url).origin,
    );
  } catch {
    return securePreviewResponse(
      new Response(previewBootHtml(port, capability), {
        // The boot page was served successfully. It polls the protected
        // preview-status endpoint for the actual startup result, so a 502
        // here only produces a misleading browser-console error.
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
      externalPreviewRequestUrl(c),
      port,
      capability,
    );
  }
});

// Upgrade old cap-less bookmarks only while an app session is present.
app.all("/__preview/:port{[0-9]+}", async (c) => {
  const access = await requirePreviewAccess(c, c.req.param("port"));
  if ("error" in access) return access.error;
  return c.redirect(getPreviewAddress(access.projectId, access.port).url, 302);
});

app.use(
  "/assets/*",
  serveStatic({
    root: publicDir,
    rewriteRequestPath: (p) => p.replace(/^\//, ""),
  }),
);

app.get("*", async (c) => {
  const p = c.req.path;
  if (p.startsWith("/api") || p.startsWith("/ws")) {
    return c.notFound();
  }
  const rel = p === "/" ? "index.html" : p.slice(1);
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = path.join(publicDir, safe);
  if (safe && existsSync(file) && !file.endsWith(path.sep)) {
    try {
      const buf = readFileSync(file);
      const ext = path.extname(file);
      const mime =
        ext === ".html"
          ? "text/html"
          : ext === ".js"
            ? "text/javascript"
            : ext === ".css"
              ? "text/css"
              : ext === ".svg"
                ? "image/svg+xml"
                : ext === ".webp"
                  ? "image/webp"
                  : ext === ".json"
                    ? "application/json"
                    : "application/octet-stream";
      return c.body(buf, 200, { "Content-Type": mime, "Cache-Control": "public, max-age=3600" });
    } catch {
      /* fall through */
    }
  }
  const htmlPath = path.join(publicDir, "index.html");
  if (!existsSync(htmlPath)) {
    return c.text("Run `pnpm build` (web outputs to packages/api/public).", 503);
  }
  return c.html(readFileSync(htmlPath, "utf-8"));
});

// Retry workspace deletions that were interrupted by a previous process or
// container shutdown. Capture the active IDs and schedule the sweep before
// binding the server so a newly-created project cannot race this snapshot.
try {
  const rows = await db.select({ id: projects.id }).from(projects);
  const cleanups = sweepOrphanedProjectWorkspaces(rows.map((row) => row.id));
  if (cleanups.length > 0) {
    console.info(`[workspace] scheduled cleanup for ${cleanups.length} orphaned workspace(s)`);
  }
} catch (error) {
  console.warn("[workspace] failed to schedule orphaned workspace cleanup:", error);
}

const port = Number(process.env.PORT ?? 3000);
const hostname = resolveListenHost();
serve({ fetch: app.fetch, port, hostname, websocket: { server: wss } }, (_info) => {});

// Kick off the monthly-report cron + boot-time catch-up. Runs in the
// same process as the API; when Quillra moves to a multi-worker setup
// this will need to be gated to a single leader.
startReportScheduler();
