import { afterEach, describe, expect, it } from "vitest";
import {
  E2B_TRAFFIC_ACCESS_HEADER,
  getPreviewUpstream,
  previewUpstreamUrl,
  registerLoopbackPreviewUpstreamForTests,
  registerPreviewUpstream,
  unregisterPreviewUpstream,
} from "./preview-upstream.js";

const projectId = "project-preview-upstream";

afterEach(() => unregisterPreviewUpstream(projectId));

describe("preview upstream registry", () => {
  it("keeps the E2B origin and traffic token server-side", () => {
    registerPreviewUpstream(projectId, 4321, {
      origin: "https://4321-sandbox.e2b.app/",
      headers: { [E2B_TRAFFIC_ACCESS_HEADER]: "traffic-secret" },
    });

    expect(getPreviewUpstream(projectId, 4321)).toEqual({
      origin: "https://4321-sandbox.e2b.app",
      headers: { [E2B_TRAFFIC_ACCESS_HEADER]: "traffic-secret" },
    });
    expect(previewUpstreamUrl(projectId, 4321, "/nested/page", "?a=1", true)?.url.toString()).toBe(
      "wss://4321-sandbox.e2b.app/nested/page?a=1",
    );
  });

  it("rejects insecure origins and client-controlled headers", () => {
    expect(() =>
      registerPreviewUpstream(projectId, 4321, {
        origin: "http://127.0.0.1:4321",
        headers: { [E2B_TRAFFIC_ACCESS_HEADER]: "traffic-secret" },
      }),
    ).toThrow("HTTPS");
    expect(() =>
      registerPreviewUpstream(projectId, 4321, {
        origin: "https://4321-sandbox.e2b.app",
        headers: {
          [E2B_TRAFFIC_ACCESS_HEADER]: "traffic-secret",
          authorization: "Bearer should-not-pass",
        },
      }),
    ).toThrow("exactly one");
  });

  it("keeps the explicit loopback helper limited to test fixtures", () => {
    registerLoopbackPreviewUpstreamForTests(projectId, 4321, {
      origin: "http://127.0.0.1:4321",
      headers: { [E2B_TRAFFIC_ACCESS_HEADER]: "fixture-token" },
    });
    expect(getPreviewUpstream(projectId, 4321)?.origin).toBe("http://127.0.0.1:4321");
  });

  it("does not return a stale registration for a reused port", () => {
    registerPreviewUpstream(projectId, 4321, {
      origin: "https://4321-sandbox.e2b.app",
      headers: { [E2B_TRAFFIC_ACCESS_HEADER]: "traffic-secret" },
    });
    unregisterPreviewUpstream(projectId, 9999);
    expect(getPreviewUpstream(projectId, 4321)).not.toBeNull();
    unregisterPreviewUpstream(projectId, 4321);
    expect(getPreviewUpstream(projectId, 4321)).toBeNull();
  });
});
