/**
 * Branded client login + session API.
 *
 * Clients are end-users who get a passwordless, project-scoped login via a
 * 6-digit code mailed to their address. They never see the dashboard,
 * never see other projects, and the agent enforces a content-only sandbox.
 *
 * Routes:
 *   GET  /api/clients/branding/:projectId, public, returns name + logo
 *   POST /api/clients/request-code, sends a 6-digit code
 *   POST /api/clients/verify-code, exchanges code for a session cookie
 *   POST /api/clients/logout, clears the session cookie
 *   GET  /api/clients/me, returns the active client session
 */

import { randomBytes } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { user } from "../db/auth-schema.js";
import { db, rawSqlite } from "../db/index.js";
import {
  clientLoginCodes,
  clientSessions,
  projectMembers,
  projects,
  teamSessions,
} from "../db/schema.js";
import { invalidateBetterAuthSession } from "../lib/better-auth-session.js";
import { shouldUseSecureCookies } from "../lib/cookies.js";
import { normalizeEmail } from "../lib/email.js";
import { consumeSubjectAndIpRateLimit, getRequestIp } from "../lib/fixed-window-rate-limit.js";
import { generateOtpCode, hashOtpCode, otpCodeMatches } from "../lib/otp.js";
import {
  acceptClientLoginInvite,
  findExistingClientMember,
  hasValidPendingClientProjectInvite,
} from "../lib/project-invites.js";
import { CLIENT_SESSION_COOKIE, TEAM_SESSION_COOKIE } from "../lib/session-cookies.js";
import { getProjectBrand } from "../services/branding.js";
import { loginCodeEmailHtml } from "../services/email-templates.js";
import { isMailerEnabled, sendEmail } from "../services/mailer.js";

const CODE_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30;
const MAX_CODE_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60_000;

