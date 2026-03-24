/**
 * Used by `npx @better-auth/cli generate` only — not imported at runtime.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export const auth = betterAuth({
  database: drizzleAdapter({} as never, {
    provider: "sqlite",
    camelCase: true,
  }),
  emailAndPassword: { enabled: false },
  socialProviders: {
    github: {
      clientId: "cli",
      clientSecret: "cli",
    },
  },
});
