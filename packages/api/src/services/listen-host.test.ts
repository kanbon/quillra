import { describe, expect, it } from "vitest";
import { resolveListenHost } from "./listen-host.js";

describe("resolveListenHost", () => {
  it.each(["127.0.0.1", "0.0.0.0", "::1", "::", "localhost"])("accepts bind address %s", (host) => {
    expect(resolveListenHost(host)).toBe(host);
  });

  it("defaults to all IPv4 interfaces", () => {
    expect(resolveListenHost(undefined)).toBe("0.0.0.0");
    expect(resolveListenHost("  ")).toBe("0.0.0.0");
  });

  it.each(["https://127.0.0.1", "127.0.0.1:3000", "host/name", "example.com"])(
    "rejects invalid bind host %s",
    (host) => {
      expect(() => resolveListenHost(host)).toThrow(
        "HOST must be localhost or a valid IPv4/IPv6 address",
      );
    },
  );
});