export const clientsRouter = new Hono()
  /**
   * Public, used by the branded login page to render the project's
   * effective brand (project > group > instance > Quillra default). The
   * shape stays backward-compatible with the old `{id, name, logoUrl}`
   * payload, plus three new fields the white-label flow needs.
   */
  .get("/branding/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const [p] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!p) return c.json({ error: "Not found" }, 404);
    const referer = new URL(c.req.url).host || null;
    const brand = await getProjectBrand(projectId, referer);
    return c.json({
      id: p.id,
      name: brand.displayName,
      logoUrl: brand.logoUrl,
      accentColor: brand.accentColor,
      tagline: brand.tagline,
      poweredBy: brand.poweredBy,
    });
  })

  /** Send a 6-digit login code to a client's email for the given project */
  .post("/request-code", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      projectId?: string;
      email?: string;
    } | null;
    const projectId = body?.projectId?.trim();
    const email = body?.email ? normalizeEmail(body.email) : "";
    if (!projectId || !email) return c.json({ error: "projectId and email required" }, 400);

    const rateLimit = consumeSubjectAndIpRateLimit({
      namespace: "client-login:request",
      subject: email,
      ip: getRequestIp(c),
      subjectLimit: 5,
      ipLimit: 30,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      c.header("Retry-After", String(rateLimit.retryAfterSeconds));
      return c.json({ error: "Too many sign-in code requests. Try again later." }, 429);
    }

    const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) return c.json({ error: "Project not found" }, 404);

    // Client access has no server-token recovery path. Refuse before looking
    // up membership so a disabled mailer cannot leak whether an address is a
    // client, and never persist or return a code that was not delivered.
    if (!isMailerEnabled()) {
      return c.json(
        { error: "Email sign-in is unavailable because email delivery is not configured." },
        503,
      );
    }

    const clientUserId = findExistingClientMember(email, projectId);
    const hasPendingInvite = hasValidPendingClientProjectInvite(email, projectId);

    // Don't reveal whether the email is a member or invited. A pending invite
    // becomes a membership only after this delivered code is verified.
    if (!clientUserId && !hasPendingInvite) {
      return c.json({ ok: true });
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

    const codeId = nanoid();
    const codeHash = hashOtpCode(code);
    const createdAt = new Date();
    await db
      .insert(clientLoginCodes)
      .values({
        id: codeId,
        projectId,
        email,
        codeHash,
        expiresAt,
        attempts: 0,
        createdAt,
      })
      .onConflictDoUpdate({
        target: [clientLoginCodes.projectId, clientLoginCodes.email],
        set: { id: codeId, codeHash, expiresAt, attempts: 0, createdAt },
      });

    const html = loginCodeEmailHtml({
      projectName: p.name,
      projectLogoUrl: p.logoUrl,
      code,
      expiresInMinutes: CODE_TTL_MINUTES,
    });
    const delivery = await sendEmail({
      to: email,
      subject: `Your ${p.name} sign-in code: ${code}`,
      html,
      text: `Your sign-in code for ${p.name} is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`,
    });
    if (!delivery.sent) {
      await db
        .delete(clientLoginCodes)
        .where(and(eq(clientLoginCodes.id, codeId), eq(clientLoginCodes.codeHash, codeHash)));
      return c.json(
        { error: "Could not send the sign-in code. Check the email settings and try again." },
        502,
      );
    }
    return c.json({ ok: true });
  })

  /** Exchange a 6-digit code for a client session cookie */
  .post("/verify-code", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      projectId?: string;
      email?: string;
      code?: string;
    } | null;
    const projectId = body?.projectId?.trim();
    const email = body?.email ? normalizeEmail(body.email) : "";
    const code = body?.code?.trim();
    if (!projectId || !email || !code)
      return c.json({ error: "projectId, email, code required" }, 400);

    const rateLimit = consumeSubjectAndIpRateLimit({
      namespace: "client-login:verify",
      subject: email,
      ip: getRequestIp(c),
      subjectLimit: 10,
      ipLimit: 50,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      c.header("Retry-After", String(rateLimit.retryAfterSeconds));
      return c.json({ error: "Too many verification attempts. Try again later." }, 429);
    }

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

    if (!otpCodeMatches(code, row.codeHash)) {
      await db
        .update(clientLoginCodes)
        .set({ attempts: sql`${clientLoginCodes.attempts} + 1` })
        .where(
          and(eq(clientLoginCodes.id, row.id), lt(clientLoginCodes.attempts, MAX_CODE_ATTEMPTS)),
        );
      return c.json({ error: "Invalid code" }, 400);
    }

    // Burn the code exactly once so concurrent requests cannot mint multiple
    // sessions from a single email code.
    const consumed = rawSqlite
      .prepare("DELETE FROM client_login_codes WHERE id = ? AND code_hash = ?")
      .run(row.id, row.codeHash);
    if (consumed.changes !== 1) return c.json({ error: "Invalid code" }, 400);

    // Re-check access after consuming the OTP. A code issued before an invite
    // was revoked or expired cannot create a user, membership, or session.
    const clientUserId = acceptClientLoginInvite(email, projectId);
    if (!clientUserId) return c.json({ error: "No active client invite or membership" }, 403);

    await invalidateBetterAuthSession(c);

    const token = randomBytes(32).toString("base64url");
    const sessionId = nanoid();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60_000);
    await db.insert(clientSessions).values({
      id: sessionId,
      userId: clientUserId,
      projectId,
      token,
      expiresAt,
    });

    const teamToken = getCookie(c, TEAM_SESSION_COOKIE);
    if (teamToken) {
      await db.delete(teamSessions).where(eq(teamSessions.token, teamToken));
    }
    deleteCookie(c, TEAM_SESSION_COOKIE, { path: "/" });

    setCookie(c, CLIENT_SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: shouldUseSecureCookies(),
      sameSite: "Lax",
      expires: expiresAt,
    });

    return c.json({ ok: true, projectId });
  })

  /** Returns the active client session, or 401 */
  .get("/me", async (c) => {
    const token = getCookie(c, CLIENT_SESSION_COOKIE);
    // This is a public session probe used by the branded login page. A
    // missing session is an expected state, not a failed page resource.
    if (!token) return c.json({ user: null });
    const session = await getClientSessionFromCookie(token);
    if (!session) return c.json({ user: null });
    return c.json({
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image,
      },
      projectId: session.projectId,
    });
  })

  .post("/logout", async (c) => {
    const clientToken = getCookie(c, CLIENT_SESSION_COOKIE);
    const teamToken = getCookie(c, TEAM_SESSION_COOKIE);
    if (clientToken) {
      await db.delete(clientSessions).where(eq(clientSessions.token, clientToken));
    }
    if (teamToken) {
      await db.delete(teamSessions).where(eq(teamSessions.token, teamToken));
    }
    await invalidateBetterAuthSession(c);
    deleteCookie(c, CLIENT_SESSION_COOKIE, { path: "/" });
    deleteCookie(c, TEAM_SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

/** Helper used by the global auth middleware to resolve a client session from a request */
export async function getClientSessionFromCookie(token: string | undefined) {
  if (!token) return null;
  const [s] = await db
    .select()
    .from(clientSessions)
    .where(eq(clientSessions.token, token))
    .limit(1);
  if (!s) return null;
  if (s.expiresAt.getTime() < Date.now()) {
    await db.delete(clientSessions).where(eq(clientSessions.id, s.id));
    return null;
  }
  const [u] = await db.select().from(user).where(eq(user.id, s.userId)).limit(1);
  if (!u) {
    await db.delete(clientSessions).where(eq(clientSessions.id, s.id));
    return null;
  }
  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, s.projectId), eq(projectMembers.userId, s.userId)))
    .limit(1);
  if (membership?.role !== "client") {
    await db.delete(clientSessions).where(eq(clientSessions.id, s.id));
    return null;
  }
  return { user: u, projectId: s.projectId };
}

export { CLIENT_SESSION_COOKIE as CLIENT_COOKIE };
