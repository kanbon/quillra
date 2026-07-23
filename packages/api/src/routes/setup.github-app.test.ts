import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_MANIFEST_FLOW_TTL_MS } from "../lib/github-manifest-flow.js";
import { githubAppManifestName } from "../lib/github-manifest-flow.js";

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "QUILLRA_ENCRYPTION_KEY",
  "QUILLRA_SETUP_TOKEN",
  "NODE_ENV",
] as const;

const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));
const conversion = {
  id: 42,
  slug: "quillra-test",
  name: "Quillra Test",
  client_id: "Iv1.test",
  client_secret: "github-client-secret",
  pem: "test-private-key",
  webhook_secret: null,
  html_url: "https://github.com/apps/quillra-test",
};

let tempDirectory: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;

function restoreEnvironment() {
  for (const key of CONTROLLED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function responseCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected response cookie");
  return cookie;
}

function cookieHeader(...cookies: string[]): string {
  return cookies.join("; ");
}

async function loadRuntime() {
  vi.resetModules();
  const { setupRouter } = await import("./setup.js");
  const { rawSqlite } = await import("../db/index.js");
  const { fixedWindowRateLimiter } = await import("../lib/fixed-window-rate-limit.js");
  const { githubManifestFlowStore } = await import("../lib/github-manifest-flow.js");
  openDatabase = rawSqlite;
  fixedWindowRateLimiter.clear();
  githubManifestFlowStore.clear();
  return { setupRouter, rawSqlite };
}

type SetupRouter = Awaited<ReturnType<typeof loadRuntime>>["setupRouter"];

async function unlock(setupRouter: SetupRouter): Promise<string> {
  const response = await setupRouter.request("/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "manifest-flow-setup-token" }),
  });
  expect(response.status).toBe(200);
  return responseCookie(response);
}

async function startFlow(setupRouter: SetupRouter, accessCookie: string) {
  const response = await setupRouter.request("/github-app/start", {
    headers: { Cookie: accessCookie },
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  const encodedManifest = html.match(/name="manifest" value='([^']+)'/)?.[1];
  if (!encodedManifest) throw new Error("Expected GitHub App manifest");
  const manifest = JSON.parse(encodedManifest.replaceAll("&apos;", "'")) as {
    name: string;
    redirect_url: string;
    callback_urls: string[];
  };
  const action = html.match(/<form[^>]+action="([^"]+)"/)?.[1];
  if (!action) throw new Error("Expected GitHub App manifest form action");
  const state = new URL(action).searchParams.get("state");
  if (!state) throw new Error("Expected manifest callback state");
  return {
    state,
    flowCookie: responseCookie(response),
    appName: manifest.name,
    redirectUrl: manifest.redirect_url,
    callbackUrls: manifest.callback_urls,
    action,
  };
}

