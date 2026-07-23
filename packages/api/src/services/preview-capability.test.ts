import { afterEach, describe, expect, it } from "vitest";
import {
  PREVIEW_CAPABILITY_TTL_MS,
  issuePreviewCapability,
  resolveActivePreviewCapability,
  resolveActivePreviewCapabilityToken,
  resolvePreviewCapability,
  resolveReservedPreviewCapability,
  resolveReservedPreviewCapabilityToken,
  resolveReservedPreviewHost,
  revokePreviewCapability,
} from "./preview-capability.js";
import { getPreviewOriginConfig, previewHostnameForProject } from "./preview-origin.js";
import {
  markPreviewPortActive,
  registerPreviewPort,
  unregisterPreviewPort,
} from "./preview-status.js";

const touchedProjects = [
  "project-cap-binding",
  "project-cap-expiry",
  "project-cap-rotation",
  "project-cap-active",
];

afterEach(() => {
  for (const projectId of touchedProjects) {
    revokePreviewCapability(projectId);
    unregisterPreviewPort(projectId);
  }
});

describe("preview capabilities", () => {
  it("binds an opaque capability to one project and port", () => {
    const now = 1_000;
    const issued = issuePreviewCapability("project-cap-binding", 4_321, now);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(resolvePreviewCapability("4321", issued.token, now)).toEqual({
      ok: true,
      projectId: "project-cap-binding",
      port: 4_321,
      expiresAt: now + PREVIEW_CAPABILITY_TTL_MS,
    });
    expect(resolvePreviewCapability("4322", issued.token, now)).toEqual({ ok: false });
  });

  it("expires and revokes capabilities", () => {
    const issued = issuePreviewCapability("project-cap-expiry", 4_321, 2_000);

    expect(
      resolvePreviewCapability("4321", issued.token, 2_000 + PREVIEW_CAPABILITY_TTL_MS),
    ).toEqual({ ok: false });

    const replacement = issuePreviewCapability("project-cap-expiry", 4_321, 3_000);
    revokePreviewCapability("project-cap-expiry");
    expect(resolvePreviewCapability("4321", replacement.token, 3_000)).toEqual({ ok: false });
  });

  it("reuses a live project capability and rotates it when the port changes", () => {
    const first = issuePreviewCapability("project-cap-rotation", 4_321, 4_000);
    const reused = issuePreviewCapability("project-cap-rotation", 4_321, 5_000);
    const rotated = issuePreviewCapability("project-cap-rotation", 4_322, 6_000);

    expect(reused.token).toBe(first.token);
    expect(rotated.token).not.toBe(first.token);
    expect(resolvePreviewCapability("4321", first.token, 6_000)).toEqual({ ok: false });
    expect(resolvePreviewCapability("4322", rotated.token, 6_000).ok).toBe(true);
  });

  it("rejects a capability after its project releases the port", () => {
    registerPreviewPort(4_321, "project-cap-active");
    const issued = issuePreviewCapability("project-cap-active", 4_321, 7_000);

    expect(resolveReservedPreviewCapability("4321", issued.token, 7_000).ok).toBe(true);
    expect(resolveReservedPreviewCapabilityToken(issued.token, 7_000).ok).toBe(true);
    expect(resolveActivePreviewCapability("4321", issued.token, 7_000)).toEqual({ ok: false });
    expect(resolveActivePreviewCapabilityToken(issued.token, 7_000)).toEqual({ ok: false });
    expect(markPreviewPortActive("project-cap-active", 4_321)).toBe(true);
    expect(resolveActivePreviewCapability("4321", issued.token, 7_000).ok).toBe(true);
    expect(resolveActivePreviewCapabilityToken(issued.token, 7_000).ok).toBe(true);
    unregisterPreviewPort("project-cap-active");
    expect(resolveActivePreviewCapability("4321", issued.token, 7_000)).toEqual({ ok: false });
  });

  it("allows TLS only for a currently reserved opaque project host", () => {
    const projectId = "project-cap-binding";
    const environment = {
      BETTER_AUTH_URL: "https://cms.example.com",
      BETTER_AUTH_SECRET: "capability-host-test-secret",
      PREVIEW_DOMAIN: "preview.example.net",
    };
    const config = getPreviewOriginConfig(environment);
    expect(config).not.toBeNull();
    if (!config) return;

    registerPreviewPort(4_321, projectId);
    issuePreviewCapability(projectId, 4_321, 8_000);
    const hostname = previewHostnameForProject(projectId, config, environment);

    expect(resolveReservedPreviewHost(hostname, config, 8_000, environment).ok).toBe(true);
    expect(
      resolveReservedPreviewHost(`other.${config.hostname}`, config, 8_000, environment),
    ).toEqual({ ok: false });
    unregisterPreviewPort(projectId);
    expect(resolveReservedPreviewHost(hostname, config, 8_000, environment)).toEqual({
      ok: false,
    });
  });
});
