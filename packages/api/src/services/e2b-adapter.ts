import { randomUUID } from "node:crypto";
import path from "node:path";
import { CommandExitError, FileType, Sandbox, SandboxNotFoundError, type SandboxOpts } from "e2b";

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const ABSOLUTE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROCESS_LOG_ROOT = "/home/user/.quillra-processes";
const MAX_FILE_CHUNK_BYTES = 256 * 1024;
const ABSOLUTE_MAX_DIRECTORY_ENTRIES = 20_000;
const ABSOLUTE_MAX_DIRECTORY_OUTPUT_BYTES = 4 * 1024 * 1024;
const TRUSTED_CONTROL_PATH = "/usr/bin:/bin";
const TRUSTED_BASH = "/bin/bash";
const TRUSTED_RM = "/bin/rm";
const TRUSTED_BASE64 = "/usr/bin/base64";
const TRUSTED_CAT = "/usr/bin/cat";
const TRUSTED_DD = "/usr/bin/dd";
const TRUSTED_HEAD = "/usr/bin/head";
const TRUSTED_KILL = "/usr/bin/kill";
const TRUSTED_MKFIFO = "/usr/bin/mkfifo";
const TRUSTED_PYTHON = "/usr/bin/python3";
const TRUSTED_SETSID = "/usr/bin/setsid";

export type E2BRemoteEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "special";
  size: number;
  mode: number;
  symlinkTarget?: string;
};

export type E2BCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export type E2BProcess = {
  pid: number;
  wait(): Promise<E2BCommandResult>;
  kill(): Promise<boolean>;
};

export type E2BCommandOptions = {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  envs?: Record<string, string>;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
};

export interface E2BSandboxHandle {
  readonly sandboxId: string;
  readonly trafficAccessToken?: string;

  list(
    path: string,
    options: {
      maxEntries: number;
      maxOutputBytes: number;
      signal?: AbortSignal;
    },
  ): Promise<E2BRemoteEntry[]>;
  getInfo(path: string, signal?: AbortSignal): Promise<E2BRemoteEntry>;
  readFileChunk(
    path: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  writeFiles(files: Array<{ path: string; data: Uint8Array }>, signal?: AbortSignal): Promise<void>;
  makeDir(path: string, signal?: AbortSignal): Promise<void>;
  exists(path: string, signal?: AbortSignal): Promise<boolean>;
  remove(path: string, signal?: AbortSignal): Promise<void>;
  rename(from: string, to: string, signal?: AbortSignal): Promise<void>;
  startCommand(command: string, options: E2BCommandOptions): Promise<E2BProcess>;
  killProcess(pid: number, signal?: AbortSignal): Promise<boolean>;
  getHost(port: number): string;
  pause(signal?: AbortSignal): Promise<boolean>;
  kill(signal?: AbortSignal): Promise<boolean>;
}

export type E2BCreateOptions = {
  apiKey: string;
  templateId: string;
  projectId: string;
  timeoutMs: number;
  requestTimeoutMs: number;
  signal?: AbortSignal;
};

export type E2BConnectOptions = {
  apiKey: string;
  timeoutMs: number;
  requestTimeoutMs: number;
  signal?: AbortSignal;
};

export interface E2BAdapter {
  create(options: E2BCreateOptions): Promise<E2BSandboxHandle>;
  connect(sandboxId: string, options: E2BConnectOptions): Promise<E2BSandboxHandle>;
  destroy(
    sandboxId: string,
    options: Pick<E2BConnectOptions, "apiKey" | "requestTimeoutMs" | "signal">,
  ): Promise<boolean>;
  isNotFound(error: unknown): boolean;
}

function toRemoteEntry(entry: {
  name: string;
  path: string;
  type?: FileType;
  size: number;
  mode: number;
  symlinkTarget?: string;
}): E2BRemoteEntry {
  if (entry.type !== FileType.FILE && entry.type !== FileType.DIR) {
    throw new Error(`E2B returned an unsupported filesystem entry type for ${entry.path}.`);
  }
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    size: entry.size,
    mode: entry.mode,
    symlinkTarget: entry.symlinkTarget,
  };
}

