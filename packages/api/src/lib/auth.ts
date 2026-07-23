import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq, sql } from "drizzle-orm";
import { instanceInvites } from "../db/app-schema.js";
import { type InstanceRole, user } from "../db/auth-schema.js";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { shouldUseSecureCookies } from "./cookies.js";
import { emailEquals, normalizeEmail } from "./email.js";
import { findValidPendingInstanceInvite } from "./instance-invites.js";

function trustedOrigins(): string[] {
  const raw =
    process.env.TRUSTED_ORIGINS ??
    "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// `BETTER_AUTH_SECRET` is guaranteed to be populated by the time this
// module loads: lib/boot-secrets.ts runs in index.ts before auth is imported
// and either passes through the env value or
// generates a persisted dev secret on disk. Refusing to fall back to a
// well-known placeholder is intentional, "everyone in the world has
// the same signing key" is a worse default than a loud failure.
const betterAuthSecret = process.env.BETTER_AUTH_SECRET?.trim();
if (!betterAuthSecret) {
  throw new Error(
    "BETTER_AUTH_SECRET is empty after boot-secrets ran. Set it in the environment, or check the [boot-secrets] log line on startup for the file path that should hold the persisted dev secret.",
  );
}
const secureAuthCookies = shouldUseSecureCookies();

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema,
    camelCase: true,
  }),
  secret: betterAuthSecret,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  trustedOrigins: trustedOrigins(),
  advanced: {
    // Better Auth normally prepends `__Secure-`, which still permits a sibling
    // preview subdomain to cookie-toss a Domain cookie with the same name.
    // Disabling that automatic prefix and supplying our own production
    // `__Host-` prefix protects every Better Auth cookie: browsers require
    // Secure, Path=/, and no Domain for these names.
    useSecureCookies: false,
    cookiePrefix: secureAuthCookies ? "__Host-quillra" : "better-auth",
    defaultCookieAttributes: {
      secure: secureAuthCookies,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    },
  },
  account: {
    // Better Auth's own social-login tokens are not used for repository
    // access, but they are still credentials and must not sit in SQLite as
    // plaintext.
    encryptOAuthTokens: true,
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      // OAuth identifies the operator. Repository access is handled only by
      // the narrowly-scoped GitHub App installation token.
      scope: (process.env.GITHUB_OAUTH_SCOPES ?? "read:user,user:email").split(","),
    },
  },
  databaseHooks: {
    user: {
      create: {
        async before(userData) {
          const [{ ownerCount }] = await db
            .select({ ownerCount: sql<number>`count(*)` })
            .from(user)
            .where(eq(user.instanceRole, "owner"));

          // The first owner is created only through the server-access-protected
          // setup flow. A direct OAuth request must never be able to claim a
          // fresh public instance before its operator reaches the wizard.
          if (ownerCount === 0) return false;

          const email = userData.email ? normalizeEmail(userData.email) : "";
          if (email) {
            // Older installs may contain mixed-case addresses. Better Auth's
            // exact comparison must not create a second logical account.
            const [existingUser] = await db
              .select({ email: user.email })
              .from(user)
              .where(emailEquals(user.email, email))
              .limit(1);
            if (existingUser) return false;

            const invite = await findValidPendingInstanceInvite(email);

            if (invite) {
              await db
                .update(instanceInvites)
                .set({ acceptedAt: new Date() })
                .where(eq(instanceInvites.id, invite.id));
              return {
                data: { ...userData, email, instanceRole: "member" as InstanceRole },
              };
            }
          }

          return false;
        },
      },
    },
  },
});

export type SessionUser = typeof auth.$Infer.Session.user;
export type Session = typeof auth.$Infer.Session.session;
