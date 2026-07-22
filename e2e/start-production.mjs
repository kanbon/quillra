import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSafeChildEnv } from "../packages/api/dist/services/child-process-env.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.QUILLRA_E2E_PORT ?? "3417");
const smtpPort = Number(process.env.QUILLRA_E2E_SMTP_PORT ?? String(port + 1));

if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(`Invalid QUILLRA_E2E_PORT: ${process.env.QUILLRA_E2E_PORT ?? "3417"}`);
}
if (!Number.isInteger(smtpPort) || smtpPort < 1024 || smtpPort > 65_535 || smtpPort === port) {
  throw new Error(`Invalid QUILLRA_E2E_SMTP_PORT: ${smtpPort}`);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "quillra-e2e-"));
const databasePath = path.join(dataDir, "cms.sqlite");
const workspaceDir = path.join(dataDir, "workspaces");
const origin = `http://localhost:${port}`;
const mailboxPath = path.join(tmpdir(), `quillra-e2e-mailbox-${port}.jsonl`);
rmSync(mailboxPath, { force: true });

const smtpServer = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.write("220 quillra-e2e ESMTP\r\n");
  let buffer = "";
  let message = "";
  let readingData = false;

  function respondToCommand(line) {
    const command = line.split(/\s+/, 1)[0]?.toUpperCase();
    if (command === "EHLO" || command === "HELO") {
      socket.write("250-quillra-e2e\r\n250 8BITMIME\r\n");
    } else if (command === "MAIL" || command === "RCPT" || command === "RSET") {
      socket.write("250 OK\r\n");
    } else if (command === "DATA") {
      message = "";
      readingData = true;
      socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
    } else if (command === "NOOP") {
      socket.write("250 OK\r\n");
    } else if (command === "QUIT") {
      socket.end("221 Bye\r\n");
    } else {
      socket.write("250 OK\r\n");
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.length > 0) {
      if (readingData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end === -1) return;
        message += buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        appendFileSync(
          mailboxPath,
          `${JSON.stringify({ receivedAt: Date.now(), raw: message })}\n`,
        );
        readingData = false;
        socket.write("250 queued\r\n");
        continue;
      }

      const end = buffer.indexOf("\r\n");
      if (end === -1) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      respondToCommand(line);
    }
  });
});

await new Promise((resolve, reject) => {
  smtpServer.once("error", reject);
  smtpServer.listen(smtpPort, "127.0.0.1", () => {
    smtpServer.off("error", reject);
    resolve();
  });
});

const appEnvironment = createSafeChildEnv();
Object.assign(appEnvironment, {
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  PORT: String(port),
  DATABASE_URL: `file:${databasePath}`,
  WORKSPACE_DIR: workspaceDir,
  BETTER_AUTH_URL: origin,
  TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "quillra-e2e-session-secret-not-for-production",
  QUILLRA_ENCRYPTION_KEY: "ab".repeat(32),
  QUILLRA_SETUP_TOKEN: "quillra-e2e-setup-token",
  EMAIL_PROVIDER: "none",
  GITHUB_APP_ID: "1000001",
  GITHUB_APP_NAME: "Quillra E2E",
  // Setup only checks that a key is configured. The test never invokes a
  // GitHub operation, so an invalid sentinel keeps accidental network use
  // impossible and obvious.
  GITHUB_APP_PRIVATE_KEY: "quillra-e2e-private-key-sentinel",
});

function cleanup() {
  smtpServer.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(mailboxPath, { force: true });
}

const api = spawn(process.execPath, ["packages/api/dist/index.js"], {
  cwd: repoRoot,
  env: appEnvironment,
  stdio: ["ignore", "inherit", "inherit"],
});

let stopping = false;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (api.exitCode === null && api.signalCode === null) api.kill(signal);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGHUP", () => stop("SIGHUP"));

api.once("error", (error) => {
  console.error("[e2e] Failed to launch the production API", error);
  cleanup();
  process.exit(1);
});

api.once("exit", (code, signal) => {
  cleanup();
  if (!stopping) {
    console.error(`[e2e] Production API exited unexpectedly (${signal ?? code ?? "unknown"})`);
  }
  process.exit(stopping ? 0 : (code ?? 1));
});
