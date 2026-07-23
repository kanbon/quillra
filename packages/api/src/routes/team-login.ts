/**
 * Passwordless email-code login for the instance owner and team members.
 *
 * Motivation: until now, the only way to sign into Quillra as an instance
 * admin/editor was via GitHub OAuth. That meant every person
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
 *  - While no owner exists, requesting or displaying a code requires the
 *    server-access proof established by the setup gate.
 *  - After bootstrap, only emails with a pending instance/project invite or
 *    an existing instance role can actually receive a code. For any other
 *    email we still return 200 ok so attackers can't enumerate valid accounts.
 *  - On successful verify we auto-create the user row (Better Auth
 *    `user` table, with emailVerified: true) if it doesn't exist and
 *    atomically accept valid invites, grant project memberships, and bump
 *    instanceRole to "member".
 *  - Concurrent bootstrap attempts cannot create multiple owners: the owner
 *    write succeeds only while no owner exists.
 */

import { randomBytes } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { clientSessions, teamLoginCodes, teamSessions } from "../db/app-schema.js";
import { user } from "../db/auth-schema.js";
import { db, rawSqlite } from "../db/index.js";
import { invalidateBetterAuthSession } from "../lib/better-auth-session.js";
import { shouldUseSecureCookies } from "../lib/cookies.js";
import { emailEquals, normalizeEmail } from "../lib/email.js";
import { consumeSubjectAndIpRateLimit, getRequestIp } from "../lib/fixed-window-rate-limit.js";
import { findValidPendingInstanceInvite } from "../lib/instance-invites.js";
import { generateOtpCode, hashOtpCode, otpCodeMatches } from "../lib/otp.js";
import {
  acceptTeamLoginInvites,
  hasValidPendingTeamProjectInvite,
} from "../lib/project-invites.js";
import {
  SERVER_ACCESS_COOKIE,
  logServerAccessInstructions,
  verifyServerAccessSession,
  verifyServerAccessToken,
} from "../lib/server-access.js";
import { CLIENT_SESSION_COOKIE, TEAM_SESSION_COOKIE } from "../lib/session-cookies.js";
import { getInstanceBrand } from "../services/branding.js";
import { renderLoginCodeEmail } from "../services/email-templates.js";
import { getOrganizationInfo } from "../services/instance-settings.js";
import { isMailerEnabled, sendEmail } from "../services/mailer.js";

const CODE_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30;
const MAX_CODE_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60_000;

function instanceNeedsOwner(): boolean {
  return (
    rawSqlite.prepare("SELECT 1 FROM user WHERE instance_role = 'owner' LIMIT 1").get() ===
    undefined
  );
}

/**
 * Claim the first owner in one SQLite statement. The NOT EXISTS predicate is
 * evaluated in the same write statement as the insert, so two simultaneous
 * OTP verifications cannot both observe an empty table and create owners.
 */
function claimFirstOwner(email: string): string | null {
  const ownerName = getOrganizationInfo().operatorName?.trim() || email.split("@")[0] || email;
  const now = Date.now();
  const candidate = rawSqlite
    .prepare("SELECT id FROM user WHERE lower(email) = ? LIMIT 1")
    .get(email) as { id: string } | undefined;
  if (candidate) {
    const promoted = rawSqlite
      .prepare(
        `UPDATE user
         SET name = ?, instance_role = 'owner', updatedAt = ?
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM user WHERE instance_role = 'owner')`,
      )
      .run(ownerName, now, candidate.id);
    if (promoted.changes === 1) return candidate.id;
  }

  const id = nanoid();
  const result = rawSqlite
    .prepare(
      `INSERT INTO user (
         id, name, email, emailVerified, image, instance_role, language,
         monthly_usage_reports_enabled, createdAt, updatedAt
       )
       SELECT ?, ?, ?, 1, NULL, 'owner', NULL, 0, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM user WHERE instance_role = 'owner')
         AND NOT EXISTS (SELECT 1 FROM user WHERE lower(email) = ?)`,
    )
    .run(id, ownerName, email, now, now, email);
  return result.changes === 1 ? id : null;
}

