import { type SQLWrapper, sql } from "drizzle-orm";

/** Canonical form used for all newly persisted and compared email addresses. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Match legacy mixed-case rows while new writes converge on lowercase. */
export function emailEquals(column: SQLWrapper, email: string) {
  return sql`lower(${column}) = ${normalizeEmail(email)}`;
}
