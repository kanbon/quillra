/**
 * Runtime-mutable instance settings stored in SQLite, with env var fallback
 * and AES-256-GCM encryption at rest for values flagged as secrets.
 *
 * Precedence for reads: DB (decrypted on the fly) → env var → default.
 * Writes go straight to the DB, encrypted if the key is a secret. Env
 * vars always win when set, that gives operators a choice between
 * "manage everything in the browser UI" and "manage everything via env
 * vars at container start time".
 *
 * Boot migration: the first start after this module is imported walks
 * every secret row and re-encrypts any legacy plaintext value in place.
 * Idempotent, O(number of secret keys).
 */
import { rawSqlite } from "../db/index.js";
import { decryptSecret, encryptSecret, isEncryptedV1 } from "./crypto.js";

type Row = { value: string | null };

/** Keys the wizard is allowed to set. Anything else is rejected. */
export const SETTABLE_KEYS = [
  "ANTHROPIC_API_KEY",
  // GitHub OAuth app, only for owner wizard sign-in, never for git
  // operations. `GITHUB_CLIENT_SECRET` is a secret.
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  // GitHub App, the only supported credential for repo push operations.
  // No personal access tokens, no human credentials.
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_NAME",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  // Email provider
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "RESEND_API_KEY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_SECURE",
  // Instance identity / Impressum, publicly visible (email footer, /impressum)
  "INSTANCE_NAME",
  "INSTANCE_OPERATOR_NAME",
  "INSTANCE_OPERATOR_COMPANY",
  "INSTANCE_OPERATOR_EMAIL",
  "INSTANCE_OPERATOR_ADDRESS",
  "INSTANCE_OPERATOR_WEBSITE",
  // Instance-level brand defaults. Layered under group and project
  // overrides; see services/branding.ts. INSTANCE_POWERED_BY = "off"
  // hides the small Quillra footer on white-labeled surfaces (managed
  // SaaS only; self-hosters keep it on by license).
  "INSTANCE_LOGO_URL",
  "INSTANCE_ACCENT_COLOR",
  "INSTANCE_POWERED_BY",
  // Where usage warnings + cap-hit notifications are emailed. Empty =
  // fall back to the organization owner's email at read time.
  "USAGE_ALERT_EMAIL",
] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

/** Keys considered secret, encrypted at rest, masked when returned to
 *  the admin UI. */
export const SECRET_KEYS = new Set<SettableKey>([
  "ANTHROPIC_API_KEY",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "SMTP_PASSWORD",
]);

/**
 * One-shot re-encryption pass at module init. Finds any row whose key is
 * a secret and whose value isn't already in the v1 envelope, and encrypts
 * it in place. Safe to run on every boot, it's a no-op after the first
 * successful pass.
 *
 * Wrapped in a try so a fresh install with no instance_settings table
 * yet doesn't crash boot.
 */
(function migrateLegacyPlaintextSecrets() {
  try {
    const rows = rawSqlite
      .prepare("SELECT key, value FROM instance_settings WHERE value IS NOT NULL")
      .all() as { key: string; value: string }[];
    for (const row of rows) {
      if (!SECRET_KEYS.has(row.key as SettableKey)) continue;
      if (!row.value || isEncryptedV1(row.value)) continue;
      try {
        const enc = encryptSecret(row.value);
        rawSqlite
          .prepare("UPDATE instance_settings SET value = ?, updated_at = ? WHERE key = ?")
          .run(enc, Date.now(), row.key);
      } catch (e) {
        console.warn(`[instance-settings] failed to encrypt ${row.key}:`, e);
      }
    }
  } catch {
    // Fresh install, instance_settings table doesn't exist yet. Nothing to migrate.
  }
})();

/**
 * Read the raw DB value for a key and, if it's a secret, decrypt it.
 * Non-secret values pass through unchanged. Legacy plaintext values for
 * secret keys (should be rare after the boot migration, but can happen
 * if the migration failed) are returned as-is so reads don't hard-fail.
 */
function readDbValue(key: string): string | undefined {
  let dbVal: string | undefined;
  try {
    const row = rawSqlite.prepare("SELECT value FROM instance_settings WHERE key = ?").get(key) as
      | Row
      | undefined;
    dbVal = row?.value ?? undefined;
  } catch {
    return undefined;
  }
  if (!dbVal) return undefined;
  if (SECRET_KEYS.has(key as SettableKey) && isEncryptedV1(dbVal)) {
    try {
      return decryptSecret(dbVal);
    } catch (e) {
      console.error(`[instance-settings] failed to decrypt ${key}:`, e);
      return undefined;
    }
  }
  return dbVal;
}

/**
 * Get a setting with DB → env → default precedence. Most callers only
 * need to pass the key; we look up the same env var name by convention.
 */
export function getInstanceSetting(
  key: string,
  envKey?: string,
  fallback?: string,
): string | undefined {
  const v = readDbValue(key)?.trim();
  if (v) return v;
  const envValue = process.env[envKey ?? key]?.trim();
  if (envValue) return envValue;
  return fallback;
}

export function setInstanceSetting(key: SettableKey, value: string | null): void {
  if (value === null || value === "") {
    rawSqlite.prepare("DELETE FROM instance_settings WHERE key = ?").run(key);
    return;
  }
  const stored = SECRET_KEYS.has(key) ? encryptSecret(value) : value;
  rawSqlite
    .prepare(
      `INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, stored, Date.now());
}

/**
 * Public operator / Impressum info, set via the wizard, rendered in email
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
 * to decide whether to show its welcome screen and by the /admin tabs to
 * render their "set" / "from env" / "from db" badges.
 */
export function getSetupStatus(): {
  needsSetup: boolean;
  missing: string[];
  /** True when no user rows exist yet, the wizard must drive the
   *  owner through the mandatory GitHub OAuth step. */
  needsOwner: boolean;
  values: Record<string, { set: boolean; source: "db" | "env" | "none"; value?: string }>;
} {
  const out: Record<string, { set: boolean; source: "db" | "env" | "none"; value?: string }> = {};
  for (const key of SETTABLE_KEYS) {
    const dbVal = readDbValue(key)?.trim() || undefined;
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
  // Core runtime values that gate the wizard
  const missing: string[] = [];
  if (!out.ANTHROPIC_API_KEY.set) missing.push("ANTHROPIC_API_KEY");
  // GitHub App is mandatory, no PAT fallback.
  if (!out.GITHUB_APP_ID.set || !out.GITHUB_APP_PRIVATE_KEY.set) {
    missing.push("GITHUB_APP");
  }

  // Bootstrap check: is there at least one user row? If not, the setup
  // wizard must also walk the new owner through the GitHub OAuth step.
  let needsOwner = false;
  try {
    const row = rawSqlite.prepare("SELECT count(*) as c FROM user").get() as
      | { c: number }
      | undefined;
    needsOwner = !row || row.c === 0;
  } catch {
    needsOwner = true;
  }
  if (needsOwner) missing.push("__owner");

  return { needsSetup: missing.length > 0, missing, needsOwner, values: out };
}
