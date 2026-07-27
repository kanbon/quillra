import { AuthenticationError } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";

const websocketGateway = vi.hoisted(() => ({
  allowUnauthenticated: false,
  calls: [] as Array<{ headers?: Record<string, string>; url: string }>,
  rejectionStatus: 403,
}));

vi.mock("ws", () => {
  class TestWebSocket {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string, options?: { headers?: Record<string, string> }) {
      websocketGateway.calls.push({
        url,
        ...(options?.headers ? { headers: options.headers } : {}),
      });
      queueMicrotask(() => {
        if (websocketGateway.allowUnauthenticated) {
          this.emit("open");
          return;
        }
        this.emit(
          "unexpected-response",
          {},
          {
            statusCode: websocketGateway.rejectionStatus,
            resume: () => undefined,
          },
        );
      });
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    terminate(): void {
      // The verification helper owns bounded cleanup; this fake has no socket.
    }

    private emit(event: string, ...args: unknown[]): void {
      const listeners = this.listeners.get(event) ?? [];
      this.listeners.delete(event);
      for (const listener of listeners) listener(...args);
    }
  }

  return { default: TestWebSocket };
});

import { E2BTrustedEnvironmentError, E2B_PREVIEW_RELAY_PORT } from "./e2b-preview-relay.js";
import { E2bVerificationError, verifyE2bConfiguration } from "./e2b-verification.js";

const PUBLIC_HOST = "verification.quillra.invalid";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

function installTrafficGateway(
  options: {
    trafficHeaderPresent?: boolean;
    relayMetadataPresent?: boolean;
    allowUnauthenticated?: boolean;
    allowUnauthenticatedWebSocket?: boolean;
    httpRejectionStatus?: number;
    webSocketRejectionStatus?: number;
    payload?: Record<string, unknown>;
  } = {},
) {
  websocketGateway.allowUnauthenticated = options.allowUnauthenticatedWebSocket ?? false;
  websocketGateway.rejectionStatus = options.webSocketRejectionStatus ?? 403;
  const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const token = new Headers(init?.headers).get("e2b-traffic-access-token");
    if (token === "traffic-token") {
      return Response.json({
        trafficHeaderPresent: options.trafficHeaderPresent ?? false,
        relayMetadataPresent: options.relayMetadataPresent ?? false,
        host: PUBLIC_HOST,
        origin: PUBLIC_ORIGIN,
        forwardedHost: PUBLIC_HOST,
        forwardedProto: "https",
        forwardedPort: "443",
        uid: 1_001,
        gid: 1_001,
        ...options.payload,
      });
    }
    return options.allowUnauthenticated
      ? Response.json({ accepted: true })
      : new Response("Forbidden", {
          status: options.httpRejectionStatus ?? 403,
        });
  });
  vi.stubGlobal("fetch", request);
  return request;
}

function verificationSandbox(
  options: {
    trafficAccessToken?: string;
    downloadResult?: { exitCode: number; stdout: string; stderr?: string };
    prerequisiteResult?: { exitCode: number; stdout: string; stderr?: string };
    prepare?: () => Promise<void>;
    startRelay?: (targetPort: number) => Promise<void>;
    kill?: () => Promise<boolean>;
  } = {},
) {
  const downloadProcess = {
    pid: 40,
    wait: vi.fn(async () => ({
      exitCode: 0,
      stdout: "quillra-e2b-downloads-reachable",
      stderr: "",
      ...options.downloadResult,
    })),
    kill: vi.fn(async () => true),
  };
  const prerequisiteProcess = {
    pid: 41,
    wait: vi.fn(async () => ({
      exitCode: 0,
      stdout: "quillra-e2b-ok",
      stderr: "",
      ...options.prerequisiteResult,
    })),
    kill: vi.fn(async () => true),
  };
  const trafficProcess = {
    pid: 42,
    wait: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    kill: vi.fn(async () => true),
  };
  const startCommand = vi
    .fn()
    .mockResolvedValueOnce(downloadProcess)
    .mockResolvedValueOnce(prerequisiteProcess)
    .mockResolvedValueOnce(trafficProcess);
  const prepareExecutionEnvironment = vi.fn(options.prepare ?? (async () => undefined));
  const startPreviewRelay = vi.fn(options.startRelay ?? (async () => undefined));
  const kill = vi.fn(options.kill ?? (async () => true));

  return {
    handle: {
      trafficAccessToken: options.trafficAccessToken ?? "traffic-token",
      prepareExecutionEnvironment,
      startPreviewRelay,
      startCommand,
      getHost: vi.fn(() => "39177-probe.example.test"),
      kill,
    },
    kill,
    downloadProcess,
    prepareExecutionEnvironment,
    prerequisiteProcess,
    startCommand,
    startPreviewRelay,
    trafficProcess,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  websocketGateway.allowUnauthenticated = false;
  websocketGateway.calls = [];
  websocketGateway.rejectionStatus = 403;
});

