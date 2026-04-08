import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { cors } from "hono/cors";
import { db } from "./db/index.js";
import { user } from "./db/auth-schema.js";
import { conversations, messages, projectMembers, projects } from "./db/schema.js";
import { auth, type Session, type SessionUser } from "./lib/auth.js";
import { adminRouter } from "./routes/admin.js";
import { githubRouter } from "./routes/github.js";
import { projectsRouter } from "./routes/projects.js";
import { teamRouter } from "./routes/team.js";
import { clientsRouter, getClientSessionFromCookie } from "./routes/clients.js";
import { runProjectAgent } from "./services/agent.js";
import { ensureRepoCloned, getPreviewSubdomainPort } from "./services/workspace.js";
import { getProjectByPort, getPreviewStatus, describeStage } from "./services/preview-status.js";
import type { ProjectRole } from "./db/app-schema.js";

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
  // Once we latch into "errored" we stop touching the DOM — otherwise a
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
const HIDE_DEV_TOOLBARS_CSS = `
<style data-quillra-preview>
  astro-dev-toolbar, astro-dev-overlay { display: none !important; }
  #__next-build-watcher, [data-nextjs-toast], [data-nextjs-dialog-overlay],
  [data-nextjs-toast-wrapper], nextjs-portal { display: none !important; }
  #__remix-dev-tools-iframe, #remix-dev-tools-iframe { display: none !important; }
  #vue-devtools-container, .__vue-devtools-toolbar__ { display: none !important; }
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
      return list.includes(origin) ? origin : list[0] ?? "";
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
    const m = /(?:^|;\s*)quillra_client_session=([^;]+)/.exec(cookieHeader);
    const token = m?.[1];
    const cs = await getClientSessionFromCookie(token);
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
      c.set("user", null);
      c.set("session", null);
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
  // boot page to reload regardless of what our in-memory state says — the
  // map can go stale across server restarts.
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1500),
      redirect: "manual",
    });
    if (probe.status > 0) {
      return c.json({ stage: "ready", label: "Ready", detail: "Loading your site…" });
    }
  } catch { /* not reachable yet — fall through to status reporting */ }

  const projectId = getProjectByPort(port);
  if (!projectId) {
    return c.json({ stage: "starting", label: "Starting the preview", detail: "Waking up the dev server…" });
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
  const body = await c.req.json().catch(() => null) as { language?: string } | null;
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

app.get(
  "/ws/chat/:projectId",
  upgradeWebSocket(async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      return {
        onOpen(_evt, ws) {
          ws.close(4400, "Bad path");
        },
      };
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) {
      return {
        onOpen(_evt, ws) {
          ws.close(4401, "Unauthorized");
        },
      };
    }

    return {
      async onMessage(evt, ws) {
        try {
          const raw = typeof evt.data === "string" ? evt.data : "";
          const parsed = JSON.parse(raw) as {
            type?: string;
            content?: string;
            conversationId?: string;
            attachments?: { path: string; originalName: string; kind?: "image" | "content" }[];
          };
          if (parsed.type !== "message" || typeof parsed.content !== "string" || !parsed.content.trim()) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid message payload" }));
            return;
          }
          const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];

          const [m] = await db
            .select()
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.projectId, projectId),
                eq(projectMembers.userId, session.user.id),
              ),
            )
            .limit(1);
          if (!m) {
            ws.send(JSON.stringify({ type: "error", message: "Not a project member" }));
            return;
          }

          const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
          if (!p) {
            ws.send(JSON.stringify({ type: "error", message: "Project not found" }));
            return;
          }

          let repoPath: string;
          try {
            repoPath = await ensureRepoCloned(p.id, p.githubRepoFullName, p.defaultBranch);
          } catch (e) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: e instanceof Error ? e.message : "Clone failed (set GITHUB_TOKEN?)",
              }),
            );
            return;
          }

          // Get or create conversation
          let convId = parsed.conversationId;
          let agentSessionId: string | null = null;
          if (convId) {
            const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
            agentSessionId = conv?.agentSessionId ?? null;
          } else {
            convId = nanoid();
            await db.insert(conversations).values({
              id: convId,
              projectId,
              title: parsed.content.slice(0, 100),
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            ws.send(JSON.stringify({ type: "conversation_created", conversationId: convId }));
          }

          await db.insert(messages).values({
            projectId,
            conversationId: convId,
            userId: session.user.id,
            role: "user",
            content: parsed.content,
            attachments: attachments.length > 0 ? JSON.stringify(attachments) : null,
            createdAt: new Date(),
          });

          // Build the prompt — if attachments are present, prepend a clear note for the agent
          let promptText = parsed.content;
          if (attachments.length > 0) {
            const images = attachments.filter((a) => a.kind !== "content");
            const contents = attachments.filter((a) => a.kind === "content");
            const lines: string[] = [];
            if (images.length > 0) {
              lines.push(
                `${images.length} image${images.length > 1 ? "s" : ""} were attached and are already saved to the repo at:`,
              );
              for (const a of images) lines.push(`- ${a.path} (originally: ${a.originalName})`);
              lines.push(
                "Use these images where the user describes. Reference them via the framework's image system when applicable. Do not re-create or move them unless asked.",
              );
            }
            if (contents.length > 0) {
              if (images.length > 0) lines.push("");
              lines.push(
                `${contents.length} text/content file${contents.length > 1 ? "s" : ""} were attached and are already saved to the repo at:`,
              );
              for (const a of contents) lines.push(`- ${a.path} (originally: ${a.originalName})`);
              lines.push(
                "IMPORTANT: do NOT inline or retype the content of these files in any source file you edit. Treat them as assets: the framework should import or include them (e.g. an Astro component reading the file, an MDX import, a fetch from `/content/...`, or a static include). This keeps the source small and the original file the single source of truth.",
              );
            }
            promptText = `${lines.join("\n")}\n\nUser message:\n${parsed.content}`;
          }

          // Look up the user's preferred language so the agent can reply in it
          const [userRow] = await db
            .select({ language: user.language })
            .from(user)
            .where(eq(user.id, session.user.id))
            .limit(1);
          const userLanguage = userRow?.language ?? null;

          let assistantText = "";
          const role = m.role as ProjectRole;
          for await (const ev of runProjectAgent({
            cwd: repoPath,
            prompt: promptText,
            role,
            projectId,
            language: userLanguage,
            agentSessionId,
            onSessionId: (sid) => {
              agentSessionId = sid;
              void db.update(conversations).set({ agentSessionId: sid }).where(eq(conversations.id, convId!)).catch(() => {});
            },
          })) {
            ws.send(JSON.stringify(ev));
            if (ev.type === "stream" && typeof ev.text === "string") {
              assistantText += ev.text;
            }
          }

          if (assistantText) {
            await db.insert(messages).values({
              projectId,
              conversationId: convId,
              userId: null,
              role: "assistant",
              content: assistantText,
              createdAt: new Date(),
            });
            // Update conversation title from first assistant response if it was auto-generated
            const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
            if (conv && !conv.title?.includes(" ")) {
              await db.update(conversations).set({ title: parsed.content.slice(0, 100), updatedAt: new Date() }).where(eq(conversations.id, convId));
            } else {
              await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, convId));
            }
          }

          ws.send(JSON.stringify({ type: "refresh_preview" }));
        } catch (e) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      },
    };
  }),
);

/* ── Preview reverse proxy ────────────────────────────────────────────
 * Proxies /__preview/:port/* → localhost:port/* so the preview iframe
 * loads over the same HTTPS origin — no mixed-content, no extra DNS.
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
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Quillra API listening on http://localhost:${info.port}`);
});
injectWebSocket(server);
