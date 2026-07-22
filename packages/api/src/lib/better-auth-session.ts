import type { Context } from "hono";
import { auth } from "./auth.js";

/**
 * A custom team/client sign-in replaces, rather than layers on top of, a
 * Better Auth identity. Let Better Auth revoke its signed database token and
 * expire every related cache cookie, then forward those cookies to Hono's
 * eventual response.
 */
export async function invalidateBetterAuthSession(c: Context): Promise<void> {
  const response = await auth.api.signOut({
    headers: c.req.raw.headers,
    asResponse: true,
  });
  for (const cookie of response.headers.getSetCookie()) {
    c.header("Set-Cookie", cookie, { append: true });
  }
}
