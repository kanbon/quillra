/**
 * Passwordless email-code login for team members who don't use GitHub.
 *
 * Motivation: until now, the only way to sign into Quillra as an instance
 * admin/editor/translator was via GitHub OAuth. That meant every person
 * you invited had to (a) own a GitHub account, (b) link their email to
 * that account, and (c) trust Quillra with the `repo` scope. That's a
 * huge barrier for people like copywriters, translators, and junior
 * designers who just need to edit wording on a website.
 *
 * This route mirrors the existing /api/clients flow (6-digit code, 15 min
 * TTL, max 5 attempts, rate-limit by wiping older codes per email) but is
 * NOT project-scoped. A successful verify yields a team_session cookie
 * that the global auth middleware treats exactly like a Better Auth
 * session, the user lands on the dashboard and sees every project
 * they're a projectMembers row for.
 *
 * Security:
 *  - Only emails that have a pending instanceInvites row OR correspond
 *    to an existing member (instanceRole != null) can actually receive a
 *    code. For any other email we still return 200 ok so attackers can't
 *    enumerate valid accounts.
 *  - On successful verify we auto-create the user row (Better Auth
 *    `user` table, with emailVerified: true) if it doesn't exist and
 *    auto-accept the invite, bumping instanceRole to "member".
 *  - The GitHub owner's account is never touched by this flow. Only the
 *    first user ever (the true owner) is created via GitHub OAuth.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { instanceInvites, teamLoginCodes, teamSessions } from "../db/app-schema.js";
import { user } from "../db/auth-schema.js";
import { db } from "../db/index.js";
import { loginCodeEmailHtml } from "../services/email-templates.js";
import { getOrganizationInfo } from "../services/instance-settings.js";
import { isMailerEnabled, sendEmail } from "../services/mailer.js";

const TEAM_COOKIE = "quillra_team_session";
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
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(6, "0");
}

export const teamLoginRouter = new Hono()
  /**
   * Send a 6-digit sign-in code. Always returns 200 OK even if the email
   * is unknown, don't leak membership to attackers.
   */
  .post("/request-code", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: string } | null;
    const email = body?.email?.trim().toLowerCase();
    if (!email) return c.json({ error: "email required" }, 400);

    // Is this email eligible for a team code?
    //   1. Existing user with instanceRole ("owner" or "member"), already accepted
    //   2. Pending invite that hasn't been accepted yet
    const [existing] = await db.select().from(user).where(eq(user.email, email)).limit(1);
    const hasRole = Boolean(existing?.instanceRole);

    const [pending] = await db
      .select()
      .from(instanceInvites)
      .where(and(eq(instanceInvites.email, email), isNull(instanceInvites.acceptedAt)))
      .limit(1);

    if (!hasRole && !pending) {
      // Anti-enumeration: always return ok.
      return c.json({ ok: true });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

    // Drop any older pending codes for this email
    await db.delete(teamLoginCodes).where(eq(teamLoginCodes.email, email));

    await db.insert(teamLoginCodes).values({
      id: nanoid(),
      email,
      codeHash: hashCode(code),
      expiresAt,
      attempts: 0,
    });

    if (!isMailerEnabled()) {
      // Dev fallback: surface the code for local testing
      return c.json({ ok: true, devCode: code });
    }

    const org = getOrganizationInfo();
    const html = loginCodeEmailHtml({
      projectName: org.instanceName,
      projectLogoUrl: null,
      code,
      expiresInMinutes: CODE_TTL_MINUTES,
    });
    const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
    await sendEmail({
      to: email,
      subject: `Your ${org.instanceName} sign-in code: ${code}`,
      html,
      text: `Your sign-in code for ${org.instanceName} is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`,
      headers: {
        "List-Unsubscribe": `<${base || "https://cms.kanbon.at"}/login>, <mailto:noreply@quillra.com?subject=Unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    return c.json({ ok: true });
  })

  /**
   * Verify a 6-digit code. On success: ensure the user row exists,
   * accept any pending invite, mint a team_session cookie.
   */
  .post("/verify-code", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: string; code?: string } | null;
    const email = body?.email?.trim().toLowerCase();
    const code = body?.code?.trim();
    if (!email || !code) return c.json({ error: "email and code required" }, 400);

    const [row] = await db
      .select()
      .from(teamLoginCodes)
      .where(eq(teamLoginCodes.email, email))
      .limit(1);
    if (!row) return c.json({ error: "Invalid code" }, 400);

    if (row.expiresAt.getTime() < Date.now()) {
      await db.delete(teamLoginCodes).where(eq(teamLoginCodes.id, row.id));
      return c.json({ error: "Code expired" }, 400);
    }
    if (row.attempts >= MAX_CODE_ATTEMPTS) {
      await db.delete(teamLoginCodes).where(eq(teamLoginCodes.id, row.id));
      return c.json({ error: "Too many attempts" }, 429);
    }

    if (!constantTimeEqual(hashCode(code), row.codeHash)) {
      await db
        .update(teamLoginCodes)
        .set({ attempts: row.attempts + 1 })
        .where(eq(teamLoginCodes.id, row.id));
      return c.json({ error: "Invalid code" }, 400);
    }

    // Code is good, ensure the user row exists and the invite (if any)
    // is marked accepted. Always clean up the code.
    await db.delete(teamLoginCodes).where(eq(teamLoginCodes.id, row.id));

    let [existing] = await db.select().from(user).where(eq(user.email, email)).limit(1);

    if (!existing) {
      // Double-check there's a valid invite for this email before creating
      // a user. Anti-enumeration still protects the request-code path, but
      // a user row is a real side effect so we gate it more strictly here.
      const [pending] = await db
        .select()
        .from(instanceInvites)
        .where(and(eq(instanceInvites.email, email), isNull(instanceInvites.acceptedAt)))
        .limit(1);
      if (!pending) return c.json({ error: "No invite found for this email" }, 403);

      const now = new Date();
      const newUserId = nanoid();
      await db.insert(user).values({
        id: newUserId,
        email,
        name: email.split("@")[0] ?? email,
        emailVerified: true,
        instanceRole: "member",
        createdAt: now,
        updatedAt: now,
      });
      existing = {
        id: newUserId,
        email,
        name: email.split("@")[0] ?? email,
        emailVerified: true,
        instanceRole: "member",
        image: null,
        language: null,
        monthlyUsageReportsEnabled: false,
        createdAt: now,
        updatedAt: now,
      };
      // Mark the invite accepted
      await db
        .update(instanceInvites)
        .set({ acceptedAt: now })
        .where(eq(instanceInvites.id, pending.id));
    } else if (!existing.instanceRole) {
      // User exists but has no instanceRole yet (could happen if they
      // were pre-seeded). Check for pending invite and upgrade them.
      const [pending] = await db
        .select()
        .from(instanceInvites)
        .where(and(eq(instanceInvites.email, email), isNull(instanceInvites.acceptedAt)))
        .limit(1);
      if (!pending) return c.json({ error: "No invite found for this email" }, 403);
      await db.update(user).set({ instanceRole: "member" }).where(eq(user.id, existing.id));
      await db
        .update(instanceInvites)
        .set({ acceptedAt: new Date() })
        .where(eq(instanceInvites.id, pending.id));
    }

    // Mint the cookie session
    const token = randomBytes(32).toString("base64url");
    const sessionId = nanoid();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60_000);
    await db.insert(teamSessions).values({
      id: sessionId,
      userId: existing.id,
      token,
      expiresAt,
    });

    setCookie(c, TEAM_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      expires: expiresAt,
    });

    return c.json({ ok: true });
  })

  /** Clear the team session cookie and delete the DB row */
  .post("/logout", async (c) => {
    const token = getCookie(c, TEAM_COOKIE);
    if (token) {
      await db.delete(teamSessions).where(eq(teamSessions.token, token));
    }
    deleteCookie(c, TEAM_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

/** Helper used by the global auth middleware to resolve a team session */
export async function getTeamSessionFromCookie(token: string | undefined) {
  if (!token) return null;
  const [s] = await db.select().from(teamSessions).where(eq(teamSessions.token, token)).limit(1);
  if (!s || s.expiresAt.getTime() < Date.now()) return null;
  const [u] = await db.select().from(user).where(eq(user.id, s.userId)).limit(1);
  if (!u) return null;
  return { user: u };
}

export { TEAM_COOKIE };