function normalizeCommandFailure(error: unknown): E2BCommandResult | null {
  if (error instanceof CommandExitError) {
    return {
      exitCode: error.exitCode,
      stdout: error.stdout,
      stderr: error.stderr,
      error: error.error,
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof error.exitCode === "number" &&
    "stdout" in error &&
    typeof error.stdout === "string" &&
    "stderr" in error &&
    typeof error.stderr === "string"
  ) {
    return {
      exitCode: error.exitCode,
      stdout: error.stdout,
      stderr: error.stderr,
      error: "error" in error && typeof error.error === "string" ? error.error : undefined,
    };
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

const BOUNDED_DIRECTORY_SCANNER = [
  "import base64,json,os,stat,sys",
  "def emit(value):",
  ' sys.stdout.write(json.dumps(value,separators=(",",":")))',
  "try:",
  " root=sys.argv[1]",
  " max_entries=int(sys.argv[2])",
  " max_bytes=int(sys.argv[3])",
  " entries=[]",
  " encoded_bytes=24",
  " root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
  " try:",
  "  with os.scandir(root_fd) as iterator:",
  "   for entry in iterator:",
  "    if len(entries)>=max_entries:",
  '     emit({"ok":False,"error":"entry_limit"})',
  "     sys.exit(0)",
  "    info=entry.stat(follow_symlinks=False)",
  "    mode=info.st_mode",
  "    link=None",
  "    if stat.S_ISLNK(mode):",
  '     kind="file"',
  "     link=base64.b64encode(os.fsencode(os.readlink(entry.name,dir_fd=root_fd))).decode('ascii')",
  "     size=0",
  "    elif stat.S_ISDIR(mode):",
  '     kind="dir"',
  "     size=0",
  "    elif stat.S_ISREG(mode):",
  '     kind="file"',
  "     size=info.st_size",
  "    else:",
  '     kind="special"',
  "     size=0",
  '    record={"n":base64.b64encode(os.fsencode(entry.name)).decode("ascii"),"t":kind,"s":size,"m":stat.S_IMODE(mode),"l":link}',
  '    encoded=json.dumps(record,separators=(",",":"))',
  "    encoded_bytes+=len(encoded.encode('utf-8'))+1",
  "    if encoded_bytes>max_bytes:",
  '     emit({"ok":False,"error":"byte_limit"})',
  "     sys.exit(0)",
  "    entries.append(record)",
  " finally:",
  "  os.close(root_fd)",
  ' emit({"ok":True,"entries":entries})',
  "except Exception:",
  ' emit({"ok":False,"error":"scan_failed"})',
].join("\n");

type DirectoryScannerResponse =
  | {
      ok: true;
      entries: Array<{
        n: string;
        t: "file" | "dir" | "special";
        s: number;
        m: number;
        l: string | null;
      }>;
    }
  | {
      ok: false;
      error: "entry_limit" | "byte_limit" | "scan_failed";
    };

function decodeFilesystemText(encoded: string, label: string): string {
  if (
    typeof encoded !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error(`E2B returned invalid base64 for ${label}.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error(`E2B returned non-canonical base64 for ${label}.`);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`E2B returned a non-UTF-8 ${label}.`);
  }
  if (decoded.includes("\0")) throw new Error(`E2B returned an invalid ${label}.`);
  return decoded;
}

function validateDirectoryListOptions(options: {
  maxEntries: number;
  maxOutputBytes: number;
}): void {
  if (
    !Number.isSafeInteger(options.maxEntries) ||
    options.maxEntries < 0 ||
    options.maxEntries > ABSOLUTE_MAX_DIRECTORY_ENTRIES
  ) {
    throw new Error("Invalid bounded E2B directory entry limit.");
  }
  if (
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < 256 ||
    options.maxOutputBytes > ABSOLUTE_MAX_DIRECTORY_OUTPUT_BYTES
  ) {
    throw new Error("Invalid bounded E2B directory byte limit.");
  }
}

function validateOutputLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ABSOLUTE_MAX_OUTPUT_BYTES) {
    throw new Error(`E2B output limit must be between 1 and ${ABSOLUTE_MAX_OUTPUT_BYTES} bytes.`);
  }
  return limit;
}

/**
 * The SDK CommandHandle stores every received chunk internally. Never attach
 * an untrusted command directly to that stream. A remote FIFO feeds `head`,
 * bounding both files before the SDK sees an intentionally empty stream.
 */
export function boundedCommandWrapper(input: {
  command: string;
  logDirectory: string;
  maxOutputBytes: number;
}): string {
  const stdoutFile = `${input.logDirectory}/stdout`;
  const stderrFile = `${input.logDirectory}/stderr`;
  const stdoutPipe = `${input.logDirectory}/stdout.pipe`;
  const stderrPipe = `${input.logDirectory}/stderr.pipe`;
  const script = [
    "set +e",
    `${TRUSTED_RM} -f -- ${shellQuote(stdoutPipe)} ${shellQuote(stderrPipe)}`,
    `${TRUSTED_MKFIFO} -- ${shellQuote(stdoutPipe)} ${shellQuote(stderrPipe)}`,
    `{ ${TRUSTED_HEAD} -c ${input.maxOutputBytes}; ${TRUSTED_CAT} >/dev/null; } < ${shellQuote(stdoutPipe)} > ${shellQuote(stdoutFile)} &`,
    "quillra_stdout_cap=$!",
    `{ ${TRUSTED_HEAD} -c ${input.maxOutputBytes}; ${TRUSTED_CAT} >/dev/null; } < ${shellQuote(stderrPipe)} > ${shellQuote(stderrFile)} &`,
    "quillra_stderr_cap=$!",
    `${TRUSTED_BASH} -c ${shellQuote(input.command)} > ${shellQuote(stdoutPipe)} 2> ${shellQuote(stderrPipe)}`,
    "quillra_status=$?",
    "wait $quillra_stdout_cap >/dev/null 2>&1 || true",
    "wait $quillra_stderr_cap >/dev/null 2>&1 || true",
    `${TRUSTED_RM} -f -- ${shellQuote(stdoutPipe)} ${shellQuote(stderrPipe)}`,
    "exit $quillra_status",
  ].join("\n");
  // The outer redirect is the memory-safety boundary: even setup failures do
  // not reach CommandHandle's unbounded internal stdout/stderr strings.
  return `exec ${TRUSTED_SETSID} ${TRUSTED_BASH} -c ${shellQuote(script)} >/dev/null 2>/dev/null`;
}

class SdkSandboxHandle implements E2BSandboxHandle {
  constructor(private readonly sandbox: Sandbox) {}

  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  get trafficAccessToken(): string | undefined {
    return this.sandbox.trafficAccessToken;
  }

  async list(
    directory: string,
    options: {
      maxEntries: number;
      maxOutputBytes: number;
      signal?: AbortSignal;
    },
  ): Promise<E2BRemoteEntry[]> {
    validateDirectoryListOptions(options);
    const result = await this.sandbox.commands.run(
      `${TRUSTED_PYTHON} -I -S -c ${shellQuote(BOUNDED_DIRECTORY_SCANNER)} ${shellQuote(directory)} ${options.maxEntries} ${options.maxOutputBytes} 2>/dev/null`,
      {
        timeoutMs: 10_000,
        requestTimeoutMs: 10_000,
        signal: options.signal,
        envs: { PATH: TRUSTED_CONTROL_PATH },
      },
    );
    if (Buffer.byteLength(result.stdout, "utf8") > options.maxOutputBytes) {
      throw new Error("E2B directory listing exceeded its hard byte limit.");
    }
    let payload: DirectoryScannerResponse;
    try {
      payload = JSON.parse(result.stdout) as DirectoryScannerResponse;
    } catch {
      throw new Error("E2B returned an invalid bounded directory listing.");
    }
    if (typeof payload !== "object" || payload === null || typeof payload.ok !== "boolean") {
      throw new Error("E2B returned an invalid bounded directory listing.");
    }
    if (!payload.ok) {
      if (
        payload.error !== "entry_limit" &&
        payload.error !== "byte_limit" &&
        payload.error !== "scan_failed"
      ) {
        throw new Error("E2B returned an invalid bounded directory listing.");
      }
      const message =
        payload.error === "entry_limit"
          ? "E2B directory exceeds the remaining workspace entry limit."
          : payload.error === "byte_limit"
            ? "E2B directory listing exceeds the hard byte limit."
            : "E2B directory could not be inspected safely.";
      throw new Error(message);
    }
    if (!Array.isArray(payload.entries) || payload.entries.length > options.maxEntries) {
      throw new Error("E2B directory listing exceeded its hard entry limit.");
    }
    return payload.entries.map((entry) => {
      if (
        !entry ||
        typeof entry.n !== "string" ||
        !["file", "dir", "special"].includes(entry.t) ||
        !Number.isSafeInteger(entry.s) ||
        entry.s < 0 ||
        !Number.isSafeInteger(entry.m) ||
        entry.m < 0 ||
        (entry.l !== null && typeof entry.l !== "string")
      ) {
        throw new Error("E2B returned invalid directory entry metadata.");
      }
      const name = decodeFilesystemText(entry.n, "filesystem name");
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
        throw new Error("E2B returned an unsafe filesystem name.");
      }
      const symlinkTarget =
        entry.l === null ? undefined : decodeFilesystemText(entry.l, "symbolic-link target");
      return {
        name,
        path: path.posix.join(path.posix.resolve(directory), name),
        type: entry.t,
        size: entry.s,
        mode: entry.m,
        symlinkTarget,
      };
    });
  }

  async getInfo(path: string, signal?: AbortSignal): Promise<E2BRemoteEntry> {
    return toRemoteEntry(await this.sandbox.files.getInfo(path, { signal }));
  }

  async readFileChunk(
    filePath: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_FILE_CHUNK_BYTES
    ) {
      throw new Error("Invalid bounded E2B file chunk request.");
    }
    // A sandbox process may replace a previously inspected file with a
    // symlink, FIFO, or infinite device. `dd` reads exactly one bounded chunk;
    // base64 keeps binary data intact while the SDK sees at most ~350 KiB.
    const result = await this.sandbox.commands.run(
      `${TRUSTED_DD} if=${shellQuote(filePath)} iflag=skip_bytes,count_bytes skip=${offset} count=${length} status=none 2>/dev/null | ${TRUSTED_BASE64}`,
      {
        timeoutMs: 10_000,
        requestTimeoutMs: 10_000,
        signal,
        envs: { PATH: TRUSTED_CONTROL_PATH },
      },
    );
    const decoded = Buffer.from(result.stdout.replaceAll(/\s/g, ""), "base64");
    if (decoded.byteLength > length) {
      throw new Error("E2B returned more file data than requested.");
    }
    return Uint8Array.from(decoded);
  }

  async writeFiles(
    files: Array<{ path: string; data: Uint8Array }>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (files.length === 0) return;
    await this.sandbox.files.write(
      files.map((file) => ({
        path: file.path,
        data: Uint8Array.from(file.data).buffer,
      })),
      { gzip: true, signal },
    );
  }

  async makeDir(path: string, signal?: AbortSignal): Promise<void> {
    await this.sandbox.files.makeDir(path, { signal });
  }

  exists(path: string, signal?: AbortSignal): Promise<boolean> {
    return this.sandbox.files.exists(path, { signal });
  }

  async remove(path: string, signal?: AbortSignal): Promise<void> {
    await this.sandbox.files.remove(path, { signal });
  }

  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await this.sandbox.files.rename(from, to, { signal });
  }

  async startCommand(command: string, options: E2BCommandOptions): Promise<E2BProcess> {
    const maxOutputBytes = validateOutputLimit(options.maxOutputBytes);
    const logDirectory = `${PROCESS_LOG_ROOT}/${randomUUID()}`;
    const stdoutFile = `${logDirectory}/stdout`;
    const stderrFile = `${logDirectory}/stderr`;
    await this.sandbox.files.makeDir(logDirectory, { signal: options.signal });
    await this.sandbox.files.write(
      [
        { path: stdoutFile, data: "" },
        { path: stderrFile, data: "" },
      ],
      { signal: options.signal },
    );
    const handle = await this.sandbox.commands.run(
      boundedCommandWrapper({ command, logDirectory, maxOutputBytes }),
      {
        background: true,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        requestTimeoutMs: options.timeoutMs,
        signal: options.signal,
        envs: options.envs,
        // Deliberately no stdout/stderr callbacks. The wrapped command redirects
        // both streams before the SDK can accumulate them.
      },
    );
    let waitPromise: Promise<E2BCommandResult> | undefined;
    const readBoundedLog = async (filePath: string): Promise<string> => {
      // Never use files.read for a path the sandbox command can replace between
      // stat and read (symlink, FIFO, /dev/zero, or a growing file). This fixed
      // control command can emit at most maxOutputBytes into the SDK.
      const result = await this.sandbox.commands.run(
        `${TRUSTED_HEAD} -c ${maxOutputBytes} -- ${shellQuote(filePath)} 2>/dev/null || true`,
        {
          timeoutMs: 5_000,
          requestTimeoutMs: 5_000,
          envs: { PATH: TRUSTED_CONTROL_PATH },
        },
      );
      return result.stdout;
    };
    const killGroup = async (): Promise<void> => {
      await this.sandbox.commands
        .run(`${TRUSTED_KILL} -KILL -- -${handle.pid} >/dev/null 2>&1 || true`, {
          timeoutMs: 5_000,
          requestTimeoutMs: 5_000,
          envs: { PATH: TRUSTED_CONTROL_PATH },
        })
        .catch(() => undefined);
    };
    const result: E2BProcess = {
      pid: handle.pid,
      wait: () => {
        waitPromise ??= (async () => {
          let commandResult: E2BCommandResult;
          try {
            commandResult = await handle.wait();
          } catch (error) {
            const normalized = normalizeCommandFailure(error);
            if (!normalized) throw error;
            commandResult = normalized;
          } finally {
            // Foreground shells can leave background descendants behind.
            // Quiesce the process group before source inventory/writeback.
            await killGroup();
          }
          const stdout = await readBoundedLog(stdoutFile);
          const stderr = await readBoundedLog(stderrFile);
          if (options.onStdout && stdout) await options.onStdout(stdout);
          if (options.onStderr && stderr) await options.onStderr(stderr);
          return { ...commandResult, stdout, stderr };
        })().finally(async () => {
          await this.sandbox.files.remove(logDirectory).catch(() => undefined);
        });
        return waitPromise;
      },
      kill: async () => {
        await killGroup();
        return handle.kill();
      },
    };
    return result;
  }

  async killProcess(pid: number, signal?: AbortSignal): Promise<boolean> {
    await this.sandbox.commands
      .run(`${TRUSTED_KILL} -KILL -- -${pid} >/dev/null 2>&1 || true`, {
        timeoutMs: 5_000,
        requestTimeoutMs: 5_000,
        signal,
        envs: { PATH: TRUSTED_CONTROL_PATH },
      })
      .catch(() => undefined);
    return this.sandbox.commands.kill(pid, { signal });
  }

  getHost(port: number): string {
    return this.sandbox.getHost(port);
  }

  pause(signal?: AbortSignal): Promise<boolean> {
    return this.sandbox.pause({ signal });
  }

  kill(signal?: AbortSignal): Promise<boolean> {
    return this.sandbox.kill({ signal });
  }
}

/**
 * Thin wrapper around the official SDK. Keeping this boundary small makes the
 * runtime testable without an E2B account and, more importantly, gives tests a
 * place to assert that control-plane secrets never become sandbox env vars.
 */
export class E2BSdkAdapter implements E2BAdapter {
  async create(options: E2BCreateOptions): Promise<E2BSandboxHandle> {
    const sandboxOptions = {
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      signal: options.signal,
      secure: true,
      lifecycle: {
        onTimeout: "pause",
        autoResume: true,
      },
      network: {
        allowPublicTraffic: false,
      },
      metadata: {
        "quillra.project_id": options.projectId,
      },
    } satisfies SandboxOpts;

    // Do not pass `envs` here. E2B receives no Quillra, Anthropic, GitHub,
    // database, mailer, or encryption credentials.
    const sandbox =
      options.templateId === "base"
        ? await Sandbox.create(sandboxOptions)
        : await Sandbox.create(options.templateId, sandboxOptions);
    return new SdkSandboxHandle(sandbox);
  }

  async connect(sandboxId: string, options: E2BConnectOptions): Promise<E2BSandboxHandle> {
    return new SdkSandboxHandle(
      await Sandbox.connect(sandboxId, {
        apiKey: options.apiKey,
        timeoutMs: options.timeoutMs,
        requestTimeoutMs: options.requestTimeoutMs,
        signal: options.signal,
      }),
    );
  }

  destroy(
    sandboxId: string,
    options: Pick<E2BConnectOptions, "apiKey" | "requestTimeoutMs" | "signal">,
  ): Promise<boolean> {
    return Sandbox.kill(sandboxId, options);
  }

  isNotFound(error: unknown): boolean {
    return error instanceof SandboxNotFoundError;
  }
}
