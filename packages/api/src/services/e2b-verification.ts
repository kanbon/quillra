import { setTimeout as delay } from "node:timers/promises";
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  TemplateError,
  TimeoutError,
} from "e2b";
import WebSocket from "ws";
import { type E2BProcess, type E2BSandboxHandle, E2BSdkAdapter } from "./e2b-adapter.js";
import {
  E2BTrustedEnvironmentError,
  E2B_PREVIEW_RELAY_PORT,
  E2B_PROJECT_HOME,
} from "./e2b-preview-relay.js";

const PROBE_OUTPUT = "quillra-e2b-ok";
const DOWNLOAD_PROBE_OUTPUT = "quillra-e2b-downloads-reachable";
const TRAFFIC_ACCESS_HEADER = "e2b-traffic-access-token";
const TRAFFIC_PROBE_PORT = 6_317;
const PROBE_SANDBOX_TIMEOUT_MS = 60_000;
const PROBE_REQUEST_TIMEOUT_MS = 20_000;
const PROBE_COMMAND_TIMEOUT_MS = 10_000;
const PROBE_HTTP_TIMEOUT_MS = 5_000;
const PROBE_READY_TIMEOUT_MS = 15_000;
const PROBE_HTTP_BODY_LIMIT_BYTES = 4 * 1024;
const PROBE_PUBLIC_HOST = "verification.quillra.invalid";
const PROBE_PUBLIC_ORIGIN = `https://${PROBE_PUBLIC_HOST}`;
const REQUIRED_RUNTIME_TOOLS = [
  "/bin/bash",
  "/bin/rm",
  "/usr/bin/base64",
  "/usr/bin/awk",
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
] as const;
const REQUIRED_PROJECT_TOOLS = ["node", "npm", "git"] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

const PREREQUISITE_PROBE_SCRIPT = [
  "set -eu",
  `for quillra_tool in ${REQUIRED_RUNTIME_TOOLS.join(" ")}; do`,
  '  [ -x "$quillra_tool" ]',
  "done",
  `for quillra_tool in ${REQUIRED_PROJECT_TOOLS.join(" ")}; do`,
  '  quillra_tool_path="$(type -P "$quillra_tool")"',
  '  [ -n "$quillra_tool_path" ]',
  '  [ -x "$quillra_tool_path" ]',
  '  "$quillra_tool_path" --version >/dev/null',
  "done",
  '[ "$(/usr/bin/id -u)" -ne 0 ]',
  `/usr/bin/python3 -I -S -c 'import base64,http.server,json,os,stat,sys;sys.stdout.write("${PROBE_OUTPUT}")'`,
].join("\n");
const PREREQUISITE_PROBE_COMMAND = `/bin/bash -c ${shellQuote(PREREQUISITE_PROBE_SCRIPT)}`;
const DOWNLOAD_PROBE_URLS = [
  "https://nodejs.org/dist/index.json",
  "https://registry.npmjs.org/corepack",
] as const;
const DOWNLOAD_PROBE_SCRIPT = [
  "set -eu",
  `for quillra_url in ${DOWNLOAD_PROBE_URLS.map(shellQuote).join(" ")}; do`,
  '  /usr/bin/curl --fail --silent --show-error --location --head --connect-timeout 3 --max-time 4 --max-redirs 2 --proto "=https" --proto-redir "=https" --output /dev/null "$quillra_url"',
  "done",
  `printf "%s" "${DOWNLOAD_PROBE_OUTPUT}"`,
].join("\n");
const DOWNLOAD_PROBE_COMMAND = `/bin/bash -c ${shellQuote(DOWNLOAD_PROBE_SCRIPT)}`;
const TRAFFIC_PROBE_SCRIPT = [
  "import http.server,json,os",
  "class Handler(http.server.BaseHTTPRequestHandler):",
  " def do_GET(self):",
  "  headers={name.lower():value for name,value in self.headers.items()}",
  "  body=json.dumps({",
  `   "trafficHeaderPresent":"${TRAFFIC_ACCESS_HEADER}" in headers,`,
  '   "relayMetadataPresent":any(name.startswith("x-quillra-relay-") for name in headers),',
  '   "host":headers.get("host"),',
  '   "origin":headers.get("origin"),',
  '   "forwardedHost":headers.get("x-forwarded-host"),',
  '   "forwardedProto":headers.get("x-forwarded-proto"),',
  '   "forwardedPort":headers.get("x-forwarded-port"),',
  '   "uid":os.getuid(),',
  '   "gid":os.getgid(),',
  '  },separators=(",",":")).encode()',
  "  self.send_response(200)",
  '  self.send_header("content-type","application/json")',
  '  self.send_header("content-length",str(len(body)))',
  "  self.end_headers()",
  "  self.wfile.write(body)",
  " def log_message(self,*args):",
  "  pass",
  `http.server.ThreadingHTTPServer(("127.0.0.1",${TRAFFIC_PROBE_PORT}),Handler).serve_forever()`,
].join("\n");
const TRAFFIC_PROBE_COMMAND = `/usr/bin/python3 -I -S -c ${shellQuote(TRAFFIC_PROBE_SCRIPT)}`;

