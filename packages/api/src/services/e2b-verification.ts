import { setTimeout as delay } from "node:timers/promises";
import { Sandbox } from "e2b";

const PROBE_OUTPUT = "quillra-e2b-ok";
const TRAFFIC_ACCESS_HEADER = "e2b-traffic-access-token";
const TRAFFIC_PROBE_PORT = 49_177;
const PROBE_SANDBOX_TIMEOUT_MS = 60_000;
const PROBE_REQUEST_TIMEOUT_MS = 20_000;
const PROBE_COMMAND_TIMEOUT_MS = 10_000;
const PROBE_HTTP_TIMEOUT_MS = 5_000;
const PROBE_READY_TIMEOUT_MS = 15_000;
const PROBE_HTTP_BODY_LIMIT_BYTES = 4 * 1024;
const REQUIRED_RUNTIME_TOOLS = [
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
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

const PREREQUISITE_PROBE_SCRIPT = [
  "set -eu",
  `for quillra_tool in ${REQUIRED_RUNTIME_TOOLS.join(" ")}; do`,
  '  [ -x "$quillra_tool" ]',
  "done",
  `/usr/bin/python3 -I -S -c 'import base64,http.server,json,os,stat,sys;sys.stdout.write("${PROBE_OUTPUT}")'`,
].join("\n");
const PREREQUISITE_PROBE_COMMAND = `/bin/bash -c ${shellQuote(PREREQUISITE_PROBE_SCRIPT)}`;
const TRAFFIC_PROBE_SCRIPT = [
  "import http.server,json",
  "class Handler(http.server.BaseHTTPRequestHandler):",
  " def do_GET(self):",
  `  present=any(name.lower()=="${TRAFFIC_ACCESS_HEADER}" for name in self.headers)`,
  '  body=json.dumps({"trafficHeaderPresent":present},separators=(",",":")).encode()',
  "  self.send_response(200)",
  '  self.send_header("content-type","application/json")',
  '  self.send_header("content-length",str(len(body)))',
  "  self.end_headers()",
  "  self.wfile.write(body)",
  " def log_message(self,*args):",
  "  pass",
  `http.server.ThreadingHTTPServer(("0.0.0.0",${TRAFFIC_PROBE_PORT}),Handler).serve_forever()`,
].join("\n");
const TRAFFIC_PROBE_PROCESS = `/usr/bin/python3 -I -S -c ${shellQuote(TRAFFIC_PROBE_SCRIPT)}`;
const TRAFFIC_PROBE_COMMAND = `/usr/bin/setsid --fork /bin/bash -c ${shellQuote(`exec ${TRAFFIC_PROBE_PROCESS}`)} </dev/null >/dev/null 2>&1`;

export type E2bVerificationInput = {
  apiKey: string;
  templateId?: string;
};

type VerificationSandbox = {
  trafficAccessToken?: string;
  getHost(port: number): string;
  commands: {
    run(
      command: string,
      options: { timeoutMs: number },
    ): Promise<{ exitCode: number; stdout: string }>;
  };
  kill(options: { requestTimeoutMs: number }): Promise<boolean>;
};

export type E2bSandboxFactory = (input: E2bVerificationInput) => Promise<VerificationSandbox>;

export class E2bVerificationError extends Error {
  readonly code: "unavailable" | "probe-failed" | "cleanup-failed";

  constructor(code: E2bVerificationError["code"]) {
    const message =
      code === "cleanup-failed"
        ? "The E2B test sandbox could not be removed. Try again before saving."
        : code === "probe-failed"
          ? "E2B started a sandbox, but the secure execution check failed."
          : "E2B could not verify this API key and template.";
    super(message);
    this.name = "E2bVerificationError";
    this.code = code;
  }
}

const createVerificationSandbox: E2bSandboxFactory = async ({ apiKey, templateId }) => {
  const options = {
    apiKey,
    timeoutMs: PROBE_SANDBOX_TIMEOUT_MS,
    requestTimeoutMs: PROBE_REQUEST_TIMEOUT_MS,
    lifecycle: { onTimeout: "kill" as const },
    secure: true,
    allowInternetAccess: false,
    network: { allowPublicTraffic: false },
    metadata: { purpose: "quillra-configuration-check" },
  };
  return templateId ? Sandbox.create(templateId, options) : Sandbox.create(options);
};

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > PROBE_HTTP_BODY_LIMIT_BYTES)
  ) {
    throw new E2bVerificationError("probe-failed");
  }
  if (!response.body) throw new E2bVerificationError("probe-failed");

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
        throw new E2bVerificationError("probe-failed");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof E2bVerificationError) throw error;
    throw new E2bVerificationError("probe-failed");
  } finally {
    reader.releaseLock();
  }
}

