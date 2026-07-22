import { nanoid } from "nanoid";
import type { ProjectRole } from "../db/app-schema.js";
import { rawSqlite } from "../db/index.js";
import { normalizeEmail } from "./email.js";

type InviteAudience = "team" | "client";

type PendingProjectInvite = {
  id: string;
  projectId: string;
  name: string | null;
  role: ProjectRole;
  invitedByUserId: string;
  expiresAt: number;
};

type LoginUser = {
  id: string;
  instanceRole: "owner" | "member" | null;
};

function rolePredicate(audience: InviteAudience): string {
  return audience === "client" ? "role = 'client'" : "role IN ('admin', 'editor')";
}

function findLoginUser(email: string): LoginUser | undefined {
  return rawSqlite
    .prepare(
      `SELECT id, instance_role AS instanceRole
       FROM user
       WHERE lower(email) = ?
       ORDER BY CASE WHEN instance_role IS NULL THEN 1 ELSE 0 END, createdAt, id
       LIMIT 1`,
    )
    .get(normalizeEmail(email)) as LoginUser | undefined;
}

function findPendingInvites(
  email: string,
  audience: InviteAudience,
  now: number,
  projectId?: string,
): PendingProjectInvite[] {
  const projectFilter = projectId ? "AND project_id = ?" : "";
  const parameters = projectId
    ? [normalizeEmail(email), now, projectId]
    : [normalizeEmail(email), now];

  return rawSqlite
    .prepare(
      `SELECT id, project_id AS projectId, name, role, invited_by_user_id AS invitedByUserId,
              expires_at AS expiresAt
       FROM project_invites
       WHERE lower(email) = ?
         AND accepted_at IS NULL
         AND expires_at > ?
         AND ${rolePredicate(audience)}
         ${projectFilter}
       ORDER BY project_id, expires_at DESC, rowid DESC`,
    )
    .all(...parameters) as PendingProjectInvite[];
}

function ensureUser(
  email: string,
  audience: InviteAudience,
  now: number,
  invitedName?: string | null,
): LoginUser {
  const existing = findLoginUser(email);
  if (existing) {
    rawSqlite
      .prepare(
        `UPDATE user
         SET emailVerified = 1,
             instance_role = CASE
               WHEN ? = 'team' THEN COALESCE(instance_role, 'member')
               ELSE instance_role
             END,
             updatedAt = ?
         WHERE id = ?`,
      )
      .run(audience, now, existing.id);
    return audience === "team" && !existing.instanceRole
      ? { ...existing, instanceRole: "member" }
      : existing;
  }

  const normalizedEmail = normalizeEmail(email);
  const id = nanoid();
  rawSqlite
    .prepare(
      `INSERT INTO user
         (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      invitedName?.trim() || normalizedEmail.split("@")[0] || normalizedEmail,
      normalizedEmail,
      audience === "team" ? "member" : null,
      now,
      now,
    );
  return { id, instanceRole: audience === "team" ? "member" : null };
}

function existingMembershipRole(projectId: string, userId: string): ProjectRole | null {
  const row = rawSqlite
    .prepare(
      `SELECT role
       FROM project_members
       WHERE project_id = ? AND user_id = ?
       ORDER BY created_at, id
       LIMIT 1`,
    )
    .get(projectId, userId) as { role: ProjectRole } | undefined;
  return row?.role ?? null;
}

function grantInvites(userId: string, invites: PendingProjectInvite[], now: number): void {
  const selectedByProject = new Map<string, PendingProjectInvite>();
  for (const invite of invites) {
    if (!selectedByProject.has(invite.projectId)) selectedByProject.set(invite.projectId, invite);
  }

  for (const invite of selectedByProject.values()) {
    const existingRole = existingMembershipRole(invite.projectId, userId);
    if (!existingRole) {
      rawSqlite
        .prepare(
          `INSERT INTO project_members
             (id, project_id, user_id, role, invited_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(nanoid(), invite.projectId, userId, invite.role, invite.invitedByUserId, now);
    }

    // The most recently expiring duplicate determines the role. An
    // established membership is deliberately never rewritten here.
  }

  const acceptInvite = rawSqlite.prepare(
    `UPDATE project_invites
     SET accepted_at = ?
     WHERE id = ? AND accepted_at IS NULL AND expires_at > ?`,
  );
  for (const invite of invites) acceptInvite.run(now, invite.id, now);
}