export type E2bVerificationInput = {
  apiKey: string;
  templateId?: string;
};

export type E2bVerificationStageStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type E2bVerificationStage = {
  id: string;
  status: E2bVerificationStageStatus;
  message?: string;
  detail?: string;
};

export type E2bVerificationLog = {
  level: "info" | "success" | "warning" | "error";
  message: string;
};

export type E2bVerificationReport = {
  failedStage?: string;
  stages: E2bVerificationStage[];
  logs: E2bVerificationLog[];
};

const VERIFICATION_STAGE_DEFINITIONS = [
  { id: "provider", message: "Connect to E2B" },
  { id: "sandbox", message: "Create a sandbox and check required downloads" },
  { id: "prerequisite", message: "Check the secure runtime" },
  { id: "relay", message: "Start the private preview relay" },
  { id: "traffic-server", message: "Start the isolated test service" },
  { id: "protected-ingress", message: "Check authenticated private ingress" },
  { id: "payload", message: "Confirm credentials stay outside project code" },
  {
    id: "unauthenticated-access",
    message: "Reject unauthenticated preview traffic",
  },
  { id: "cleanup", message: "Remove the test sandbox" },
] as const;

type VerificationStageId = (typeof VERIFICATION_STAGE_DEFINITIONS)[number]["id"];

class VerificationReportBuilder {
  private readonly startedAt = Date.now();
  private readonly stageById = new Map<VerificationStageId, E2bVerificationStage>(
    VERIFICATION_STAGE_DEFINITIONS.map((stage) => [
      stage.id,
      { ...stage, status: "pending" as const },
    ]),
  );
  private readonly logs: E2bVerificationLog[] = [];
  private failedStage: VerificationStageId | undefined;

  start(id: VerificationStageId, detail?: string): void {
    this.update(id, "running", detail);
    this.note("info", `${this.stageLabel(id)} started.`);
  }

  pass(id: VerificationStageId, detail?: string): void {
    this.update(id, "passed", detail);
    this.note("success", `${this.stageLabel(id)} passed${detail ? `: ${detail}` : "."}`);
  }

  fail(id: VerificationStageId, detail?: string): void {
    this.failedStage = id;
    this.update(id, "failed", detail);
    this.note("error", `${this.stageLabel(id)} failed${detail ? `: ${detail}` : "."}`);
  }

  note(level: E2bVerificationLog["level"], message: string): void {
    const elapsedSeconds = ((Date.now() - this.startedAt) / 1_000).toFixed(1);
    this.logs.push({ level, message: `${elapsedSeconds}s ${message}` });
  }

  activeStage(): VerificationStageId | undefined {
    return [...this.stageById].find(([, stage]) => stage.status === "running")?.[0];
  }

  skipPending(except: VerificationStageId[] = []): void {
    const preserved = new Set(except);
    for (const [id, stage] of this.stageById) {
      if (stage.status === "pending" && !preserved.has(id)) {
        this.stageById.set(id, { ...stage, status: "skipped" });
      }
    }
  }

