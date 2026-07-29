import { afterEach, describe, expect, it, vi } from "vitest";
import { E2B_RELAY_STATUS_HEADER, E2B_RELAY_UPSTREAM_UNAVAILABLE } from "./e2b-preview-relay.js";
import {
  isPreviewRoutable,
  markPreviewPortActive,
  readPreviewStatus,
  registerPreviewPort,
  setPreviewStatus,
  unregisterPreviewPort,
} from "./preview-status.js";
import {
  registerLoopbackPreviewUpstreamForTests,
  unregisterPreviewUpstream,
} from "./preview-upstream.js";

const PROJECT_ID = "project-preview-routable";
const PORT = 4_321;

afterEach(() => {
  vi.restoreAllMocks();
  setPreviewStatus(PROJECT_ID, "idle", undefined, "warm");
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

  it("returns a tracked ready route without probing E2B again", async () => {
    expect(registerPreviewPort(PORT, PROJECT_ID)).toBe(true);
    registerLoopbackPreviewUpstreamForTests(PROJECT_ID, PORT, {
      origin: `http://127.0.0.1:${PORT}`,
      headers: { "e2b-traffic-access-token": "traffic-token" },
    });
    expect(markPreviewPortActive(PROJECT_ID, PORT)).toBe(true);
    setPreviewStatus(PROJECT_ID, "ready");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(readPreviewStatus(PROJECT_ID, PORT)).resolves.toEqual({
      stage: "ready",
      mode: "warm",
      label: "Ready",
      detail: "Loading your site…",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps waiting when the trusted relay says its target is not ready", async () => {
    expect(registerPreviewPort(PORT, PROJECT_ID)).toBe(true);
    registerLoopbackPreviewUpstreamForTests(PROJECT_ID, PORT, {
      origin: `http://127.0.0.1:${PORT}`,
      headers: { "e2b-traffic-access-token": "traffic-token" },
    });
    expect(markPreviewPortActive(PROJECT_ID, PORT)).toBe(true);
    setPreviewStatus(PROJECT_ID, "starting", "Waiting for Vite");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Preview upstream unavailable", {
        status: 502,
        headers: {
          [E2B_RELAY_STATUS_HEADER]: E2B_RELAY_UPSTREAM_UNAVAILABLE,
        },
      }),
    );

    await expect(readPreviewStatus(PROJECT_ID, PORT)).resolves.toEqual({
      stage: "starting",
      mode: "warm",
      label: "Starting the preview",
      detail: "Waiting for Vite",
    });
  });

  it("keeps the cold-start mode for the rest of the same launch", async () => {
    setPreviewStatus(PROJECT_ID, "starting", "Preparing the sandbox", "warm");
    setPreviewStatus(PROJECT_ID, "installing", "Installing packages", "cold");
    setPreviewStatus(PROJECT_ID, "starting", "Launching Vite");

    await expect(readPreviewStatus(PROJECT_ID, PORT)).resolves.toMatchObject({
      stage: "starting",
      mode: "cold",
      detail: "Launching Vite",
    });
  });
});