export function hasValidPendingTeamProjectInvite(email: string): boolean {
  return findPendingInvites(email, "team", Date.now()).length > 0;
}

export function hasValidPendingClientProjectInvite(email: string, projectId: string): boolean {
  return findPendingInvites(email, "client", Date.now(), projectId).length > 0;
}

export function findExistingClientMember(email: string, projectId: string): string | null {
  const row = rawSqlite
    .prepare(
      `SELECT user.id
       FROM user
       INNER JOIN project_members ON project_members.user_id = user.id
       WHERE lower(user.email) = ?
         AND project_members.project_id = ?
         AND project_members.role = 'client'
       ORDER BY project_members.created_at, project_members.id
       LIMIT 1`,
    )
    .get(normalizeEmail(email), projectId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Accept all currently valid team invitations for an OTP-verified address.
 * User promotion, project memberships, and invite consumption share one
 * immediate SQLite transaction, so none can become visible on its own.
 */
export function acceptTeamLoginInvites(email: string): string | null {
  return rawSqlite
    .transaction(() => {
      const now = Date.now();
      const existing = findLoginUser(email);
      const projectInvites = findPendingInvites(email, "team", now);
      const instanceInvites = rawSqlite
        .prepare(
          `SELECT id
         FROM instance_invites
         WHERE lower(email) = ? AND accepted_at IS NULL AND expires_at > ?`,
        )
        .all(normalizeEmail(email), now) as { id: string }[];

      if (!existing?.instanceRole && projectInvites.length === 0 && instanceInvites.length === 0) {
        return null;
      }

      const acceptedUser = ensureUser(email, "team", now, projectInvites[0]?.name);
      grantInvites(acceptedUser.id, projectInvites, now);
      if (instanceInvites.length > 0) {
        rawSqlite
          .prepare(
            `UPDATE instance_invites
           SET accepted_at = ?
           WHERE lower(email) = ? AND accepted_at IS NULL AND expires_at > ?`,
          )
          .run(now, normalizeEmail(email), now);
      }
      return acceptedUser.id;
    })
    .immediate();
}

/** Accept a client invitation only after its project-scoped OTP was verified. */
export function acceptClientLoginInvite(email: string, projectId: string): string | null {
  return rawSqlite
    .transaction(() => {
      const currentMember = findExistingClientMember(email, projectId);
      if (currentMember) return currentMember;

      const now = Date.now();
      const invites = findPendingInvites(email, "client", now, projectId);
      if (invites.length === 0) return null;

      const acceptedUser = ensureUser(email, "client", now, invites[0]?.name);
      const existingRole = existingMembershipRole(projectId, acceptedUser.id);
      if (existingRole && existingRole !== "client") return null;

      grantInvites(acceptedUser.id, invites, now);
      return acceptedUser.id;
    })
    .immediate();
}

/** Atomic legacy token acceptance for an already authenticated user. */
export function acceptProjectInviteToken(
  tokenHash: string,
  email: string,
  userId: string,
): { projectId: string } | null {
  return rawSqlite
    .transaction(() => {
      const now = Date.now();
      const invite = rawSqlite
        .prepare(
          `SELECT id, project_id AS projectId, name, role, invited_by_user_id AS invitedByUserId,
                expires_at AS expiresAt
         FROM project_invites
         WHERE token_hash = ?
           AND lower(email) = ?
           AND accepted_at IS NULL
           AND expires_at > ?
         LIMIT 1`,
        )
        .get(tokenHash, normalizeEmail(email), now) as PendingProjectInvite | undefined;
      if (!invite) return null;

      if (invite.role !== "client") {
        rawSqlite
          .prepare(
            `UPDATE user
           SET instance_role = COALESCE(instance_role, 'member'), updatedAt = ?
           WHERE id = ?`,
          )
          .run(now, userId);
      }
      grantInvites(userId, [invite], now);
      return { projectId: invite.projectId };
    })
    .immediate();
}