  report(failedStage = this.failedStage): E2bVerificationReport {
    return {
      ...(failedStage ? { failedStage } : {}),
      stages: VERIFICATION_STAGE_DEFINITIONS.map(({ id }) => ({
        ...(this.stageById.get(id) as E2bVerificationStage),
      })),
      logs: [...this.logs],
    };
  }

  private update(
    id: VerificationStageId,
    status: E2bVerificationStageStatus,
    detail?: string,
  ): void {
    const current = this.stageById.get(id);
    if (!current) return;
    this.stageById.set(id, {
      ...current,
      status,
      ...(detail ? { detail } : {}),
    });
  }

  private stageLabel(id: VerificationStageId): string {
    return this.stageById.get(id)?.message ?? id;
  }
}

type VerificationSandbox = Pick<
  E2BSandboxHandle,
  | "trafficAccessToken"
  | "prepareExecutionEnvironment"
  | "startPreviewRelay"
  | "startCommand"
  | "getHost"
  | "kill"
>;

export type E2bSandboxFactory = (input: E2bVerificationInput) => Promise<VerificationSandbox>;

class VerificationProbeFailure extends Error {
  constructor(
    readonly stage: VerificationStageId,
    readonly safeDetail: string,
  ) {
    super("The fixed E2B verification probe failed.");
    this.name = "VerificationProbeFailure";
  }
}

export class E2bVerificationError extends Error {
  readonly code: "unavailable" | "probe-failed" | "cleanup-failed";
  readonly verification: E2bVerificationReport;

  constructor(code: E2bVerificationError["code"], verification?: E2bVerificationReport) {
    const message =
      code === "cleanup-failed"
        ? "The E2B test sandbox could not be removed. Try again before saving."
        : code === "probe-failed"
          ? "E2B started a sandbox, but the secure execution check failed."
          : "E2B could not verify this API key and template.";
    super(message);
    this.name = "E2bVerificationError";
    this.code = code;
    this.verification = verification ?? { stages: [], logs: [] };
  }
}

const createVerificationSandbox: E2bSandboxFactory = async ({ apiKey, templateId }) =>
  new E2BSdkAdapter().create({
    apiKey,
    templateId: templateId?.trim() || "base",
    projectId: "configuration-check",
    timeoutMs: PROBE_SANDBOX_TIMEOUT_MS,
    requestTimeoutMs: PROBE_REQUEST_TIMEOUT_MS,
    lifecycle: { onTimeout: "kill" },
    allowInternetAccess: true,
  });

function trustedEnvironmentStage(error: E2BTrustedEnvironmentError): VerificationStageId {
  return error.stage === "bootstrap" || error.stage === "project-isolation"
    ? "prerequisite"
    : "relay";
}

function trustedEnvironmentDetail(error: E2BTrustedEnvironmentError): string {
  switch (error.stage) {
    case "bootstrap":
      return "The selected template is missing a locked-user or relay prerequisite.";
    case "project-isolation":
      return "The project process did not satisfy the non-root isolation policy.";
    case "relay-target":
      return "The fixed preview target port was rejected.";
    case "relay-ready":
      return "The private relay did not become ready before the bounded timeout.";
    default:
      return "The trusted preview relay could not be prepared safely.";
  }
}

function providerFailureDetail(error: unknown): string {
  if (error instanceof AuthenticationError) {
    return "E2B rejected the API credential.";
  }
  if (error instanceof NotFoundError || error instanceof TemplateError) {
    return "The selected E2B template was not found or is incompatible.";
  }
  if (error instanceof RateLimitError) {
    return "E2B rate-limited the verification request. Wait briefly and retry.";
  }
  if (error instanceof TimeoutError) {
    return "E2B did not finish sandbox creation before the bounded timeout.";
  }
  return "The E2B provider request failed without exposing its response.";
}