async function fetchProtectedTrafficProbe(sandbox: VerificationSandbox): Promise<void> {
  const token = sandbox.trafficAccessToken?.trim();
  if (!token) throw new E2bVerificationError("probe-failed");
  const url = `https://${sandbox.getHost(TRAFFIC_PROBE_PORT)}/`;
  const deadline = Date.now() + PROBE_READY_TIMEOUT_MS;
  let protectedResponse: Response | undefined;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { [TRAFFIC_ACCESS_HEADER]: token },
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_HTTP_TIMEOUT_MS),
      });
      if (response.ok) {
        protectedResponse = response;
        break;
      }
    } catch {
      // The fixed server may still be starting. Retry only within the bounded
      // readiness window; the overall sandbox timeout remains the final guard.
    }
    await delay(200);
  }
  if (!protectedResponse) throw new E2bVerificationError("probe-failed");

  const payload = (await readBoundedJson(protectedResponse)) as {
    trafficHeaderPresent?: unknown;
  } | null;
  if (payload?.trafficHeaderPresent !== false) {
    throw new E2bVerificationError("probe-failed");
  }

  let unauthenticatedResponse: Response;
  try {
    unauthenticatedResponse = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new E2bVerificationError("probe-failed");
  }
  if (unauthenticatedResponse.ok) {
    throw new E2bVerificationError("probe-failed");
  }
}

/**
 * Prove that both the credential and optional template work by creating an
 * isolated, network-closed sandbox and running fixed probes. The HTTP probe
 * also proves that E2B protects private hosts and strips its traffic credential
 * before the request reaches project code. The API key is passed only as an SDK
 * option, never as a sandbox environment variable.
 */
export async function verifyE2bConfiguration(
  input: E2bVerificationInput,
  createSandbox: E2bSandboxFactory = createVerificationSandbox,
): Promise<void> {
  let sandbox: VerificationSandbox | undefined;
  let verificationFailure: E2bVerificationError | undefined;

  try {
    sandbox = await createSandbox(input);
    const result = await sandbox.commands.run(PREREQUISITE_PROBE_COMMAND, {
      timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.stdout !== PROBE_OUTPUT) {
      throw new E2bVerificationError("probe-failed");
    }
    const server = await sandbox.commands.run(TRAFFIC_PROBE_COMMAND, {
      timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
    });
    if (server.exitCode !== 0) throw new E2bVerificationError("probe-failed");
    await fetchProtectedTrafficProbe(sandbox);
  } catch (error) {
    verificationFailure =
      error instanceof E2bVerificationError
        ? error
        : new E2bVerificationError(sandbox ? "probe-failed" : "unavailable");
  }

  if (sandbox) {
    try {
      const removed = await sandbox.kill({ requestTimeoutMs: PROBE_REQUEST_TIMEOUT_MS });
      if (!removed) throw new Error("E2B did not confirm sandbox removal.");
    } catch {
      throw new E2bVerificationError("cleanup-failed");
    }
  }

  if (verificationFailure) throw verificationFailure;
}
