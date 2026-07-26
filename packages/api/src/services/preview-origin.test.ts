import { describe, expect, it } from "vitest";
import {
  PREVIEW_ACCESS_COOKIE,
  buildHostPreviewUrl,
  getPreviewOriginConfig,
  isPreviewDomainChild,
  isPreviewHostForProject,
  previewHostLabel,
  previewLabelFromHost,
} from "./preview-origin.js";

const environment = {
  BETTER_AUTH_URL: "https://cms.example.com",
  BETTER_AUTH_SECRET: "preview-host-test-secret",
  PREVIEW_DOMAIN: "preview.example.net",
  TRUSTED_ORIGINS: "https://cms.example.com,https://edit.example.com",
};

describe("preview origin", () => {
  it("builds a stable opaque host and keeps the browser path at root", () => {
    const config = getPreviewOriginConfig(environment);
    expect(config).not.toBeNull();
    if (!config) return;

    const url = new URL(buildHostPreviewUrl("project-1", "capability-token", config, environment));
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toMatch(/^p-[a-f0-9]{40}\.preview\.example\.net$/);
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("__quillra_preview")).toBe("capability-token");
    expect(config.accessCookieName).toBe(PREVIEW_ACCESS_COOKIE);
    expect(config.controlOrigins).toEqual(["https://cms.example.com", "https://edit.example.com"]);
    expect(previewHostLabel("project-1", environment)).toBe(
      previewHostLabel("project-1", environment),
    );
    expect(previewHostLabel("project-2", environment)).not.toBe(
      previewHostLabel("project-1", environment),
    );
  });

  it("uses a router-safe localhost subdomain without extra configuration", () => {
    const localEnvironment = {
      BETTER_AUTH_URL: "http://localhost:3417",
      BETTER_AUTH_SECRET: "local-preview-secret",
    };
    const config = getPreviewOriginConfig(localEnvironment);
    expect(config).toMatchObject({
      protocol: "http:",
      hostname: "localhost",
      port: "3417",
      accessCookieName: PREVIEW_ACCESS_COOKIE,
    });
    expect(config?.controlOrigins).toEqual([
      "http://localhost:3417",
      "http://localhost:5173",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
    ]);
    if (!config) return;

    const url = new URL(buildHostPreviewUrl("local-project", "token", config, localEnvironment));
    expect(url.hostname).toMatch(/^p-[a-f0-9]{40}\.localhost$/);
    expect(url.port).toBe("3417");
    expect(url.pathname).toBe("/");
  });

  it("falls back when production has no preview domain or the value is unsafe", () => {
    expect(
      getPreviewOriginConfig({
        BETTER_AUTH_URL: "https://cms.example.com",
        BETTER_AUTH_SECRET: "secret",
      }),
    ).toBeNull();
    expect(
      getPreviewOriginConfig({ ...environment, PREVIEW_DOMAIN: "https://user@evil.test" }),
    ).toBeNull();
    expect(
      getPreviewOriginConfig({ ...environment, PREVIEW_DOMAIN: "https://preview.test/path" }),
    ).toBeNull();
    expect(
      getPreviewOriginConfig({ ...environment, PREVIEW_DOMAIN: "http://preview.example.net" }),
    ).toBeNull();
    expect(
      getPreviewOriginConfig({
        ...environment,
        BETTER_AUTH_URL: "http://cms.example.com",
        PREVIEW_DOMAIN: "preview.example.net",
      }),
    ).toBeNull();
    expect(getPreviewOriginConfig({ ...environment, PREVIEW_DOMAIN: "127.0.0.1" })).toBeNull();
  });

  it("matches exactly one valid child label and rejects suffix spoofing", () => {
    const config = getPreviewOriginConfig(environment);
    expect(config).not.toBeNull();
    if (!config) return;
    const label = previewHostLabel("project-1", environment);
    const host = `${label}.preview.example.net`;

    expect(previewLabelFromHost(`${host}:443`, config)).toBe(label);
    expect(isPreviewDomainChild(host, config)).toBe(true);
    expect(isPreviewHostForProject(host, "project-1", config, environment)).toBe(true);
    expect(isPreviewHostForProject(host, "project-2", config, environment)).toBe(false);
    expect(previewLabelFromHost(`extra.${host}`, config)).toBeNull();
    expect(previewLabelFromHost(`${host}.evil.test`, config)).toBeNull();
    expect(previewLabelFromHost("preview.example.net", config)).toBeNull();
  });
});