function assertProbeCommandResult(
  result: { exitCode: number; stdout: string },
  stage: VerificationStageId,
  expectedOutput = PROBE_OUTPUT,
): void {
  if (result.exitCode !== 0) {
    throw new VerificationProbeFailure(stage, `Fixed command exited with code ${result.exitCode}.`);
  }
  if (result.stdout !== expectedOutput) {
    throw new VerificationProbeFailure(stage, "Fixed command returned an unexpected marker.");
  }
}

function isPrivateIngressRejection(status: number): boolean {
  return status === 401 || status === 403;
}

function fetchRejectedWebSocket(
  url: string,
  headers: Record<string, string> | undefined,
  credentialDescription: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url, {
      ...(headers ? { headers } : {}),
      followRedirects: false,
      handshakeTimeout: PROBE_HTTP_TIMEOUT_MS,
      maxPayload: PROBE_HTTP_BODY_LIMIT_BYTES,
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(
        new VerificationProbeFailure(
          "unauthenticated-access",
          `The ${credentialDescription} WebSocket request did not return a bounded authentication response.`,
        ),
      );
    }, PROBE_HTTP_TIMEOUT_MS);

    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };

    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      finish(() => {
        const status = response.statusCode ?? 0;
        if (isPrivateIngressRejection(status)) {
          resolve(status);
          return;
        }
        reject(
          new VerificationProbeFailure(
            "unauthenticated-access",
            `The ${credentialDescription} WebSocket request returned unexpected HTTP ${status}.`,
          ),
        );
      });
    });
    socket.once("open", () => {
      finish(() => {
        socket.terminate();
        reject(
          new VerificationProbeFailure(
            "unauthenticated-access",
            `Private WebSocket ingress accepted the ${credentialDescription} credential.`,
          ),
        );
      });
    });
    socket.once("error", () => {
      finish(() =>
        reject(
          new VerificationProbeFailure(
            "unauthenticated-access",
            `The ${credentialDescription} WebSocket request could not be evaluated.`,
          ),
        ),
      );
    });
  });
}