export const teamLoginRouter = new Hono()
  /**
   * Send a 6-digit sign-in code. Always returns 200 OK even if the email
   * is unknown, don't leak membership to attackers.
   */
  .post("/request-code", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      email?: string;
      accessToken?: string;
    } | null;
    const email = body?.email ? normalizeEmail(body.email) : "";
    if (!email) return c.json({ error: "email required" }, 400);

    const rateLimit = consumeSubjectAndIpRateLimit({
      namespace: "team-login:request",
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

    // Is this email eligible for a team code?
    //   1. The instance has no owner, this verification will bootstrap one
    //   2. Existing user with instanceRole ("owner" or "member"), already accepted
    //   3. Pending instance or team-project invite that hasn't been accepted yet
    const existingUsers = await db.select().from(user).where(emailEquals(user.email, email));
    const existing = existingUsers.find((candidate) => candidate.instanceRole) ?? existingUsers[0];
    const hasRole = Boolean(existing?.instanceRole);

    const pendingInstanceInvite = await findValidPendingInstanceInvite(email);
    const hasProjectInvite = hasValidPendingTeamProjectInvite(email);

    const needsOwner = instanceNeedsOwner();
    const eligible = needsOwner || hasRole || Boolean(pendingInstanceInvite) || hasProjectInvite;
    const deliveryAvailable = isMailerEnabled();
    const hasServerAccess =
      verifyServerAccessSession(getCookie(c, SERVER_ACCESS_COOKIE)) ||
      verifyServerAccessToken(body?.accessToken);

    // Email ownership is not proof that the requester controls this server.
    // Without this gate, an Internet visitor could race the operator on a
    // fresh SMTP-enabled install and claim the sole owner account.
    if (needsOwner && !hasServerAccess) {
      logServerAccessInstructions();
      return deliveryAvailable
        ? c.json({ error: "Server access token required for first-owner signup." }, 401)
        : c.json({ ok: true, recoveryRequired: true });
    }

    if (!eligible) {
      // Anti-enumeration: always return ok.
      if (deliveryAvailable) return c.json({ ok: true });
      if (hasServerAccess) {
        return c.json({ error: "No owner, member, or pending invite uses that email." }, 403);
      }
      return c.json({ ok: true, recoveryRequired: true });
    }

    if (!deliveryAvailable && !hasServerAccess) {
      logServerAccessInstructions();
      return c.json({ ok: true, recoveryRequired: true });
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

    const codeId = nanoid();
    const codeHash = hashOtpCode(code);
    const createdAt = new Date();
    await db
      .insert(teamLoginCodes)
      .values({
        id: codeId,
        email,
        codeHash,
        expiresAt,
        attempts: 0,
        createdAt,
      })
      .onConflictDoUpdate({
        target: teamLoginCodes.email,
        set: { id: codeId, codeHash, expiresAt, attempts: 0, createdAt },
      });

    if (!deliveryAvailable) {
      // A server operator can still bootstrap or recover a no-email install,
      // but the live code is never disclosed to an anonymous web request.
      return c.json({ ok: true, devCode: code });
    }

    const org = getOrganizationInfo();
    const brand = getInstanceBrand(new URL(c.req.url).host || null);
    const emailBody = renderLoginCodeEmail({
      brand,
      code,
      expiresInMinutes: CODE_TTL_MINUTES,
    });
    const delivery = await sendEmail({
      to: email,
      subject: `Your ${org.instanceName} sign-in code: ${code}`,
      html: emailBody.html,
      text: emailBody.text,
    });
    if (!delivery.sent) {
      // Do not leave an undeliverable code live. In particular, the first
      // owner must get a clear failure instead of being stranded on a code
      // screen for an email that never arrived.
      await db
        .delete(teamLoginCodes)
        .where(and(eq(teamLoginCodes.id, codeId), eq(teamLoginCodes.codeHash, codeHash)));
      return c.json(
        { error: "Could not send the sign-in code. Check the email settings and try again." },
        502,
      );
    }
    return c.json({ ok: true });
  })

  /**
   * Verify a 6-digit code. On success: ensure the user row exists,
   * accept any pending invite, mint a team_session cookie.
   */
  .post("/verify-code", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      email?: string;
      code?: string;
      accessToken?: string;
    } | null;
    const email = body?.email ? normalizeEmail(body.email) : "";
    const code = body?.code?.trim();
    if (!email || !code) return c.json({ error: "email and code required" }, 400);

    const rateLimit = consumeSubjectAndIpRateLimit({
      namespace: "team-login:verify",
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

    if (
      instanceNeedsOwner() &&
      !verifyServerAccessSession(getCookie(c, SERVER_ACCESS_COOKIE)) &&
      !verifyServerAccessToken(body?.accessToken)
    ) {
      logServerAccessInstructions();
      return c.json({ error: "Server access token required for first-owner signup." }, 401);
    }

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

    if (!otpCodeMatches(code, row.codeHash)) {
      await db
        .update(teamLoginCodes)
        .set({ attempts: sql`${teamLoginCodes.attempts} + 1` })
        .where(and(eq(teamLoginCodes.id, row.id), lt(teamLoginCodes.attempts, MAX_CODE_ATTEMPTS)));
      return c.json({ error: "Invalid code" }, 400);
    }

    // Burn the code exactly once before creating a user or session. A second
    // request racing with this one sees zero affected rows and cannot redeem
    // the same code into another session.
    const consumed = rawSqlite
      .prepare("DELETE FROM team_login_codes WHERE id = ? AND code_hash = ?")
      .run(row.id, row.codeHash);
    if (consumed.changes !== 1) return c.json({ error: "Invalid code" }, 400);

    if (instanceNeedsOwner()) {
      // Fresh-install bootstrap. Promote the matching logical user even when
      // a legacy database already labelled it "member"; exactly one
      // concurrent claimant can win the atomic owner predicate.
      const ownerId = claimFirstOwner(email);
      if (!ownerId) {
        return c.json(
          { error: "The owner account was already created. Ask the owner for an invite." },
          409,
        );
      }
    }

    // Re-check authorization after consuming the OTP. Revoked or expired
    // invites cannot be redeemed with a code issued while they were valid.
    // User promotion, memberships, and invite consumption happen together.
    const acceptedUserId = acceptTeamLoginInvites(email);
    if (!acceptedUserId) {
      return c.json(
        { error: "The invite is no longer active. Ask an owner for a new invite." },
        409,
      );
    }

    await invalidateBetterAuthSession(c);

    // Mint the cookie session
    const token = randomBytes(32).toString("base64url");
    const sessionId = nanoid();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60_000);
    await db.insert(teamSessions).values({
      id: sessionId,
      userId: acceptedUserId,
      token,
      expiresAt,
    });

    const clientToken = getCookie(c, CLIENT_SESSION_COOKIE);
    if (clientToken) {
      await db.delete(clientSessions).where(eq(clientSessions.token, clientToken));
    }
    deleteCookie(c, CLIENT_SESSION_COOKIE, {
      path: "/",
      secure: shouldUseSecureCookies(),
    });

    setCookie(c, TEAM_SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: shouldUseSecureCookies(),
      sameSite: "Lax",
      expires: expiresAt,
    });
    // First-run server proof is intentionally short-lived and single-purpose.
    // Once an authenticated owner/member session exists, do not let the setup
    // cookie silently turn a later no-email login back into an on-screen code.
    deleteCookie(c, SERVER_ACCESS_COOKIE, {
      path: "/",
      secure: shouldUseSecureCookies(),
    });

    return c.json({ ok: true });
  })

  /** Clear the team session cookie and delete the DB row */
  .post("/logout", async (c) => {
    const teamToken = getCookie(c, TEAM_SESSION_COOKIE);
    const clientToken = getCookie(c, CLIENT_SESSION_COOKIE);
    if (teamToken) {
      await db.delete(teamSessions).where(eq(teamSessions.token, teamToken));
    }
    if (clientToken) {
      await db.delete(clientSessions).where(eq(clientSessions.token, clientToken));
    }
    await invalidateBetterAuthSession(c);
    deleteCookie(c, TEAM_SESSION_COOKIE, {
      path: "/",
      secure: shouldUseSecureCookies(),
    });
    deleteCookie(c, CLIENT_SESSION_COOKIE, {
      path: "/",
      secure: shouldUseSecureCookies(),
    });
    return c.json({ ok: true });
  });

/** Helper used by the global auth middleware to resolve a team session */
export async function getTeamSessionFromCookie(token: string | undefined) {
  if (!token) return null;
  const [s] = await db.select().from(teamSessions).where(eq(teamSessions.token, token)).limit(1);
  if (!s) return null;
  if (s.expiresAt.getTime() < Date.now()) {
    await db.delete(teamSessions).where(eq(teamSessions.id, s.id));
    return null;
  }
  const [u] = await db.select().from(user).where(eq(user.id, s.userId)).limit(1);
  if (!u?.instanceRole) {
    await db.delete(teamSessions).where(eq(teamSessions.id, s.id));
    return null;
  }
  return { user: u };
}

export { TEAM_SESSION_COOKIE as TEAM_COOKIE };
