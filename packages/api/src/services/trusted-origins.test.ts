import { describe, expect, it } from "vitest";
import { getTrustedOrigins, isTrustedBrowserRequest } from "./trusted-origins.js";

describe("trusted browser origins", () => {
  it("includes the split local editor and API origins by default", () => {
    expect(getTrustedOrigins({ BETTER_AUTH_URL: "http://localhost:3000" })).toEqual([
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
  });

  it("accepts configured browser origins and rejects preview or malformed origins", () => {
    const environment = {
      BETTER_AUTH_URL: "https://cms.example.com",
      TRUSTED_ORIGINS: "https://edit.example.com",
    };
    expect(
      isTrustedBrowserRequest(
        new Headers({ origin: "https://edit.example.com/path" }),
        environment,
      ),
    ).toBe(true);
    expect(
      isTrustedBrowserRequest(
        new Headers({ origin: "https://p-123.preview.example.com" }),
        environment,
      ),
    ).toBe(false);
    expect(isTrustedBrowserRequest(new Headers({ origin: "not a URL" }), environment)).toBe(false);
  });

  it("allows server clients without Origin but rejects explicit cross-site browser requests", () => {
    expect(isTrustedBrowserRequest(new Headers(), {})).toBe(true);
    expect(isTrustedBrowserRequest(new Headers({ "sec-fetch-site": "cross-site" }), {})).toBe(
      false,
    );
  });
});
