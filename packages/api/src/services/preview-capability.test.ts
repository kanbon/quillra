import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PREVIEW_SESSIONS_PER_PROJECT,
  PREVIEW_CAPABILITY_TTL_MS,
  PREVIEW_HANDOFF_TTL_MS,
  consumeReservedPreviewHandoff,
  issuePreviewCapability,
  issuePreviewHandoff,
  resolveActivePreviewCapability,
  resolveActivePreviewCapabilityToken,
  resolvePreviewCapability,
  resolveReservedPreviewCapability,
  resolveReservedPreviewCapabilityToken,
  resolveReservedPreviewHost,
  resolveReservedPreviewSessionToken,
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
  "project-handoff-replay",
  "project-handoff-expiry",
  "project-handoff-binding",
  "project-handoff-other",
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

  it("atomically exchanges a handoff once for a different host session", () => {
    const projectId = "project-handoff-replay";
    const host = "p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.preview.example.test";
    const now = 9_000;
    registerPreviewPort(4_321, projectId);
    const capability = issuePreviewCapability(projectId, 4_321, now);
    const handoff = issuePreviewHandoff(projectId, 4_321, host, now);

    const exchanged = consumeReservedPreviewHandoff(handoff.token, host, now);
    expect(exchanged).toMatchObject({
      ok: true,
      projectId,
      port: 4_321,
      host,
      expiresAt: now + PREVIEW_CAPABILITY_TTL_MS,
    });
    if (!exchanged.ok) return;
    expect(exchanged.token).not.toBe(handoff.token);
    expect(exchanged.token).not.toBe(capability.token);
    expect(resolvePreviewCapability("4321", handoff.token, now)).toEqual({ ok: false });
    expect(resolvePreviewCapability("4321", exchanged.token, now)).toEqual({ ok: false });
    expect(resolvePreviewCapability("4321", capability.token, now).ok).toBe(true);
    expect(consumeReservedPreviewHandoff(handoff.token, host, now)).toEqual({ ok: false });
    expect(resolveReservedPreviewSessionToken(handoff.token, host, now)).toEqual({
      ok: false,
    });
    expect(resolveReservedPreviewSessionToken(exchanged.token, host, now).ok).toBe(true);
  });

  it("expires a handoff before exchange", () => {
    const projectId = "project-handoff-expiry";
    const host = "p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.preview.example.test";
    const now = 10_000;
    registerPreviewPort(4_322, projectId);
    issuePreviewCapability(projectId, 4_322, now);
    const handoff = issuePreviewHandoff(projectId, 4_322, host, now);

    expect(
      consumeReservedPreviewHandoff(handoff.token, host, now + PREVIEW_HANDOFF_TTL_MS),
    ).toEqual({ ok: false });
    expect(consumeReservedPreviewHandoff(handoff.token, host, now)).toEqual({ ok: false });
  });

  it("binds handoffs and sessions to the exact host, project, and port", () => {
    const projectId = "project-handoff-binding";
    const host = "p-cccccccccccccccccccccccccccccccccccccccc.preview.example.test:8443";
    const wrongHost = "p-dddddddddddddddddddddddddddddddddddddddd.preview.example.test:8443";
    const now = 11_000;
    registerPreviewPort(4_323, projectId);
    issuePreviewCapability(projectId, 4_323, now);
    const handoff = issuePreviewHandoff(projectId, 4_323, host, now);

    expect(consumeReservedPreviewHandoff(handoff.token, wrongHost, now)).toEqual({
      ok: false,
    });
    expect(consumeReservedPreviewHandoff(handoff.token, host.replace(":8443", ""), now)).toEqual({
      ok: false,
    });
    const exchanged = consumeReservedPreviewHandoff(handoff.token, host, now);
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    expect(resolveReservedPreviewSessionToken(exchanged.token, wrongHost, now)).toEqual({
      ok: false,
    });
    expect(resolveReservedPreviewSessionToken(exchanged.token, host, now)).toMatchObject({
      ok: true,
      projectId,
      port: 4_323,
    });

    unregisterPreviewPort(projectId);
    registerPreviewPort(4_323, "project-handoff-other");
    expect(resolveReservedPreviewSessionToken(exchanged.token, host, now)).toEqual({
      ok: false,
    });

    unregisterPreviewPort("project-handoff-other");
    registerPreviewPort(4_324, projectId);
    expect(resolveReservedPreviewSessionToken(exchanged.token, host, now)).toEqual({
      ok: false,
    });
  });

  it("bounds active host sessions per project and revokes the oldest", () => {
    const projectId = "project-handoff-session-limit";
    const host = "p-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.preview.example.test";
    const now = 12_000;
    registerPreviewPort(4_325, projectId);
    issuePreviewCapability(projectId, 4_325, now);

    const sessions: string[] = [];
    for (let index = 0; index <= MAX_PREVIEW_SESSIONS_PER_PROJECT; index += 1) {
      const handoff = issuePreviewHandoff(projectId, 4_325, host, now + index);
      const exchanged = consumeReservedPreviewHandoff(handoff.token, host, now + index);
      expect(exchanged.ok).toBe(true);
      if (exchanged.ok) sessions.push(exchanged.token);
    }

    expect(resolveReservedPreviewSessionToken(sessions[0] ?? "", host, now + 100)).toEqual({
      ok: false,
    });
    expect(
      resolveReservedPreviewSessionToken(sessions.at(-1) ?? "", host, now + 100),
    ).toMatchObject({ ok: true, projectId, port: 4_325 });
  });
});
