import { afterEach, describe, expect, it } from "vitest";
import {
  isPreviewRoutable,
  markPreviewPortActive,
  registerPreviewPort,
  unregisterPreviewPort,
} from "./preview-status.js";
import {
  registerLoopbackPreviewUpstreamForTests,
  unregisterPreviewUpstream,
} from "./preview-upstream.js";

const PROJECT_ID = "project-preview-routable";
const PORT = 4_321;

afterEach(() => {
  unregisterPreviewPort(PROJECT_ID);
  unregisterPreviewUpstream(PROJECT_ID);
});

describe("routable preview status", () => {
  it("requires both an active reservation and a registered upstream", () => {
    expect(registerPreviewPort(PORT, PROJECT_ID)).toBe(true);
    expect(markPreviewPortActive(PROJECT_ID, PORT)).toBe(true);
    expect(isPreviewRoutable(PROJECT_ID, PORT)).toBe(false);

    registerLoopbackPreviewUpstreamForTests(PROJECT_ID, PORT, {
      origin: `http://127.0.0.1:${PORT}`,
      headers: { "e2b-traffic-access-token": "traffic-token" },
    });
    expect(isPreviewRoutable(PROJECT_ID, PORT)).toBe(true);

    unregisterPreviewUpstream(PROJECT_ID, PORT);
    expect(isPreviewRoutable(PROJECT_ID, PORT)).toBe(false);
  });
});
