/**
 * Branded client login + session API.
 *
 * Clients are end-users who get a passwordless, project-scoped login via a
 * 6-digit code mailed to their address. They never see the dashboard,
 * never see other projects, and the agent enforces a content-only sandbox.
 *
 * Routes:
 *   GET  /api/clients/branding/:projectId        — public, returns name + logo
 *   POST /api/clients/request-code               — sends a 6-digit code
 *   POST /api/clients/verify-code                — exchanges code for a session cookie
 *   POST /api/clients/logout                     — clears the session cookie
 *   GET  /api/clients/me                         — returns the active client session
 */

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq, and } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import {
  projects,
  projectMembers,
  clientSessions,
  clientLoginCodes,
} from "../db/schema.js";
import { user } from "../db/auth-schema.js";
import { sendEmail, isMailerEnabled } from "../services/mailer.js";
import { loginCodeEmailHtml } from "../services/email-templates.js";

const CLIENT_COOKIE = "quillra_client_session";
const CODE_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30;
const MAX_CODE_ATTEMPTS = 5;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function generateCode(): string {
  // 6-digit numeric code, zero-padded
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(6, "0");
}

export const clientsRouter = new Hono()
  /** Public — used by the branded login page to render the project's logo + name */
  .get("/branding/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const [p] = await db
      .select({ id: projects.id, name: projects.name, logoUrl: projects.logoUrl })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    return c.json(p);
  })

  /** Send a 6-digit login code to a client's email for the given project */
  .post("/request-code", async (c) => {
    const body = await c.req.json().catch(() => null) as { projectId?: string; email?: string } | null;
    const projectId = body?.projectId?.trim();
    const email = body?.email?.trim().toLowerCase();
    if (!projectId || !email) return c.json({ error: "projectId and email required" }, 400);

    const [p] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!p) return c.json({ error: "Project not found" }, 404);

    // Check that this email belongs to a known client member of the project.
    // We look it up via the user table → projectMembers join.
    const [u] = await db.select().from(user).where(eq(user.email, email)).limit(1);
    let clientUserId: string | null = u?.id ?? null;
    if (clientUserId) {
      const [m] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, clientUserId)))
        .limit(1);
      if (!m || m.role !== "client") clientUserId = null;
    }

    // Don't reveal whether the email is a member — always return ok.
    // Only actually send the code if the email is a client member.
    if (!clientUserId) {
      return c.json({ ok: true });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

    // Wipe any older pending codes for this email/project
    await db
      .delete(clientLoginCodes)
      .where(and(eq(clientLoginCodes.projectId, projectId), eq(clientLoginCodes.email, email)));

    await db.insert(clientLoginCodes).values({
      id: nanoid(),
      projectId,
      email,
      codeHash: hashCode(code),
      expiresAt,
      attempts: 0,
    });

    if (!isMailerEnabled()) {
      // Dev fallback: surface the code in the response so the host can copy it
      return c.json({ ok: true, devCode: code });
    }

    const html = loginCodeEmailHtml({
      projectName: p.name,
      projectLogoUrl: p.logoUrl,
      code,
      expiresInMinutes: CODE_TTL_MINUTES,
    });
    // Gmail / Yahoo spam heuristics require List-Unsubscribe on bulk
    // sends. A login code isn't bulk but the filters are the same.
    const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
    await sendEmail({
      to: email,
      subject: `Your ${p.name} sign-in code: ${code}`,
      html,
      text: `Your sign-in code for ${p.name} is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`,
      headers: {
        "List-Unsubscribe": `<${base || "https://cms.kanbon.at"}/c/${projectId}>, <mailto:noreply@quillra.com?subject=Unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    return c.json({ ok: true });
  })

  /** Exchange a 6-digit code for a client session cookie */
  .post("/verify-code", async (c) => {
    const body = await c.req.json().catch(() => null) as
      | { projectId?: string; email?: string; code?: string }
      | null;
    const projectId = body?.projectId?.trim();
    const email = body?.email?.trim().toLowerCase();
    const code = body?.code?.trim();
    if (!projectId || !email || !code) return c.json({ error: "projectId, email, code required" }, 400);

    const [row] = await db
      .select()
      .from(clientLoginCodes)
      .where(and(eq(clientLoginCodes.projectId, projectId), eq(clientLoginCodes.email, email)))
      .limit(1);
    if (!row) return c.json({ error: "Invalid code" }, 400);

    if (row.expiresAt.getTime() < Date.now()) {
      await db.delete(clientLoginCodes).where(eq(clientLoginCodes.id, row.id));
      return c.json({ error: "Code expired" }, 400);
    }
    if (row.attempts >= MAX_CODE_ATTEMPTS) {
      await db.delete(clientLoginCodes).where(eq(clientLoginCodes.id, row.id));
      return c.json({ error: "Too many attempts" }, 429);
    }

    if (!constantTimeEqual(hashCode(code), row.codeHash)) {
      await db
        .update(clientLoginCodes)
        .set({ attempts: row.attempts + 1 })
        .where(eq(clientLoginCodes.id, row.id));
      return c.json({ error: "Invalid code" }, 400);
    }

    // Code is good — find the user + verify they're still a client of this project
    const [u] = await db.select().from(user).where(eq(user.email, email)).limit(1);
    if (!u) return c.json({ error: "Invalid code" }, 400);
    const [m] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, u.id)))
      .limit(1);
    if (!m || m.role !== "client") return c.json({ error: "Not a client of this project" }, 403);

    // Burn the code, mint a session
    await db.delete(clientLoginCodes).where(eq(clientLoginCodes.id, row.id));
    const token = randomBytes(32).toString("base64url");
    const sessionId = nanoid();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60_000);
    await db.insert(clientSessions).values({
      id: sessionId,
      userId: u.id,
      projectId,
      token,
      expiresAt,
    });

    setCookie(c, CLIENT_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      expires: expiresAt,
    });

    return c.json({ ok: true, projectId });
  })

  /** Returns the active client session, or 401 */
  .get("/me", async (c) => {
    const token = getCookie(c, CLIENT_COOKIE);
    if (!token) return c.json({ user: null }, 401);
    const [s] = await db.select().from(clientSessions).where(eq(clientSessions.token, token)).limit(1);
    if (!s || s.expiresAt.getTime() < Date.now()) return c.json({ user: null }, 401);
    const [u] = await db.select().from(user).where(eq(user.id, s.userId)).limit(1);
    if (!u) return c.json({ user: null }, 401);
    return c.json({
      user: { id: u.id, email: u.email, name: u.name, image: u.image },
      projectId: s.projectId,
    });
  })

  .post("/logout", async (c) => {
    const token = getCookie(c, CLIENT_COOKIE);
    if (token) {
      await db.delete(clientSessions).where(eq(clientSessions.token, token));
    }
    deleteCookie(c, CLIENT_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

/** Helper used by the global auth middleware to resolve a client session from a request */
export async function getClientSessionFromCookie(token: string | undefined) {
  if (!token) return null;
  const [s] = await db.select().from(clientSessions).where(eq(clientSessions.token, token)).limit(1);
  if (!s || s.expiresAt.getTime() < Date.now()) return null;
  const [u] = await db.select().from(user).where(eq(user.id, s.userId)).limit(1);
  if (!u) return null;
  return { user: u, projectId: s.projectId };
}

export { CLIENT_COOKIE };