describe("E2B configuration verification", () => {
  it("checks the locked runtime and token-stripping relay, then removes the sandbox", async () => {
    const fetchMock = installTrafficGateway();
    const sandbox = verificationSandbox();
    const create = vi.fn(async () => sandbox.handle);

    const report = await verifyE2bConfiguration(
      { apiKey: "e2b_live_secret", templateId: "quillra-secure" },
      create,
    );

    expect(create).toHaveBeenCalledWith({
      apiKey: "e2b_live_secret",
      templateId: "quillra-secure",
    });
    expect(sandbox.prepareExecutionEnvironment).toHaveBeenCalledOnce();
    expect(sandbox.startPreviewRelay).toHaveBeenCalledWith(6_317);
    expect(sandbox.startCommand).toHaveBeenCalledTimes(3);

    const [downloadProbe, downloadOptions] = sandbox.startCommand.mock.calls[0] ?? [];
    expect(downloadProbe).toContain("https://nodejs.org/dist/index.json");
    expect(downloadProbe).toContain("https://registry.npmjs.org/corepack");
    expect(downloadProbe).toContain("/usr/bin/curl");
    expect(downloadProbe).toContain("--head");
    expect(downloadProbe).toContain("--connect-timeout 3");
    expect(downloadProbe).toContain("--max-time 4");
    expect(downloadProbe).toContain('--proto "=https"');
    expect(downloadProbe).toContain("quillra-e2b-downloads-reachable");
    expect(downloadProbe).not.toContain("1.1.1.1");
    expect(downloadOptions).toMatchObject({
      cwd: "/home/quillra-project",
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    });

    const [prerequisiteProbe, prerequisiteOptions] = sandbox.startCommand.mock.calls[1] ?? [];
    for (const tool of [
      "/bin/bash",
      "/bin/rm",
      "/usr/bin/awk",
      "/usr/bin/base64",
      "/usr/bin/cat",
      "/usr/bin/curl",
      "/usr/bin/dd",
      "/usr/bin/head",
      "/usr/bin/id",
      "/usr/bin/kill",
      "/usr/bin/mkdir",
      "/usr/bin/mkfifo",
      "/usr/bin/mv",
      "/usr/bin/python3",
      "/usr/bin/setsid",
      "/usr/bin/sha256sum",
      "/usr/bin/tar",
      "/usr/bin/uname",
      "/usr/bin/xz",
    ]) {
      expect(prerequisiteProbe).toContain(tool);
    }
    expect(prerequisiteProbe).toContain("for quillra_tool in node npm git");
    expect(prerequisiteProbe).toContain('type -P "$quillra_tool"');
    expect(prerequisiteProbe).toContain('"$quillra_tool_path" --version');
    expect(prerequisiteProbe).toContain('[ "$(/usr/bin/id -u)" -ne 0 ]');
    expect(prerequisiteOptions).toMatchObject({
      cwd: "/home/quillra-project",
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    });

    const [trafficProbe, trafficOptions] = sandbox.startCommand.mock.calls[2] ?? [];
    expect(trafficProbe).toContain(`"127.0.0.1",6317`);
    expect(trafficProbe).toContain("e2b-traffic-access-token");
    expect(trafficOptions).toMatchObject({
      cwd: "/home/quillra-project",
      maxOutputBytes: 1_024,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://39177-probe.example.test/",
      expect.objectContaining({
        headers: {
          "e2b-traffic-access-token": "traffic-token",
          "x-quillra-relay-host": PUBLIC_HOST,
          "x-quillra-relay-origin": PUBLIC_ORIGIN,
          "x-quillra-relay-port": "443",
          "x-quillra-relay-proto": "https",
        },
        redirect: "manual",
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toBeUndefined();
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({
      "e2b-traffic-access-token": "quillra-invalid-traffic-credential",
    });
    expect(websocketGateway.calls).toEqual([
      { url: "wss://39177-probe.example.test/" },
      {
        url: "wss://39177-probe.example.test/",
        headers: {
          "e2b-traffic-access-token": "quillra-invalid-traffic-credential",
        },
      },
    ]);
    expect(sandbox.handle.getHost).toHaveBeenCalledWith(E2B_PREVIEW_RELAY_PORT);
    expect(sandbox.trafficProcess.kill).toHaveBeenCalledOnce();
    expect(sandbox.kill).toHaveBeenCalledWith();
    expect(report.failedStage).toBeUndefined();
    expect(report.stages.every(({ status }) => status === "passed")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("traffic-token");
    expect(JSON.stringify(report)).not.toContain("e2b_live_secret");
  });

  it("fails closed and removes the sandbox when required downloads are unreachable", async () => {
    const sandbox = verificationSandbox({
      downloadResult: { exitCode: 28, stdout: "" },
    });

    const failure = await verifyE2bConfiguration(
      { apiKey: "e2b_downloads_unreachable" },
      async () => sandbox.handle,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(E2bVerificationError);
    expect(failure).toMatchObject({
      code: "probe-failed",
      verification: { failedStage: "sandbox" },
    });
    expect(JSON.stringify(failure)).toContain("Fixed command exited with code 28");
    expect(sandbox.prepareExecutionEnvironment).not.toHaveBeenCalled();
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("removes a sandbox whose non-root prerequisite probe fails", async () => {
    const sandbox = verificationSandbox({
      prerequisiteResult: { exitCode: 23, stdout: "wrong" },
    });

    const failure = await verifyE2bConfiguration(
      { apiKey: "e2b_bad_probe" },
      async () => sandbox.handle,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(E2bVerificationError);
    expect(failure).toMatchObject({
      code: "probe-failed",
      verification: { failedStage: "prerequisite" },
    });
    expect(JSON.stringify(failure)).toContain("Fixed command exited with code 23");
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("never includes the API key in provider or cleanup diagnostics", async () => {
    installTrafficGateway();
    const apiKey = "e2b_never_return_this_secret";
    const providerFailure = vi.fn(async () => {
      throw new Error(`Unauthorized ${apiKey}`);
    });

    const unavailable = await verifyE2bConfiguration({ apiKey }, providerFailure).catch(
      (error: unknown) => error,
    );
    expect(unavailable).toBeInstanceOf(E2bVerificationError);
    expect(JSON.stringify(unavailable)).not.toContain(apiKey);

    const sandbox = verificationSandbox({
      kill: async () => {
        throw new Error(`Cleanup failed for ${apiKey}`);
      },
    });
    const cleanupFailure = await verifyE2bConfiguration(
      { apiKey },
      async () => sandbox.handle,
    ).catch((error: unknown) => error);
    expect(cleanupFailure).toBeInstanceOf(E2bVerificationError);
    expect(cleanupFailure).toMatchObject({
      code: "cleanup-failed",
      verification: { failedStage: "cleanup" },
    });
    expect(JSON.stringify(cleanupFailure)).not.toContain(apiKey);
  });

  it("turns typed provider authentication failures into safe actionable diagnostics", async () => {
    const apiKey = "e2b_rejected_secret";
    const failure = await verifyE2bConfiguration({ apiKey }, async () => {
      throw new AuthenticationError(`Provider rejected ${apiKey}`);
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "unavailable",
      verification: { failedStage: "provider" },
    });
    expect(JSON.stringify(failure)).toContain("E2B rejected the API credential.");
    expect(JSON.stringify(failure)).not.toContain(apiKey);
  });

  it("accepts E2B false as confirmation that the sandbox is already absent", async () => {
    installTrafficGateway();
    const sandbox = verificationSandbox({ kill: async () => false });

    const report = await verifyE2bConfiguration(
      { apiKey: "e2b_cleanup_already_absent" },
      async () => sandbox.handle,
    );

    expect(report.stages.find(({ id }) => id === "cleanup")?.status).toBe("passed");
  });

  it("reports adapter bootstrap cleanup failure when no handle can be returned", async () => {
    const failure = await verifyE2bConfiguration(
      { apiKey: "e2b_cleanup_unconfirmed" },
      async () => {
        throw new E2BTrustedEnvironmentError("bootstrap", "failed");
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "cleanup-failed",
      verification: { failedStage: "cleanup" },
    });
  });

  it("reports adapter-confirmed bootstrap cleanup in the failed probe report", async () => {
    const failure = await verifyE2bConfiguration({ apiKey: "e2b_cleanup_confirmed" }, async () => {
      throw new E2BTrustedEnvironmentError("bootstrap", "confirmed");
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "probe-failed",
      verification: { failedStage: "prerequisite" },
    });
    const report = (failure as E2bVerificationError).verification;
    expect(report.stages.find(({ id }) => id === "cleanup")?.status).toBe("passed");
  });

  it("fails closed if the relay exposes the provider traffic credential", async () => {
    installTrafficGateway({ trafficHeaderPresent: true });
    const sandbox = verificationSandbox();

    const failure = await verifyE2bConfiguration(
      { apiKey: "e2b_forwarded_traffic_token" },
      async () => sandbox.handle,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "probe-failed",
      verification: { failedStage: "payload" },
    });
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("fails closed when private ingress accepts a missing credential", async () => {
    installTrafficGateway({ allowUnauthenticated: true });
    const sandbox = verificationSandbox();

    const failure = await verifyE2bConfiguration(
      { apiKey: "e2b_unprotected_host" },
      async () => sandbox.handle,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "probe-failed",
      verification: { failedStage: "unauthenticated-access" },
    });
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("does not mistake an unrelated HTTP error for an authentication rejection", async () => {
    installTrafficGateway({ httpRejectionStatus: 502 });
    const sandbox = verificationSandbox();

    const failure = await verifyE2bConfiguration(
      { apiKey: "e2b_broken_gateway" },
      async () => sandbox.handle,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "probe-failed",
      verification: { failedStage: "unauthenticated-access" },
    });
    expect(JSON.stringify(failure)).toContain(
      "Private HTTP ingress returned unexpected authentication status 502 or 502.",
    );
    expect(websocketGateway.calls).toHaveLength(0);
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("fails closed when private WebSocket ingress accepts a missing credential", async () => {
    installTrafficGateway({ allowUnauthenticatedWebSocket: true });
    const sandbox = verificationSandbox();

    const failure = await verifyE2bConfiguration(
      { apiKey: "e2b_unprotected_websocket" },
      async () => sandbox.handle,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "probe-failed",
      verification: { failedStage: "unauthenticated-access" },
    });
    expect(JSON.stringify(failure)).toContain(
      "Private WebSocket ingress accepted the missing credential.",
    );
    expect(websocketGateway.calls).toHaveLength(1);
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("does not mistake an unrelated WebSocket response for an authentication rejection", async () => {
    installTrafficGateway({ webSocketRejectionStatus: 404 });
    const sandbox = verificationSandbox();

    const failure = await verifyE2bConfiguration(
      { apiKey: "e2b_broken_websocket_gateway" },
      async () => sandbox.handle,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "probe-failed",
      verification: { failedStage: "unauthenticated-access" },
    });
    expect(JSON.stringify(failure)).toContain(
      "The missing WebSocket request returned unexpected HTTP 404.",
    );
    expect(websocketGateway.calls).toHaveLength(1);
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("rejects an oversized protected response before parsing it", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Headers(init?.headers).get("e2b-traffic-access-token") === "traffic-token"
        ? new Response(
            JSON.stringify({
              trafficHeaderPresent: false,
              padding: "x".repeat(4 * 1024),
            }),
            { headers: { "content-type": "application/json" } },
          )
        : new Response("Forbidden", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sandbox = verificationSandbox();

    const failure = await verifyE2bConfiguration(
      { apiKey: "e2b_oversized_response" },
      async () => sandbox.handle,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "probe-failed",
      verification: { failedStage: "payload" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("maps sanitized bootstrap failures to the runtime stage", async () => {
    const failure = await verifyE2bConfiguration(
      { apiKey: "e2b_template_without_runtime" },
      async () => {
        throw new E2BTrustedEnvironmentError("bootstrap");
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "probe-failed",
      verification: { failedStage: "prerequisite" },
    });
    const report = (failure as E2bVerificationError).verification;
    expect(report.stages.find(({ id }) => id === "provider")?.status).toBe("passed");
    expect(report.stages.find(({ id }) => id === "sandbox")?.status).toBe("skipped");
    expect(report.stages.find(({ id }) => id === "cleanup")?.status).toBe("skipped");
    expect(report.logs.some(({ message }) => message.includes("external IPv4/IPv6"))).toBe(false);
    expect(JSON.stringify(report)).not.toContain("e2b_template_without_runtime");
  });
});
