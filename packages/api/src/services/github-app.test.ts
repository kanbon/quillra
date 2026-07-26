import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingStore = vi.hoisted(() => new Map<string, string>());

vi.mock("./instance-settings.js", () => ({
  getInstanceSetting: vi.fn((key: string) => settingStore.get(key) ?? null),
  setInstanceSettingsAtomically: vi.fn(
    (writes: ReadonlyArray<{ key: string; value: string | null }>) => {
      for (const { key, value } of writes) {
        if (value === null) settingStore.delete(key);
        else settingStore.set(key, value);
      }
    },
  ),
}));

import {
  clearGithubAppCredentials,
  exchangeManifestCode,
  getGithubAppBotIdentity,
  getInstallationToken,
  requireGithubAppBotIdentity,
  resetGithubAppInstallationTokens,
} from "./github-app.js";

beforeEach(() => {
  settingStore.clear();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  settingStore.set("GITHUB_APP_ID", "42");
  settingStore.set(
    "GITHUB_APP_PRIVATE_KEY",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
});

afterEach(async () => {
  // Keep this module's process-local token registry isolated between tests.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 401 })),
  );
  await resetGithubAppInstallationTokens(clearGithubAppCredentials);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("repository-scoped GitHub installation tokens", () => {
  it("persists the manifest credentials and user OAuth callback as one bundle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: 84,
          slug: "quillra-test",
          name: "Quillra Test",
          client_id: "Iv1.test",
          client_secret: "github-client-secret",
          pem: "github-private-key",
          webhook_secret: null,
          html_url: "https://github.com/apps/quillra-test",
        }),
      ),
    );

    await exchangeManifestCode(
      "one-time-code",
      "https://cms.example.com/api/github/connect/callback",
    );

    expect(settingStore.get("GITHUB_APP_ID")).toBe("84");
    expect(settingStore.get("GITHUB_APP_CLIENT_SECRET")).toBe("github-client-secret");
    expect(settingStore.get("GITHUB_APP_PRIVATE_KEY")).toBe("github-private-key");
    expect(settingStore.get("GITHUB_APP_OAUTH_CALLBACK_URL")).toBe(
      "https://cms.example.com/api/github/connect/callback",
    );
  });

  it("requests exactly one repository and the requested contents permission", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Response.json({
          token: "installation-token",
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getInstallationToken("1001", "2002", "read")).resolves.toBe("installation-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/app/installations/1001/access_tokens");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      repository_ids: [2002],
      permissions: { contents: "read" },
    });
  });

  it("separates read and write tokens in the cache", async () => {
    let tokenNumber = 0;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Response.json({
          token: `token-${++tokenNumber}`,
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getInstallationToken("1003", "2004", "read");
    await getInstallationToken("1003", "2004", "read");
    await getInstallationToken("1003", "2004", "write");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      repository_ids: [2004],
      permissions: { contents: "write" },
    });
  });

  it("rejects malformed ids before making a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getInstallationToken("../100", "2006", "read")).rejects.toThrow(/installation id/);
    await expect(getInstallationToken("1005", "0", "read")).rejects.toThrow(/repository id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries bot identity lookup after a transient GitHub failure", async () => {
    settingStore.set("GITHUB_APP_SLUG", "quillra-test");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: 123, login: "quillra-test[bot]" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGithubAppBotIdentity("scoped-token")).resolves.toBeNull();
    await expect(getGithubAppBotIdentity("scoped-token")).resolves.toEqual({
      name: "quillra-test[bot]",
      email: "123+quillra-test[bot]@users.noreply.github.com",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of publishing with a human committer when the bot is unavailable", async () => {
    settingStore.set("GITHUB_APP_SLUG", "quillra-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 503 })),
    );

    await expect(requireGithubAppBotIdentity("scoped-token")).rejects.toThrow(
      "could not verify the Quillra App bot identity",
    );
  });

  it("closes the cache/mint gate synchronously until reset finalization completes", async () => {
    let finishFinalize!: () => void;
    const finalizeGate = new Promise<void>((resolve) => {
      finishFinalize = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === "https://api.github.com/installation/token") {
        return new Response(null, { status: 204 });
      }
      return Response.json({
        token: "cached-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await getInstallationToken("1007", "2008", "read");
    const reset = resetGithubAppInstallationTokens(async () => {
      await finalizeGate;
      clearGithubAppCredentials();
    });

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/installation/token",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    const callCount = fetchMock.mock.calls.length;
    await expect(getInstallationToken("1007", "2008", "read")).rejects.toThrow(/being reset/);
    expect(fetchMock).toHaveBeenCalledTimes(callCount);

    finishFinalize();
    await expect(reset).resolves.toBeUndefined();
  });

  it("refuses to clear credentials directly while a live issued token remains", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          token: "must-revoke-first",
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        }),
      ),
    );

    await getInstallationToken("1008", "2009", "read");
    expect(() => clearGithubAppCredentials()).toThrow(/before installation tokens are revoked/);
    expect(settingStore.get("GITHUB_APP_ID")).toBe("42");
  });

  it("waits for an in-flight mint and revokes its result before clearing credentials", async () => {
    let finishMint!: (response: Response) => void;
    const mintResponse = new Promise<Response>((resolve) => {
      finishMint = resolve;
    });
    const revoked: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.github.com/installation/token") {
        revoked.push(String(new Headers(init?.headers).get("Authorization")));
        return new Response(null, { status: 204 });
      }
      return mintResponse;
    });
    vi.stubGlobal("fetch", fetchMock);

    const mint = getInstallationToken("1009", "2010", "read");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const finalize = vi.fn(clearGithubAppCredentials);
    const reset = resetGithubAppInstallationTokens(finalize);
    await Promise.resolve();
    expect(finalize).not.toHaveBeenCalled();
    expect(revoked).toEqual([]);

    finishMint(
      Response.json({
        token: "in-flight-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      }),
    );

    await expect(mint).resolves.toBe("in-flight-token");
    await expect(reset).resolves.toBeUndefined();
    expect(revoked).toEqual(["Bearer in-flight-token"]);
    expect(finalize).toHaveBeenCalledOnce();
    expect(settingStore.has("GITHUB_APP_ID")).toBe(false);
  });

  it("singleflights parallel identical mints and revokes the one issued token", async () => {
    let finishMint!: (response: Response) => void;
    const mintResponse = new Promise<Response>((resolve) => {
      finishMint = resolve;
    });
    const revoked: string[] = [];
    let postCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.github.com/installation/token") {
        revoked.push(String(new Headers(init?.headers).get("Authorization")));
        return new Response(null, { status: 204 });
      }
      postCount += 1;
      return mintResponse;
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = getInstallationToken("1011", "2012", "write");
    const second = getInstallationToken("1011", "2012", "write");
    expect(postCount).toBe(1);
    finishMint(
      Response.json({
        token: "singleflight-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      "singleflight-token",
      "singleflight-token",
    ]);
    await resetGithubAppInstallationTokens(clearGithubAppCredentials);
    expect(revoked).toEqual(["Bearer singleflight-token"]);
  });

  it("retains early-refreshed tokens until their real expiry and revokes both", async () => {
    const baseTime = Date.parse("2026-07-23T12:00:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    let mintNumber = 0;
    const revoked: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.github.com/installation/token") {
        revoked.push(String(new Headers(init?.headers).get("Authorization")));
        return new Response(null, { status: 204 });
      }
      mintNumber += 1;
      return Response.json({
        token: `refreshed-token-${mintNumber}`,
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getInstallationToken("1013", "2014", "read")).resolves.toBe("refreshed-token-1");
    now.mockReturnValue(baseTime + 51 * 60 * 1_000);
    await expect(getInstallationToken("1013", "2014", "read")).resolves.toBe("refreshed-token-2");

    await resetGithubAppInstallationTokens(clearGithubAppCredentials);
    expect(revoked.sort()).toEqual(["Bearer refreshed-token-1", "Bearer refreshed-token-2"]);
  });

  it.each([
    {
      name: "network failure",
      fail: () => {
        throw new Error("network unavailable");
      },
    },
    {
      name: "unexpected status",
      fail: () => new Response(null, { status: 503 }),
    },
  ])("keeps a failed revocation retryable after $name", async ({ fail }) => {
    let revocationAttempt = 0;
    let mintCount = 0;
    const finalize = vi.fn(clearGithubAppCredentials);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://api.github.com/installation/token") {
        revocationAttempt += 1;
        if (revocationAttempt === 1) return fail();
        return new Response(null, { status: 204 });
      }
      mintCount += 1;
      return Response.json({
        token: "retryable-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await getInstallationToken("1015", "2016", "read");
    await expect(resetGithubAppInstallationTokens(finalize)).rejects.toThrow();
    expect(finalize).not.toHaveBeenCalled();
    expect(settingStore.get("GITHUB_APP_ID")).toBe("42");

    // The failed token remains cached and the gate reopens for a safe retry.
    await expect(getInstallationToken("1015", "2016", "read")).resolves.toBe("retryable-token");
    expect(mintCount).toBe(1);

    await expect(resetGithubAppInstallationTokens(finalize)).resolves.toBeUndefined();
    expect(revocationAttempt).toBe(2);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("accepts 401 as proof that an installation token is already unusable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://api.github.com/installation/token") {
        return new Response(null, { status: 401 });
      }
      return Response.json({
        token: "already-expired-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await getInstallationToken("1017", "2018", "read");
    await expect(
      resetGithubAppInstallationTokens(clearGithubAppCredentials),
    ).resolves.toBeUndefined();
  });
});
