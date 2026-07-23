import { afterEach, describe, expect, it, vi } from "vitest";
import { E2bVerificationError, verifyE2bConfiguration } from "./e2b-verification.js";

function installTrafficGateway(
  options: {
    trafficHeaderPresent?: boolean;
    allowUnauthenticated?: boolean;
  } = {},
) {
  const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const authenticated = new Headers(init?.headers).has("e2b-traffic-access-token");
    if (authenticated) {
      return Response.json({
        trafficHeaderPresent: options.trafficHeaderPresent ?? false,
      });
    }
    return options.allowUnauthenticated
      ? Response.json({ trafficHeaderPresent: false })
      : new Response("Unauthorized", { status: 401 });
  });
  vi.stubGlobal("fetch", request);
  return request;
}

function verificationSandbox(
  options: {
    run?: (
      command: string,
      options: { timeoutMs: number },
    ) => Promise<{ exitCode: number; stdout: string }>;
    kill?: () => Promise<boolean>;
  } = {},
) {
  return {
    trafficAccessToken: "traffic-token",
    getHost: () => "probe.example.test",
    commands: {
      run:
        options.run ??
        (async () => ({
          exitCode: 0,
          stdout: "quillra-e2b-ok",
        })),
    },
    kill: options.kill ?? (async () => true),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("E2B configuration verification", () => {
  it("runs fixed execution and private-traffic probes, then kills the sandbox", async () => {
    const fetchMock = installTrafficGateway();
    const run = vi.fn(async (_command: string, _options: { timeoutMs: number }) => ({
      exitCode: 0,
      stdout: "quillra-e2b-ok",
    }));
    const kill = vi.fn(async () => true);
    const create = vi.fn(async () => verificationSandbox({ run, kill }));

    await expect(
      verifyE2bConfiguration({ apiKey: "e2b_live_secret", templateId: "quillra-secure" }, create),
    ).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledWith({
      apiKey: "e2b_live_secret",
      templateId: "quillra-secure",
    });
    expect(run).toHaveBeenNthCalledWith(1, expect.stringContaining("/bin/bash -c "), {
      timeoutMs: 10_000,
    });
    const prerequisiteProbe = run.mock.calls[0]?.[0] ?? "";
    for (const tool of [
      "/bin/bash",
      "/bin/rm",
      "/usr/bin/base64",
      "/usr/bin/cat",
      "/usr/bin/dd",
      "/usr/bin/head",
      "/usr/bin/kill",
      "/usr/bin/mkfifo",
      "/usr/bin/python3",
      "/usr/bin/setsid",
    ]) {
      expect(prerequisiteProbe).toContain(tool);
    }
    expect(prerequisiteProbe).toContain("/usr/bin/python3 -I -S -c");
    const trafficProbe = run.mock.calls[1]?.[0] ?? "";
    expect(trafficProbe).toContain("e2b-traffic-access-token");
    expect(trafficProbe).toContain("/usr/bin/setsid --fork /bin/bash -c");
    expect(trafficProbe).toContain("/usr/bin/python3 -I -S -c");
    expect(trafficProbe).not.toMatch(
      /(?:^|[\s;&|])(?:bash|node|nohup|python3|setsid)(?=$|[\s;&|])/,
    );
    for (const tool of ["/usr/bin/setsid", "/bin/bash", "/usr/bin/python3"]) {
      expect(prerequisiteProbe).toContain(tool);
    }
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://probe.example.test/",
      expect.objectContaining({
        headers: { "e2b-traffic-access-token": "traffic-token" },
        redirect: "manual",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://probe.example.test/",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toBeUndefined();
    expect(kill).toHaveBeenCalledWith({ requestTimeoutMs: 20_000 });
  });

  it("kills a sandbox whose execution probe fails", async () => {
    const kill = vi.fn(async () => true);
    const create = vi.fn(async () =>
      verificationSandbox({
        run: async () => ({ exitCode: 1, stdout: "wrong" }),
        kill,
      }),
    );

    await expect(verifyE2bConfiguration({ apiKey: "e2b_bad_probe" }, create)).rejects.toMatchObject(
      {
        code: "probe-failed",
      },
    );
    expect(kill).toHaveBeenCalledOnce();
  });

  it("never includes the API key in provider or cleanup errors", async () => {
    installTrafficGateway();
    const apiKey = "e2b_never_return_this_secret";
    const providerFailure = vi.fn(async () => {
      throw new Error(`Unauthorized ${apiKey}`);
    });

    const unavailable = await verifyE2bConfiguration({ apiKey }, providerFailure).catch(
      (error: unknown) => error,
    );
    expect(unavailable).toBeInstanceOf(E2bVerificationError);
    expect(String(unavailable)).not.toContain(apiKey);

    const cleanupFailure = await verifyE2bConfiguration({ apiKey }, async () =>
      verificationSandbox({
        kill: async () => {
          throw new Error(`Cleanup failed for ${apiKey}`);
        },
      }),
    ).catch((error: unknown) => error);
    expect(cleanupFailure).toBeInstanceOf(E2bVerificationError);
    expect(cleanupFailure).toMatchObject({ code: "cleanup-failed" });
    expect(String(cleanupFailure)).not.toContain(apiKey);
  });

  it("does not accept an unconfirmed sandbox cleanup", async () => {
    installTrafficGateway();
    await expect(
      verifyE2bConfiguration({ apiKey: "e2b_cleanup_not_confirmed" }, async () =>
        verificationSandbox({ kill: async () => false }),
      ),
    ).rejects.toMatchObject({ code: "cleanup-failed" });
  });

  it("fails closed when E2B forwards the traffic token to sandbox code", async () => {
    installTrafficGateway({ trafficHeaderPresent: true });
    const kill = vi.fn(async () => true);
    await expect(
      verifyE2bConfiguration({ apiKey: "e2b_forwarded_traffic_token" }, async () =>
        verificationSandbox({ kill }),
      ),
    ).rejects.toMatchObject({ code: "probe-failed" });
    expect(kill).toHaveBeenCalledOnce();
  });

  it("fails closed when a protected host accepts a request without the token", async () => {
    installTrafficGateway({ allowUnauthenticated: true });
    const kill = vi.fn(async () => true);
    await expect(
      verifyE2bConfiguration({ apiKey: "e2b_unprotected_host" }, async () =>
        verificationSandbox({ kill }),
      ),
    ).rejects.toMatchObject({ code: "probe-failed" });
    expect(kill).toHaveBeenCalledOnce();
  });

  it("rejects an oversized protected response before parsing it", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Response(
          new Headers(init?.headers).has("e2b-traffic-access-token")
            ? JSON.stringify({
                trafficHeaderPresent: false,
                padding: "x".repeat(4 * 1024),
              })
            : "Unauthorized",
          {
            status: new Headers(init?.headers).has("e2b-traffic-access-token") ? 200 : 401,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const kill = vi.fn(async () => true);

    await expect(
      verifyE2bConfiguration({ apiKey: "e2b_oversized_response" }, async () =>
        verificationSandbox({ kill }),
      ),
    ).rejects.toMatchObject({ code: "probe-failed" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
  });
});
