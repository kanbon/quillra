/**
 * Durable monthly-report scheduler. Fires daily and, on each tick, looks
 * for users who (a) opted into monthly reports and (b) have not yet
 * received their previous-month summary. Catches up on missed runs after
 * downtime because delivery state lives in a DB table, not in memory.
 *
 * We tick daily at 03:37 local time rather than monthly at midnight on
 * the 1st. Daily catch-up means even a server restart on the morning of
 * the 2nd still sends March's report; monthly-exact cron would miss it.
 */

import { and, eq } from "drizzle-orm";
import cron, { type ScheduledTask } from "node-cron";
import { usageReportsSent } from "../db/app-schema.js";
import { user } from "../db/auth-schema.js";
import { db, rawSqlite } from "../db/index.js";
import { renderBrandedEmail } from "./email-template.js";
import { getInstanceSetting } from "./instance-settings.js";
import { isMailerEnabled, sendEmail } from "./mailer.js";

/** "YYYY-MM" for the calendar month that just ended. Run on March 1 →
 *  returns "2026-02". */
function previousMonthYmd(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function ymdToRange(ymd: string): { fromMs: number; untilMs: number; monthLabel: string } {
  const [y, m] = ymd.split("-").map((n) => Number.parseInt(n, 10));
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0, 0); // first instant of next month
  const label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return { fromMs: start.getTime(), untilMs: end.getTime(), monthLabel: label };
}

type ReportRow = {
  projectName: string;
  runs: number;
  costUsd: number;
};

function buildReportRows(userId: string, fromMs: number, untilMs: number): ReportRow[] {
  return rawSqlite
    .prepare(
      `SELECT
         COALESCE(p.name, '(deleted project)') AS project_name,
         COUNT(*) AS runs,
         COALESCE(SUM(CAST(ar.cost_usd AS REAL)), 0) AS cost_usd
       FROM agent_runs ar
       LEFT JOIN projects p ON p.id = ar.project_id
       WHERE ar.user_id = ? AND ar.created_at >= ? AND ar.created_at < ?
       GROUP BY ar.project_id
       ORDER BY cost_usd DESC`,
    )
    .all(userId, fromMs, untilMs)
    .map((r) => {
      const row = r as { project_name: string; runs: number; cost_usd: number };
      return { projectName: row.project_name, runs: row.runs, costUsd: row.cost_usd };
    });
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

/**
 * Generate + send one user's monthly report. Returns a boolean indicating
 * whether a send was attempted; writes the `usage_reports_sent` row only
 * after a successful send so a failed delivery will retry on the next
 * tick.
 */
async function sendOneUserReport(
  userId: string,
  userEmail: string,
  userName: string,
  ymd: string,
): Promise<boolean> {
  const { fromMs, untilMs, monthLabel } = ymdToRange(ymd);
  const rows = buildReportRows(userId, fromMs, untilMs);
  if (rows.length === 0) {
    // Nothing happened for this user last month. Still mark as "sent"
    // so we don't re-check forever; no email goes out.
    try {
      await db.insert(usageReportsSent).values({ userId, monthYmd: ymd, sentAt: new Date() });
    } catch {
      /* already marked, harmless */
    }
    return false;
  }
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalRuns = rows.reduce((s, r) => s + r.runs, 0);
  const org = getInstanceSetting("INSTANCE_NAME") || "Quillra";

  const { html, text } = renderBrandedEmail({
    title: `Your ${monthLabel} usage report`,
    preheader: `${totalRuns} tasks across ${rows.length} site${rows.length === 1 ? "" : "s"} · ${formatUsd(totalCost)}`,
    body: {
      greeting: `Hi${userName ? ` ${userName.split(" ")[0]}` : ""},`,
      paragraphs: [
        `Here's a summary of the Quillra activity on your account for ${monthLabel}.`,
        `You ran ${totalRuns} task${totalRuns === 1 ? "" : "s"} across ${rows.length} site${rows.length === 1 ? "" : "s"}, for a total of ${formatUsd(totalCost)}.`,
        `This is an automated monthly summary. If anything looks off, reply to this email and we'll take a look.`,
      ],
      table: {
        headers: ["Site", "Tasks", "Cost"],
        rows: rows.map((r) => [r.projectName, String(r.runs), formatUsd(r.costUsd)]),
        totalRow: ["Total", String(totalRuns), formatUsd(totalCost)],
      },
      signature: `- ${org}`,
    },
  });

  const result = await sendEmail({
    to: userEmail,
    subject: `Your ${monthLabel} usage report`,
    html,
    text,
  });
  if (!result.sent) {
    console.warn("[reports] failed to deliver monthly report to", userEmail, result.reason);
    return false;
  }
  try {
    await db.insert(usageReportsSent).values({ userId, monthYmd: ymd, sentAt: new Date() });
  } catch {
    /* already logged on a parallel tick */
  }
  return true;
}

export async function reconcileMonthlyReports(): Promise<{
  targetMonth: string;
  candidates: number;
  sent: number;
  skipped: number;
  mailerDisabled: boolean;
}> {
  const targetMonth = previousMonthYmd();
  if (!isMailerEnabled()) {
    console.warn("[reports] mailer disabled, skipping reconcile for", targetMonth);
    return { targetMonth, candidates: 0, sent: 0, skipped: 0, mailerDisabled: true };
  }

  // Pull every opted-in user, then drop the ones we've already emailed
  // for `targetMonth`. A LEFT JOIN in raw SQL would be marginally faster
  // but this set is tiny and the two-pass read is easier to read.
  const optedIn = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(eq(user.monthlyUsageReportsEnabled, true));

  const alreadySent = new Set(
    (
      rawSqlite
        .prepare("SELECT user_id FROM usage_reports_sent WHERE month_ymd = ?")
        .all(targetMonth) as { user_id: string }[]
    ).map((r) => r.user_id),
  );

  let sent = 0;
  let skipped = 0;
  for (const u of optedIn) {
    if (alreadySent.has(u.id)) {
      skipped++;
      continue;
    }
    const did = await sendOneUserReport(u.id, u.email, u.name, targetMonth);
    if (did) sent++;
    else skipped++;
  }

  return {
    targetMonth,
    candidates: optedIn.length,
    sent,
    skipped,
    mailerDisabled: false,
  };
}

let task: ScheduledTask | null = null;

/**
 * Start the scheduler. Safe to call once at boot, idempotent (a second
 * call is a no-op). Immediately runs a catch-up reconcile so any report
 * missed while the server was down goes out within a few seconds of the
 * server coming back.
 */
export function startReportScheduler(): void {
  if (task) return;
  // Off-peak, off-minute, avoid the 0/15/30/45 clustering that makes
  // every app's cron fire simultaneously.
  task = cron.schedule("37 3 * * *", () => {
    void reconcileMonthlyReports().catch((e) =>
      console.warn("[reports] scheduled reconcile failed:", e),
    );
  });
  // Boot-time catch-up. Fire-and-forget so it never blocks request
  // serving, any mailer failure is logged.
  void reconcileMonthlyReports().catch((e) => console.warn("[reports] boot reconcile failed:", e));
}

// Reference the eq helper so a no-call import doesn't get tree-shaken.
void and;