async function readBoundedJson(response: Response, stage: VerificationStageId): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new VerificationProbeFailure(stage, "Protected endpoint did not return JSON.");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > PROBE_HTTP_BODY_LIMIT_BYTES)
  ) {
    throw new VerificationProbeFailure(stage, "Protected response exceeded the safe size limit.");
  }
  if (!response.body) {
    throw new VerificationProbeFailure(stage, "Protected endpoint returned an empty response.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > PROBE_HTTP_BODY_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new VerificationProbeFailure(
          stage,
          "Protected response exceeded the safe size limit.",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof VerificationProbeFailure) throw error;
    throw new VerificationProbeFailure(stage, "Protected endpoint returned invalid JSON.");
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateProbePayload(value: unknown): void {
  if (
    !isRecord(value) ||
    value.trafficHeaderPresent !== false ||
    value.relayMetadataPresent !== false ||
    !Number.isSafeInteger(value.uid) ||
    Number(value.uid) <= 0 ||
    !Number.isSafeInteger(value.gid) ||
    Number(value.gid) <= 0 ||
    value.host !== PROBE_PUBLIC_HOST ||
    value.origin !== PROBE_PUBLIC_ORIGIN ||
    value.forwardedHost !== PROBE_PUBLIC_HOST ||
    value.forwardedProto !== "https" ||
    value.forwardedPort !== "443"
  ) {
    throw new VerificationProbeFailure(
      "payload",
      "Project code observed credentials, unsafe forwarding metadata, or a privileged identity.",
    );
  }
}

async function fetchProtectedTrafficProbe(
  sandbox: VerificationSandbox,
  report: VerificationReportBuilder,
): Promise<void> {
  const token = sandbox.trafficAccessToken?.trim();
  if (!token) {
    throw new VerificationProbeFailure(
      "protected-ingress",
      "E2B did not issue a private traffic credential.",
    );
  }
  const url = `https://${sandbox.getHost(E2B_PREVIEW_RELAY_PORT)}/`;
  const deadline = Date.now() + PROBE_READY_TIMEOUT_MS;
  let protectedResponse: Response | undefined;

  report.start("protected-ingress");
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: {
          [TRAFFIC_ACCESS_HEADER]: token,
          "x-quillra-relay-host": PROBE_PUBLIC_HOST,
          "x-quillra-relay-origin": PROBE_PUBLIC_ORIGIN,
          "x-quillra-relay-port": "443",
          "x-quillra-relay-proto": "https",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_HTTP_TIMEOUT_MS),
      });
      if (response.ok) {
        protectedResponse = response;
        break;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // The project service may still be starting. Retry only within the
      // bounded readiness window and never expose the provider response.
    }
    await delay(200);
  }
  if (!protectedResponse) {
    throw new VerificationProbeFailure(
      "protected-ingress",
      "No successful protected response arrived before the bounded timeout.",
    );
  }
  report.pass("protected-ingress", `Protected endpoint returned HTTP ${protectedResponse.status}.`);

  report.start("payload");
  const payload = await readBoundedJson(protectedResponse, "payload");
  validateProbePayload(payload);
  report.pass(
    "payload",
    "Project code ran non-root and received neither provider credentials nor relay metadata.",
  );

  report.start("unauthenticated-access");
  let missingResponse: Response;
  let incorrectResponse: Response;
  try {
    missingResponse = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_HTTP_TIMEOUT_MS),
    });
    incorrectResponse = await fetch(url, {
      headers: {
        [TRAFFIC_ACCESS_HEADER]: "quillra-invalid-traffic-credential",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new VerificationProbeFailure(
      "unauthenticated-access",
      "A bounded unauthenticated request could not be evaluated.",
    );
  }
  const missingStatus = missingResponse.status;
  const incorrectStatus = incorrectResponse.status;
  await missingResponse.body?.cancel().catch(() => undefined);
  await incorrectResponse.body?.cancel().catch(() => undefined);
  if (!isPrivateIngressRejection(missingStatus) || !isPrivateIngressRejection(incorrectStatus)) {
    throw new VerificationProbeFailure(
      "unauthenticated-access",
      `Private HTTP ingress returned unexpected authentication status ${missingStatus} or ${incorrectStatus}.`,
    );
  }

  const websocketUrl = url.replace(/^https:/, "wss:");
  const missingWebSocketStatus = await fetchRejectedWebSocket(websocketUrl, undefined, "missing");
  const incorrectWebSocketStatus = await fetchRejectedWebSocket(
    websocketUrl,
    { [TRAFFIC_ACCESS_HEADER]: "quillra-invalid-traffic-credential" },
    "incorrect",
  );
  report.pass(
    "unauthenticated-access",
    `Missing and incorrect credentials were rejected for HTTP (${missingStatus}/${incorrectStatus}) and WebSocket (${missingWebSocketStatus}/${incorrectWebSocketStatus}).`,
  );
}

/**
 * Prove the key and optional template by creating the same network-enabled,
 * ingress-protected sandbox used for projects. The bounded download probe
 * checks only the fixed Node.js distribution and npm registry endpoints that
 * runtime bootstrap needs. E2B validates the public traffic credential;
 * Quillra's separate relay user removes it before forwarding to non-root
 * project code on loopback.
 */
export async function verifyE2bConfiguration(
  input: E2bVerificationInput,
  createSandbox: E2bSandboxFactory = createVerificationSandbox,
): Promise<E2bVerificationReport> {
  const report = new VerificationReportBuilder();
  let sandbox: VerificationSandbox | undefined;
  let trafficProcess: E2BProcess | undefined;
  let verificationFailure:
    | {
        code: "unavailable" | "probe-failed";
        stage: VerificationStageId;
        detail: string;
      }
    | undefined;
  let adapterCleanupStatus: "confirmed" | "failed" | undefined;

  try {
    report.start("provider");
    sandbox = await createSandbox(input);
    report.pass("provider", "The API key and template were accepted.");

    report.start("sandbox");
    const downloadProcess = await sandbox.startCommand(DOWNLOAD_PROBE_COMMAND, {
      cwd: E2B_PROJECT_HOME,
      timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 1_024,
    });
    const downloadResult = await downloadProcess.wait();
    assertProbeCommandResult(downloadResult, "sandbox", DOWNLOAD_PROBE_OUTPUT);
    report.pass(
      "sandbox",
      "The isolated test sandbox reached the required Node.js and npm HTTPS download endpoints.",
    );

    report.start("prerequisite");
    await sandbox.prepareExecutionEnvironment();
    const prerequisiteProcess = await sandbox.startCommand(PREREQUISITE_PROBE_COMMAND, {
      cwd: E2B_PROJECT_HOME,
      timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 1_024,
    });
    const prerequisiteResult = await prerequisiteProcess.wait();
    assertProbeCommandResult(prerequisiteResult, "prerequisite");
    report.pass(
      "prerequisite",
      `Locked non-root project user, ${REQUIRED_RUNTIME_TOOLS.length} fixed tools, and Node/npm/Git verified.`,
    );

    report.start("relay");
    await sandbox.startPreviewRelay(TRAFFIC_PROBE_PORT);
    report.pass(
      "relay",
      `Root-installed relay is listening on the fixed public port ${E2B_PREVIEW_RELAY_PORT}.`,
    );

    report.start("traffic-server");
    trafficProcess = await sandbox.startCommand(TRAFFIC_PROBE_COMMAND, {
      cwd: E2B_PROJECT_HOME,
      timeoutMs: PROBE_SANDBOX_TIMEOUT_MS,
      maxOutputBytes: 1_024,
    });
    report.pass(
      "traffic-server",
      `Non-root test service was started on loopback port ${TRAFFIC_PROBE_PORT}.`,
    );

    await fetchProtectedTrafficProbe(sandbox, report);
  } catch (error) {
    let stage = report.activeStage() ?? (sandbox ? "prerequisite" : "provider");
    let detail = "The bounded verification operation did not complete.";
    let code: "unavailable" | "probe-failed" = sandbox ? "probe-failed" : "unavailable";

    if (error instanceof VerificationProbeFailure) {
      stage = error.stage;
      detail = error.safeDetail;
      code = "probe-failed";
    } else if (error instanceof E2BTrustedEnvironmentError) {
      stage = trustedEnvironmentStage(error);
      detail = trustedEnvironmentDetail(error);
      code = "probe-failed";
      if (!sandbox) {
        // This sanitized adapter error is only emitted after E2B created the
        // sandbox and attempted trusted bootstrapping. The adapter removes it
        // before propagating the error. Provider acceptance is known, but the
        // active download-reachability probe has not run, so the sandbox stage
        // must not pass.
        report.pass("provider", "The API key and template were accepted.");
        adapterCleanupStatus = error.cleanupStatus;
      }
    } else if (!sandbox) {
      detail = providerFailureDetail(error);
    }

    report.fail(stage, detail);
    verificationFailure = { code, stage, detail };
  }

  if (sandbox) {
    report.start("cleanup");
    await trafficProcess?.kill().catch(() => false);
    try {
      // E2B returns false when the sandbox is already absent. Both resolved
      // boolean values are confirmed terminal states; only rejection leaves
      // cleanup unconfirmed.
      await sandbox.kill();
      report.pass("cleanup", "E2B confirmed removal of the test sandbox.");
    } catch {
      report.fail("cleanup", "E2B did not confirm removal of the test sandbox.");
      report.skipPending();
      throw new E2bVerificationError("cleanup-failed", report.report("cleanup"));
    }
  } else if (adapterCleanupStatus) {
    report.start("cleanup");
    if (adapterCleanupStatus === "confirmed") {
      report.pass("cleanup", "E2B confirmed removal of the test sandbox.");
    } else {
      report.fail("cleanup", "E2B did not confirm removal of the test sandbox.");
      report.skipPending();
      throw new E2bVerificationError("cleanup-failed", report.report("cleanup"));
    }
  } else {
    report.skipPending();
  }

  if (verificationFailure) {
    report.skipPending();
    throw new E2bVerificationError(verificationFailure.code, report.report());
  }
  report.skipPending();
  return report.report();
}
