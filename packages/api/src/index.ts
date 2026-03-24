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
import { runProjectAgent } from "./services/agent.js";
import { ensureRepoCloned, getPreviewSubdomainPort } from "./services/workspace.js";
import type { ProjectRole } from "./db/app-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

type Variables = {
  user: SessionUser | null;
  session: Session | null;
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
    const respHeaders = new Headers(upstream.headers);
    respHeaders.delete("transfer-encoding");
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch {
    return c.html(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"></head>` +
      `<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui;color:#666">` +
      `<div style="text-align:center"><p style="font-size:14px">Starting preview server…</p>` +
      `<p style="font-size:12px;color:#999">This page will refresh automatically.</p></div></body></html>`,
      502,
    );
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
  c.set("user", session?.user ?? null);
  c.set("session", session?.session ?? null);
  await next();
});

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

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
  const [row] = await db.select({ instanceRole: user.instanceRole }).from(user).where(eq(user.id, sessionUser.id)).limit(1);
  return c.json({ user: { ...sessionUser, instanceRole: row?.instanceRole ?? null } });
});

app.route("/api/admin", adminRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/github", githubRouter);
app.route("/api/team", teamRouter);

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
          const parsed = JSON.parse(raw) as { type?: string; content?: string; conversationId?: string };
          if (parsed.type !== "message" || typeof parsed.content !== "string" || !parsed.content.trim()) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid message payload" }));
            return;
          }

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
            createdAt: new Date(),
          });

          let assistantText = "";
          const role = m.role as ProjectRole;
          for await (const ev of runProjectAgent({
            cwd: repoPath,
            prompt: parsed.content,
            role,
            projectId,
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

    const respHeaders = new Headers(upstream.headers);
    respHeaders.delete("transfer-encoding");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  } catch {
    return c.html(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"></head>` +
      `<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui;color:#666">` +
      `<div style="text-align:center"><p style="font-size:14px">Starting preview server…</p>` +
      `<p style="font-size:12px;color:#999">This page will refresh automatically.</p></div></body></html>`,
      502,
    );
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
