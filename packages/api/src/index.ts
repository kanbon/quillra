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
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { user } from "./db/auth-schema.js";
import { db } from "./db/index.js";
import { type Session, type SessionUser, auth } from "./lib/auth.js";
import { adminRouter } from "./routes/admin.js";
import { clientsRouter, getClientSessionFromCookie } from "./routes/clients.js";
import { githubRouter } from "./routes/github.js";
import { instanceRouter } from "./routes/instance.js";
import { projectsRouter } from "./routes/projects/index.js";
import { setupRouter } from "./routes/setup.js";
import { getTeamSessionFromCookie, teamLoginRouter } from "./routes/team-login.js";
import { teamRouter } from "./routes/team.js";
import { describeStage, getPreviewStatus, getProjectByPort } from "./services/preview-status.js";
import { startReportScheduler } from "./services/report-scheduler.js";
import { getPreviewSubdomainPort } from "./services/workspace.js";
import { chatWsHandler } from "./ws/chat-handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

type Variables = {
  user: SessionUser | null;
  session: Session | null;
  /** Set when the request was authenticated via the client session cookie */
  clientSession: { projectId: string } | null;
};

function trustedOriginsList(): string[] {
  const raw =
    process.env.TRUSTED_ORIGINS ??
    "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
      error: err instanceof Error ? err.message : "Internal server error",
      requestId,
    },
    500,
  );
});

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
/**
 * Build the polling HTML shown while the preview is starting up. Includes
 * the inline JS that fetches /api/preview-status?port=… and updates the
 * stage label until the upstream is ready.
 */
