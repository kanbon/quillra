import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
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
      scope: (process.env.GITHUB_OAUTH_SCOPES ?? "read:user,user:email").split(","),
    },
  },
});

export type SessionUser = typeof auth.$Infer.Session.user;
export type Session = typeof auth.$Infer.Session.session;
