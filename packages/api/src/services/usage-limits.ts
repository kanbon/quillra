/**
 * Spend guardrails for Quillra. Every agent run gets a cheap "can this
 * user still chat?" check before it starts (hard cap) and a threshold
 * sweep after it finishes (warn + cap crossings).
 *
 * Limits live in three scopes, looked up in order of specificity:
 *
 *   1. "user"   target = userId
 *   2. "role"   target = project role the user has in *this* project
 *   3. "global" target = ""
 *
 * A row can set just warn_usd OR just hard_usd — the other falls
 * through to the next scope. Built-in defaults at the bottom: warn =
 * $20, hard = null (no cap).
 *
 * Owners (user.instanceRole === "owner") are exempt from hard caps.
 * They can never lock themselves out of their own instance.
 */
import { and, eq } from "drizzle-orm";
import { db, rawSqlite } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import type { ProjectRole } from "../db/app-schema.js";
import { usageAlertsSent, usageLimits } from "../db/app-schema.js";
import { getInstanceSetting } from "./instance-settings.js";

export type EffectiveLimits = {
  warnUsd: number | null;
  hardUsd: number | null;
  /** Which scope supplied the winning `warnUsd` (one source per field). */
  warnSource: "user" | "role" | "global" | "default";
  hardSource: "user" | "role" | "global" | "default";
};

const DEFAULT_WARN_USD = 20;
const DEFAULT_HARD_USD: number | null = null;

type LimitRow = { scope: string; target: string; warn_usd: number | null; hard_usd: number | null };

function readLimitRow(scope: "user" | "role" | "global", target: string): LimitRow | null {
  const row = rawSqlite
    .prepare(
      `SELECT scope, target, warn_usd, hard_usd FROM usage_limits WHERE scope = ? AND target = ?`,
    )
    .get(scope, target) as LimitRow | undefined;
  return row ?? null;
}

export function getEffectiveLimits(userId: string, roleInProject: ProjectRole): EffectiveLimits {
  const userRow = readLimitRow("user", userId);
  const roleRow = readLimitRow("role", roleInProject);
  const globalRow = readLimitRow("global", "");

  const pick = (
    field: "warn_usd" | "hard_usd",
  ): { value: number | null; source: EffectiveLimits["warnSource"] } => {
    if (userRow && userRow[field] != null) return { value: userRow[field], source: "user" };
    if (roleRow && roleRow[field] != null) return { value: roleRow[field], source: "role" };
    if (globalRow && globalRow[field] != null) return { value: globalRow[field], source: "global" };
    return {
      value: field === "warn_usd" ? DEFAULT_WARN_USD : DEFAULT_HARD_USD,
      source: "default",
    };
  };

  const warn = pick("warn_usd");
  const hard = pick("hard_usd");
  return {
    warnUsd: warn.value,
    hardUsd: hard.value,
    warnSource: warn.source,
    hardSource: hard.source,
  };
}

/** First millisecond of the current calendar month, local time. Used
 *  as the lower bound for MTD spend aggregation. */
export function firstOfCurrentMonthMs(now: Date = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return d.getTime();
}

/** "YYYY-MM" for the current month. Used as the dedupe key for
 *  usage_alerts_sent so a single crossing only emails once. */
export function currentMonthYmd(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** SUM(cost_usd) of every run this user has started since the start
 *  of the current calendar month. */
export function getMonthToDateSpend(userId: string, now: Date = new Date()): number {
  const start = firstOfCurrentMonthMs(now);
  const row = rawSqlite
    .prepare(
      `SELECT COALESCE(SUM(CAST(cost_usd AS REAL)), 0) AS total
         FROM agent_runs
         WHERE user_id = ? AND created_at >= ?`,
    )
    .get(userId, start) as { total: number } | undefined;
  return row?.total ?? 0;
}

/** True when a run MUST be rejected because the user has already spent
 *  past their hard cap this month. Owners bypass every cap. */
export async function shouldBlockRun(
  userId: string,
  roleInProject: ProjectRole,
  now: Date = new Date(),
): Promise<{ blocked: boolean; limits: EffectiveLimits; spend: number }> {
  const limits = getEffectiveLimits(userId, roleInProject);
  const spend = getMonthToDateSpend(userId, now);

  if (limits.hardUsd == null) {
    return { blocked: false, limits, spend };
  }

  // Owner exemption — never lock the operator out of their own instance.
  const [u] = await db
    .select({ instanceRole: user.instanceRole })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (u?.instanceRole === "owner") {
    return { blocked: false, limits, spend };
  }

  return { blocked: spend >= limits.hardUsd, limits, spend };
}

/**
 * Record that an alert of `kind` has been sent for (scope, target) in
 * the given month. Returns true if the row was newly inserted (caller
 * should actually send the email), false if it already existed (dedup).
 */
export async function markAlertSent(
  scope: EffectiveLimits["warnSource"],
  target: string,
  monthYmd: string,
  kind: "warn" | "hard",
): Promise<boolean> {
  if (scope === "default") return true; // never seen; treat as new
  try {
    const existing = await db
      .select()
      .from(usageAlertsSent)
      .where(
        and(
          eq(usageAlertsSent.scope, scope),
          eq(usageAlertsSent.target, target),
          eq(usageAlertsSent.monthYmd, monthYmd),
          eq(usageAlertsSent.kind, kind),
        ),
      )
      .limit(1);
    if (existing.length > 0) return false;
    await db.insert(usageAlertsSent).values({
      scope,
      target,
      monthYmd,
      kind,
      sentAt: new Date(),
    });
    return true;
  } catch {
    // Conflict — another request already marked it. Treat as already-sent
    // so the caller doesn't double-email on a race.
    return false;
  }
}

export function getAlertRecipientEmail(fallback: string | null): string | null {
  const explicit = getInstanceSetting("USAGE_ALERT_EMAIL");
  if (explicit && explicit.trim()) return explicit.trim();
  return fallback;
}

/** Look up the organization owner's email — the default recipient when
 *  USAGE_ALERT_EMAIL isn't set. */
export async function getOwnerEmail(): Promise<string | null> {
  const [owner] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.instanceRole, "owner"))
    .limit(1);
  return owner?.email ?? null;
}

export async function listUsageLimitRows(): Promise<LimitRow[]> {
  const rows = await db.select().from(usageLimits);
  return rows.map((r) => ({
    scope: r.scope,
    target: r.target,
    warn_usd: r.warnUsd,
    hard_usd: r.hardUsd,
  }));
}

export async function upsertUsageLimit(
  scope: "global" | "role" | "user",
  target: string,
  warnUsd: number | null,
  hardUsd: number | null,
): Promise<void> {
  const t = scope === "global" ? "" : target;
  // If both are null AND the row exists, delete it (nothing to inherit from
  // at this scope — clean up noise).
  if (warnUsd == null && hardUsd == null) {
    await db
      .delete(usageLimits)
      .where(and(eq(usageLimits.scope, scope), eq(usageLimits.target, t)));
    return;
  }
  // Upsert — sqlite's ON CONFLICT on the composite primary key.
  rawSqlite
    .prepare(
      `INSERT INTO usage_limits (scope, target, warn_usd, hard_usd, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, target) DO UPDATE SET
         warn_usd = excluded.warn_usd,
         hard_usd = excluded.hard_usd,
         updated_at = excluded.updated_at`,
    )
    .run(scope, t, warnUsd, hardUsd, Date.now());
}