function previewBootHtml(port: string | number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Starting preview…</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #fafafa; font-family: -apple-system, system-ui, sans-serif; color: #525252; }
  .wrap { display: flex; align-items: center; justify-content: center; height: 100%; padding: 24px; }
  .card { width: 100%; max-width: 360px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 22px; color: #262626; text-align: center; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
  .step { display: flex; align-items: center; gap: 12px; font-size: 13px; line-height: 1.4; transition: color .25s, opacity .25s; color: #a3a3a3; opacity: 0.6; }
  .step.active { color: #262626; opacity: 1; }
  .step.done { color: #525252; opacity: 1; }
  .step.failed { color: #b91c1c; opacity: 1; }
  .bullet { width: 18px; height: 18px; flex-shrink: 0; position: relative; }
  .bullet > * { position: absolute; inset: 0; margin: auto; display: none; }
  .bullet .dot { width: 6px; height: 6px; border-radius: 50%; background: #d4d4d4; display: block; }
  .bullet .spinner { width: 14px; height: 14px; border: 2px solid #e5e5e5; border-top-color: #262626; border-radius: 50%; animation: spin 0.9s linear infinite; box-sizing: border-box; }
  .bullet .check, .bullet .x { width: 18px; height: 18px; }
  .bullet .check { color: #22c55e; }
  .bullet .x { color: #ef4444; }
  .step.active .dot, .step.done .dot, .step.failed .dot { display: none; }
  .step.active .spinner { display: block; }
  .step.done .check { display: block; }
  .step.failed .x { display: block; }
  .detail { margin: 22px 0 0; font-size: 12px; line-height: 1.5; color: #a3a3a3; text-align: center; min-height: 1.2em; }
  .retry { display: block; margin: 22px auto 0; padding: 8px 18px; font-size: 12px; font-weight: 500; background: #262626; color: white; border: none; border-radius: 8px; cursor: pointer; }
  .retry:hover { background: #525252; }
  .hidden { display: none !important; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1 id="label">Starting your preview</h1>
    <ul class="steps">
      <li class="step" data-stage="cloning">
        <span class="bullet">
          <span class="dot"></span>
          <span class="spinner"></span>
          <svg class="check" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          <svg class="x" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </span>
        Fetching your site files
      </li>
      <li class="step" data-stage="installing">
        <span class="bullet">
          <span class="dot"></span>
          <span class="spinner"></span>
          <svg class="check" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          <svg class="x" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </span>
        Setting things up (one-time, can take a minute)
      </li>
      <li class="step" data-stage="starting">
        <span class="bullet">
          <span class="dot"></span>
          <span class="spinner"></span>
          <svg class="check" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          <svg class="x" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </span>
        Opening your preview
      </li>
    </ul>
    <p class="detail" id="detail">Getting things ready…</p>
    <button id="retry" class="retry hidden" onclick="window.location.reload()">Retry</button>
  </div>
</div>
<script>
(function() {
  var stages = ['cloning', 'installing', 'starting', 'ready'];
  var steps = document.querySelectorAll('.step');
  var attempts = 0;
  var pollId = 0;
  // Once we latch into "errored" we stop touching the DOM, otherwise a
  // stale poll that started before the error flips us back to spinner.
  var errored = false;

  function setStage(stage) {
    if (errored) return;
    var idx = stages.indexOf(stage);
    if (idx === -1) idx = 0;
    steps.forEach(function(s) {
      var sIdx = stages.indexOf(s.dataset.stage);
      s.classList.remove('active', 'done', 'failed');
      if (sIdx < idx) s.classList.add('done');
      else if (sIdx === idx) s.classList.add('active');
    });
  }

  function showError(label, detail) {
    if (errored) return;
    errored = true;
    if (pollId) { clearInterval(pollId); pollId = 0; }
    document.getElementById('label').textContent = label || 'Preview unavailable';
    document.getElementById('detail').textContent = detail || 'Something went wrong while starting your preview.';
    document.getElementById('retry').classList.remove('hidden');
    // Mark the active (or first not-done) step as failed; leave previous as done
    var active = document.querySelector('.step.active');
    if (active) {
      active.classList.remove('active');
      active.classList.add('failed');
    } else {
      steps[steps.length - 1].classList.add('failed');
    }
  }

  function tick() {
    if (errored) return;
    attempts++;
    fetch('/api/preview-status?port=${port}', { credentials: 'omit' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (errored || !data) return;
        if (data.stage === 'error') {
          showError(data.label, data.detail);
          return;
        }
        if (data.detail) document.getElementById('detail').textContent = data.detail;
        setStage(data.stage);
        if (data.stage === 'ready') {
          if (pollId) { clearInterval(pollId); pollId = 0; }
          steps.forEach(function(s) { s.classList.remove('active', 'failed'); s.classList.add('done'); });
          setTimeout(function() { window.location.reload(); }, 400);
        }
      })
      .catch(function() {});

    if (attempts >= 30) {
      showError('Taking longer than expected', 'Your preview is still starting up. You can wait or retry.');
    }
  }
  tick();
  pollId = setInterval(tick, 1500);
})();
</script>
</body>
</html>`;
}

/**
 * CSS injected into preview HTML responses to hide framework dev toolbars
 * (Astro dev toolbar, Next.js indicators, SvelteKit, Vue, etc.) so the
 * preview iframe shows a clean rendering of the user's site.
 */
// Only hide the mini dev toolbars that float at the bottom of the page.
// NEVER hide error overlays (vite-error-overlay, astro-error-overlay, etc.)
//, those exist to tell the user something is broken in their code and
// swallowing them makes compile errors appear as blank pages.
const HIDE_DEV_TOOLBARS_CSS = `
<style data-quillra-preview>
  astro-dev-toolbar { display: none !important; }
  #__next-build-watcher, [data-nextjs-toast-wrapper] { display: none !important; }
  #svelte-kit-toolbar, [data-sveltekit-dev-toolbar] { display: none !important; }
</style>
`;

/** Inject the hide-toolbar style into a fetched HTML response, transparently. */
async function injectHideToolbarCss(upstream: Response): Promise<Response> {
  const ct = upstream.headers.get("content-type") ?? "";
  // Only touch successful HTML responses; never modify errors or assets
  if (upstream.status !== 200 || !ct.includes("text/html")) return upstream;
  // Clone first so we can fall back to the original body if something fails
  const cloned = upstream.clone();
  try {
    const html = await cloned.text();
    const injected = html.includes("</head>")
      ? html.replace("</head>", `${HIDE_DEV_TOOLBARS_CSS}</head>`)
      : `${HIDE_DEV_TOOLBARS_CSS}${html}`;
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(injected, { status: upstream.status, headers });
  } catch {
    // upstream still has its body intact because we cloned
    return upstream;
  }
}

/* ── Subdomain preview proxy ──────────────────────────────────────────
 * If the Host header matches {id}.PREVIEW_DOMAIN, proxy the entire
 * request to the dev server on the mapped port. Caddy terminates TLS
 * and forwards to us on :3000.
 */
app.use("*", async (c, next) => {
  const previewDomain = process.env.PREVIEW_DOMAIN;
  if (!previewDomain) return next();
  const host = (c.req.header("host") ?? "").split(":")[0];
  const suffix = `.${previewDomain}`;
  if (!host.endsWith(suffix)) return next();
  const id = host.slice(0, -suffix.length);
  if (!id) return next();
  // Internal Quillra paths (e.g. the polling status endpoint used by the
  // boot page) must NOT be forwarded to the user's dev server, even when
  // requested from a preview subdomain. Pass them through to our own
  // routers below.
  if (c.req.path.startsWith("/api/preview-status")) return next();
  const port = getPreviewSubdomainPort(id);
  if (!port) return c.text("Preview not found", 404);

  const target = `http://127.0.0.1:${port}${c.req.path}`;
  const url = new URL(target);
  url.search = new URL(c.req.url).search;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");

  try {
    const upstream = await fetch(url.toString(), {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
    });
    const withCss = await injectHideToolbarCss(upstream);
    const respHeaders = new Headers(withCss.headers);
    respHeaders.delete("transfer-encoding");
    return new Response(withCss.body, { status: withCss.status, headers: respHeaders });
  } catch {
    return c.html(previewBootHtml(port), 502);
  }
});

app.use(
  "*",
  cors({
    origin: (origin) => {
      const list = trustedOriginsList();
      if (!origin) return list[0] ?? "";
      return list.includes(origin) ? origin : (list[0] ?? "");
    },
    allowHeaders: ["Content-Type", "Cookie"],
    exposeHeaders: ["Content-Length"],
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user) {
    c.set("user", session.user);
    c.set("session", session.session);
  } else {
    // Fall through to client cookie
    const cookieHeader = c.req.header("cookie") ?? "";
    const mClient = /(?:^|;\s*)quillra_client_session=([^;]+)/.exec(cookieHeader);
    const clientToken = mClient?.[1];
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
      // Final fallback: team email-code session (admins/editors/translators
      // who don't have or don't want a GitHub account).
      const mTeam = /(?:^|;\s*)quillra_team_session=([^;]+)/.exec(cookieHeader);
      const teamToken = mTeam?.[1];
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
  const portStr = c.req.query("port") ?? "";
  const port = Number(portStr);
  if (!Number.isFinite(port)) return c.json({ stage: "idle", label: "Preparing", detail: "" });

  // Self-heal: actively probe the dev server. If it's reachable, tell the
  // boot page to reload regardless of what our in-memory state says, the
  // map can go stale across server restarts.
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1500),
      redirect: "manual",
    });
    if (probe.status > 0) {
      return c.json({ stage: "ready", label: "Ready", detail: "Loading your site…" });
    }
  } catch {
    /* not reachable yet, fall through to status reporting */
  }

  const projectId = getProjectByPort(port);
  if (!projectId) {
    return c.json({
      stage: "starting",
      label: "Starting the preview",
      detail: "Waking up the dev server…",
    });
  }
  const status = getPreviewStatus(projectId);
  const desc = describeStage(status.stage);
  return c.json({ stage: status.stage, label: desc.label, detail: status.message ?? desc.detail });
});

app.get("/api/caddy-check", (c) => {
  const domain = c.req.query("domain") ?? "";
  const previewDomain = process.env.PREVIEW_DOMAIN ?? "cms.kanbon.at";
  const suffix = `.${previewDomain}`;
  if (domain.endsWith(suffix)) {
    const id = domain.slice(0, -suffix.length);
    if (id && getPreviewSubdomainPort(id) !== undefined) return c.text("ok", 200);
  }
  return c.text("denied", 403);
});

app.get("/api/session", async (c) => {
  const sessionUser = c.get("user");
  if (!sessionUser) return c.json({ user: null });
  const [row] = await db
    .select({ instanceRole: user.instanceRole, language: user.language })
    .from(user)
    .where(eq(user.id, sessionUser.id))
    .limit(1);
  return c.json({
    user: {
      ...sessionUser,
      instanceRole: row?.instanceRole ?? null,
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

app.get("/ws/chat/:projectId", upgradeWebSocket(chatWsHandler));

/* ── Preview reverse proxy ────────────────────────────────────────────
 * Proxies /__preview/:port/* → localhost:port/* so the preview iframe
 * loads over the same HTTPS origin, no mixed-content, no extra DNS.
 */
app.all("/__preview/:port{[0-9]+}/*", async (c) => {
  const port = c.req.param("port");
  const rest = c.req.path.replace(`/__preview/${port}`, "") || "/";
  const target = `http://127.0.0.1:${port}${rest}`;
  const url = new URL(target);
  url.search = new URL(c.req.url).search;

  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");

  try {
    const upstream = await fetch(url.toString(), {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
    });

    const withCss = await injectHideToolbarCss(upstream);
    const respHeaders = new Headers(withCss.headers);
    respHeaders.delete("transfer-encoding");

    return new Response(withCss.body, {
      status: withCss.status,
      headers: respHeaders,
    });
  } catch {
    return c.html(previewBootHtml(port), 502);
  }
});

app.all("/__preview/:port{[0-9]+}", async (c) => {
  const port = c.req.param("port");
  return c.redirect(`/__preview/${port}/`, 302);
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
    return c.text("Run `yarn build` (web outputs to packages/api/public).", 503);
  }
  return c.html(readFileSync(htmlPath, "utf-8"));
});

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port }, (_info) => {});
injectWebSocket(server);

// Kick off the monthly-report cron + boot-time catch-up. Runs in the
// same process as the API; when Quillra moves to a multi-worker setup
// this will need to be gated to a single leader.
startReportScheduler();
