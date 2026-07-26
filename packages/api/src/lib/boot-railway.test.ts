import { describe, expect, it, vi } from "vitest";
import { RAILWAY_DATA_MOUNT_PATH, configureRailwayRuntime } from "./boot-railway.js";

const railwayBase = {
  RAILWAY_DEPLOYMENT_ID: "deployment-1",
  RAILWAY_VOLUME_MOUNT_PATH: RAILWAY_DATA_MOUNT_PATH,
};

describe("configureRailwayRuntime", () => {
  it("does nothing outside a Railway deployment", () => {
    const environment: Record<string, string | undefined> = {
      RAILWAY_PUBLIC_DOMAIN: "quillra.example.com",
    };
    configureRailwayRuntime(environment, "/app/packages/api");
    expect(environment.BETTER_AUTH_URL).toBeUndefined();
    expect(environment.TRUSTED_ORIGINS).toBeUndefined();
  });

  it("infers and trusts the Railway public HTTPS origin", () => {
    const environment: Record<string, string | undefined> = {
      ...railwayBase,
      RAILWAY_PUBLIC_DOMAIN: "Quillra-Production.up.railway.app",
    };
    const info = vi.fn();

    configureRailwayRuntime(environment, "/app/packages/api", { info });

    expect(environment.BETTER_AUTH_URL).toBe("https://quillra-production.up.railway.app");
    expect(environment.TRUSTED_ORIGINS).toBe("https://quillra-production.up.railway.app");
    expect(info).toHaveBeenCalledOnce();
  });

  it("keeps an explicit public origin and merges normalized trusted origins", () => {
    const environment: Record<string, string | undefined> = {
      ...railwayBase,
      BETTER_AUTH_URL: "https://cms.example.com/",
      TRUSTED_ORIGINS: "https://admin.example.com/,https://cms.example.com",
    };

    configureRailwayRuntime(environment, "/app/packages/api");

    expect(environment.BETTER_AUTH_URL).toBe("https://cms.example.com");
    expect(environment.TRUSTED_ORIGINS).toBe("https://cms.example.com,https://admin.example.com");
  });

  it.each([
    "https://evil.example.com",
    "example.com/path",
    "example.com:443",
    "-invalid.example.com",
    "single-label",
  ])("rejects an invalid Railway public domain: %s", (domain) => {
    expect(() =>
      configureRailwayRuntime(
        { ...railwayBase, RAILWAY_PUBLIC_DOMAIN: domain },
        "/app/packages/api",
      ),
    ).toThrow("RAILWAY_PUBLIC_DOMAIN");
  });

  it("requires public networking or an explicit origin", () => {
    expect(() => configureRailwayRuntime({ ...railwayBase }, "/app/packages/api")).toThrow(
      "public networking is required",
    );
  });

  it("requires a Railway Volume at the image data path", () => {
    expect(() =>
      configureRailwayRuntime(
        {
          RAILWAY_DEPLOYMENT_ID: "deployment-1",
          RAILWAY_PUBLIC_DOMAIN: "quillra.up.railway.app",
        },
        "/app/packages/api",
      ),
    ).toThrow(`attach one Railway Volume at ${RAILWAY_DATA_MOUNT_PATH}`);

    expect(() =>
      configureRailwayRuntime(
        {
          ...railwayBase,
          RAILWAY_VOLUME_MOUNT_PATH: "/data",
          RAILWAY_PUBLIC_DOMAIN: "quillra.up.railway.app",
        },
        "/app/packages/api",
      ),
    ).toThrow(`change its mount path to ${RAILWAY_DATA_MOUNT_PATH}`);
  });

  it("requires the database and workspaces to live on the Railway Volume", () => {
    expect(() =>
      configureRailwayRuntime(
        {
          ...railwayBase,
          RAILWAY_PUBLIC_DOMAIN: "quillra.up.railway.app",
          DATABASE_URL: "file:/tmp/cms.sqlite",
        },
        "/app/packages/api",
      ),
    ).toThrow("DATABASE_URL resolves outside");

    expect(() =>
      configureRailwayRuntime(
        {
          ...railwayBase,
          RAILWAY_PUBLIC_DOMAIN: "quillra.up.railway.app",
          WORKSPACE_DIR: "/tmp/workspaces",
        },
        "/app/packages/api",
      ),
    ).toThrow("WORKSPACE_DIR resolves outside");
  });

  it("accepts the container defaults when the expected Volume is attached", () => {
    const environment: Record<string, string | undefined> = {
      ...railwayBase,
      RAILWAY_PUBLIC_DOMAIN: "quillra.up.railway.app",
    };

    expect(() => configureRailwayRuntime(environment, "/app/packages/api")).not.toThrow();
  });
});
