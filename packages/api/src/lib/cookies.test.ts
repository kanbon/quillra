import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldUseSecureCookies } from "./cookies.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cookie transport security", () => {
  it("uses Secure for production and HTTPS self-hosting", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    expect(shouldUseSecureCookies()).toBe(true);

    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BETTER_AUTH_URL", "https://cms.example.com");
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("allows plain HTTP cookies only for non-production local development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    expect(shouldUseSecureCookies()).toBe(false);
  });
});
