/**
 * Runtime-mutable instance settings stored in SQLite, with env var fallback.
 *
 * The setup wizard and any "change this without a restart" admin page both
 * go through this module. Every reader calls `getInstanceSetting(key,
 * envKey)` which prefers the DB value if present, else the env var, else
 * undefined. Writers bypass the .env file entirely — no file I/O, no
 * container restart, no fragile sed.
 *
 * SECRET HANDLING: settings are stored plain in SQLite. The SQLite file
 * lives inside the container volume, not in git, never leaves the server.
 * Secret rotation is as simple as overwriting the value.
 */
import { rawSqlite } from "../db/index.js";

type Row = { value: string | null };

/** Keys the wizard is allowed to set. Anything else is rejected. */
export const SETTABLE_KEYS = [
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "RESEND_API_KEY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_SECURE",
  // Instance identity / Impressum — publicly visible (email footer, /impressum)
  "INSTANCE_NAME",
  "INSTANCE_OPERATOR_NAME",
  "INSTANCE_OPERATOR_COMPANY",
  "INSTANCE_OPERATOR_EMAIL",
  "INSTANCE_OPERATOR_ADDRESS",
  "INSTANCE_OPERATOR_WEBSITE",
] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

/** Keys considered secret — masked when returned to the admin UI. */
const SECRET_KEYS = new Set<SettableKey>([
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
  "SMTP_PASSWORD",
]);

/**
 * Get a setting with DB → env → default precedence. Most callers only
 * need to pass the key; we look up the same env var name by convention.
 */
export function getInstanceSetting(key: string, envKey?: string, fallback?: string): string | undefined {
  try {
    const row = rawSqlite.prepare(`SELECT value FROM instance_settings WHERE key = ?`).get(key) as Row | undefined;
    const v = row?.value?.trim();
    if (v) return v;
  } catch {
    /* table may not exist yet on first boot — env var takes over */
  }
  const envValue = process.env[envKey ?? key]?.trim();
  if (envValue) return envValue;
  return fallback;
}

export function setInstanceSetting(key: SettableKey, value: string | null): void {
  if (value === null || value === "") {
    rawSqlite.prepare(`DELETE FROM instance_settings WHERE key = ?`).run(key);
    return;
  }
  rawSqlite
    .prepare(
      `INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now());
}

/**
 * Public operator / Impressum info — set via the wizard, rendered in email
 * footers, the branded client login page, and the /impressum route. Never
 * secret.
 */
export type OrganizationInfo = {
  instanceName: string;
  operatorName: string | null;
  company: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
};

export function getOrganizationInfo(): OrganizationInfo {
  return {
    instanceName: getInstanceSetting("INSTANCE_NAME") || "Quillra",
    operatorName: getInstanceSetting("INSTANCE_OPERATOR_NAME") ?? null,
    company: getInstanceSetting("INSTANCE_OPERATOR_COMPANY") ?? null,
    email: getInstanceSetting("INSTANCE_OPERATOR_EMAIL") ?? null,
    address: getInstanceSetting("INSTANCE_OPERATOR_ADDRESS") ?? null,
    website: getInstanceSetting("INSTANCE_OPERATOR_WEBSITE") ?? null,
  };
}

/**
 * Returns a status-shape describing what's configured, what's missing, and
 * which values are set (without leaking secrets). Used by the setup wizard
 * to decide whether to show its welcome screen.
 */
export function getSetupStatus(): {
  needsSetup: boolean;
  missing: string[];
  /** True when no user rows exist yet — the wizard must drive the
   *  owner through the mandatory GitHub OAuth step. */
  needsOwner: boolean;
  values: Record<string, { set: boolean; source: "db" | "env" | "none"; value?: string }>;
} {
  const out: Record<string, { set: boolean; source: "db" | "env" | "none"; value?: string }> = {};
  for (const key of SETTABLE_KEYS) {
    let dbVal: string | undefined;
    try {
      const row = rawSqlite.prepare(`SELECT value FROM instance_settings WHERE key = ?`).get(key) as Row | undefined;
      dbVal = row?.value?.trim() || undefined;
    } catch { /* ignore */ }
    const envVal = process.env[key]?.trim();
    const source: "db" | "env" | "none" = dbVal ? "db" : envVal ? "env" : "none";
    const set = Boolean(dbVal || envVal);
    const rawValue = dbVal ?? envVal;
    let value: string | undefined;
    if (rawValue !== undefined) {
      if (SECRET_KEYS.has(key)) {
        // Mask: show only last 4 chars
        value = rawValue.length > 6 ? `${"•".repeat(8)}${rawValue.slice(-4)}` : "••••";
      } else {
        value = rawValue;
      }
    }
    out[key] = { set, source, value };
  }
  // Setup is "needed" if the core runtime values are missing
  const missing: string[] = [];
  if (!out.ANTHROPIC_API_KEY.set) missing.push("ANTHROPIC_API_KEY");

  // Bootstrap check: is there at least one user row? If not, the setup
  // wizard must also walk the new owner through the GitHub OAuth step.
  let needsOwner = false;
  try {
    const row = rawSqlite.prepare(`SELECT count(*) as c FROM user`).get() as { c: number } | undefined;
    needsOwner = !row || row.c === 0;
  } catch {
    // user table may not exist yet on the very first boot — treat as needing an owner
    needsOwner = true;
  }
  if (needsOwner) missing.push("__owner");

  return { needsSetup: missing.length > 0, missing, needsOwner, values: out };
}