function stubGitHubConversion() {
  const fetchMock = vi.fn(
    async (_input: Parameters<typeof fetch>[0]) =>
      new Response(JSON.stringify(conversion), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-manifest-flow-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.BETTER_AUTH_SECRET = "manifest-flow-auth-secret";
  process.env.BETTER_AUTH_URL = "http://quillra.test";
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.QUILLRA_SETUP_TOKEN = "manifest-flow-setup-token";
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnvironment();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("GitHub App manifest callback state", () => {
  it("uses a stable installation suffix without exceeding GitHub's name limit", () => {
    const first = githubAppManifestName(
      "A very long agency instance name that cannot fit",
      "http://localhost:3000",
      "installation-secret-one",
    );
    const repeat = githubAppManifestName(
      "A very long agency instance name that cannot fit",
      "http://localhost:3000",
      "installation-secret-one",
    );
    const other = githubAppManifestName(
      "A very long agency instance name that cannot fit",
      "http://localhost:3000",
      "installation-secret-two",
    );

    expect(first).toBe(repeat);
    expect(first).not.toBe(other);
    expect(first.length).toBeLessThanOrEqual(34);
    expect(first).toMatch(/-[A-Za-z0-9_-]{8}$/);
  });

  it("binds a valid start and callback, then consumes the state before conversion", async () => {
    const fetchMock = stubGitHubConversion();
    const { setupRouter, rawSqlite } = await loadRuntime();
    const accessCookie = await unlock(setupRouter);
    const flow = await startFlow(setupRouter, accessCookie);

    expect(flow.redirectUrl).toBe("http://quillra.test/api/setup/github-app/callback");
    expect(flow.callbackUrls).toEqual(["http://quillra.test/api/github/connect/callback"]);
    expect(flow.appName).toMatch(/^Quillra @ quillra\.test-[A-Za-z0-9_-]{8}$/);
    expect(flow.action).toBe(`https://github.com/settings/apps/new?state=${flow.state}`);
    expect(flow.flowCookie).toMatch(/^quillra_github_manifest_flow=/);

    const response = await setupRouter.request(
      `/github-app/callback?code=valid-code&state=${flow.state}`,
      { headers: { Cookie: cookieHeader(accessCookie, flow.flowCookie) } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://github.com/apps/quillra-test/installations/new",
    );
    expect(response.headers.get("set-cookie")).toContain("quillra_github_manifest_flow=");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/valid-code/conversions");
    expect(
      rawSqlite.prepare("SELECT value FROM instance_settings WHERE key = ?").get("GITHUB_APP_ID"),
    ).toMatchObject({ value: "42" });
    expect(
      rawSqlite
        .prepare("SELECT value FROM instance_settings WHERE key = ?")
        .get("GITHUB_APP_OAUTH_CALLBACK_URL"),
    ).toEqual({ value: "http://quillra.test/api/github/connect/callback" });
  });

  it("rejects a missing query state or flow cookie without calling GitHub", async () => {
    const fetchMock = stubGitHubConversion();
    const { setupRouter } = await loadRuntime();
    const accessCookie = await unlock(setupRouter);
    const flow = await startFlow(setupRouter, accessCookie);

    const missingState = await setupRouter.request("/github-app/callback?code=missing-state", {
      headers: { Cookie: cookieHeader(accessCookie, flow.flowCookie) },
    });
    expect(missingState.status).toBe(400);

    const missingCookie = await setupRouter.request(
      `/github-app/callback?code=missing-cookie&state=${flow.state}`,
      { headers: { Cookie: accessCookie } },
    );
    expect(missingCookie.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a mismatched state without consuming the valid flow", async () => {
    const fetchMock = stubGitHubConversion();
    const { setupRouter } = await loadRuntime();
    const accessCookie = await unlock(setupRouter);
    const flow = await startFlow(setupRouter, accessCookie);
    const cookies = cookieHeader(accessCookie, flow.flowCookie);

    const wrong = await setupRouter.request(
      `/github-app/callback?code=wrong-state&state=${"A".repeat(43)}`,
      { headers: { Cookie: cookies } },
    );
    expect(wrong.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const valid = await setupRouter.request(
      `/github-app/callback?code=valid-after-mismatch&state=${flow.state}`,
      { headers: { Cookie: cookies } },
    );
    expect(valid.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired state without calling GitHub", async () => {
    const fetchMock = stubGitHubConversion();
    const startTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(startTime);
    const { setupRouter } = await loadRuntime();
    const accessCookie = await unlock(setupRouter);
    const flow = await startFlow(setupRouter, accessCookie);
    now.mockReturnValue(startTime + GITHUB_MANIFEST_FLOW_TTL_MS);

    const response = await setupRouter.request(
      `/github-app/callback?code=expired-code&state=${flow.state}`,
      { headers: { Cookie: cookieHeader(accessCookie, flow.flowCookie) } },
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects replay of a consumed state", async () => {
    const fetchMock = stubGitHubConversion();
    const { setupRouter } = await loadRuntime();
    const accessCookie = await unlock(setupRouter);
    const flow = await startFlow(setupRouter, accessCookie);
    const request = {
      headers: { Cookie: cookieHeader(accessCookie, flow.flowCookie) },
    };
    const callback = `/github-app/callback?code=replay-code&state=${flow.state}`;

    expect((await setupRouter.request(callback, request)).status).toBe(302);
    expect((await setupRouter.request(callback, request)).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
