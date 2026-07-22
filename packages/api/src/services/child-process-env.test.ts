import { describe, expect, it } from "vitest";
import { createSafeChildEnv, createSafeSdkEnv } from "./child-process-env.js";

describe("createSafeChildEnv", () => {
  it("keeps process essentials and explicit workspace overrides", () => {
    const env = createSafeChildEnv(
      { NODE_ENV: "development", PORT: "4321" },
      {
        PATH: "/usr/bin",
        HOME: "/home/node",
        LANG: "en_US.UTF-8",
        PNPM_HOME: "/pnpm",
      },
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "en_US.UTF-8",
      PNPM_HOME: "/pnpm",
      NODE_ENV: "development",
      PORT: "4321",
    });
  });

  it("does not expose Quillra credentials or inherited command hooks", () => {
    const env = createSafeChildEnv(
      {},
      {
        PATH: "/usr/bin",
        BETTER_AUTH_SECRET: "auth-secret",
        QUILLRA_ENCRYPTION_KEY: "encryption-secret",
        QUILLRA_SETUP_TOKEN: "setup-secret",
        DATABASE_URL: "file:private.sqlite",
        GITHUB_CLIENT_SECRET: "github-secret",
        RESEND_API_KEY: "mail-secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
        GITHUB_TOKEN: "token",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        NODE_OPTIONS: "--require /tmp/hook.cjs",
        HTTPS_PROXY: "https://user:password@proxy.example",
      },
    );

    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("allows a credential only when the caller explicitly supplies it", () => {
    const env = createSafeChildEnv(
      { ANTHROPIC_API_KEY: "scoped-agent-key" },
      { ANTHROPIC_API_KEY: "inherited-key", HOME: "/home/node" },
    );

    expect(env).toEqual({ HOME: "/home/node", ANTHROPIC_API_KEY: "scoped-agent-key" });
  });
});

describe("createSafeSdkEnv", () => {
  it("actively clears inherited secrets before adding scoped values", () => {
    const env = createSafeSdkEnv(
      { ANTHROPIC_API_KEY: "scoped-agent-key" },
      {
        PATH: "/usr/bin",
        BETTER_AUTH_SECRET: "must-not-survive-sdk-merge",
        ANTHROPIC_API_KEY: "inherited-key",
      },
    );

    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBe("scoped-agent-key");
    expect(env).toHaveProperty("BETTER_AUTH_SECRET", undefined);
  });
});
