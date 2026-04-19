import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, isNull, sql } from "drizzle-orm";
import { instanceInvites } from "../db/app-schema.js";
import { type InstanceRole, user } from "../db/auth-schema.js";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";

function trustedOrigins(): string[] {
  const raw =
    process.env.TRUSTED_ORIGINS ??
    "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema,
    camelCase: true,
  }),
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-change-me-in-production",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  trustedOrigins: trustedOrigins(),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      scope: (process.env.GITHUB_OAUTH_SCOPES ?? "read:user,user:email,repo").split(","),
    },
  },
  databaseHooks: {
    user: {
      create: {
        async before(userData) {
          const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(user);

          if (count === 0) {
            return { data: { ...userData, instanceRole: "owner" as InstanceRole } };
          }

          const email = userData.email;
          if (email) {
            const [invite] = await db
              .select()
              .from(instanceInvites)
              .where(and(eq(instanceInvites.email, email), isNull(instanceInvites.acceptedAt)))
              .limit(1);

            if (invite) {
              await db
                .update(instanceInvites)
                .set({ acceptedAt: new Date() })
                .where(eq(instanceInvites.id, invite.id));
              return { data: { ...userData, instanceRole: "member" as InstanceRole } };
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
