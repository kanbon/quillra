import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { CommandExitError, FileType, Sandbox, SandboxNotFoundError, type SandboxOpts } from "e2b";
import {
  E2BTrustedEnvironmentError,
  type E2BTrustedEnvironmentStage,
  E2B_ENVD_PORT,
  E2B_PREVIEW_RELAY_PORT,
  E2B_PREVIEW_RELAY_SOURCE,
  E2B_PROJECT_HOME,
  E2B_PROJECT_USER,
  E2B_RELAY_BIN_ROOT,
  E2B_RELAY_INSTALL_PATH,
  E2B_RELAY_NODE_PATH,
  E2B_RELAY_RUNTIME_ROOT,
  E2B_RELAY_STAGING_ROOT,
  E2B_RELAY_USER,
  assertE2BPreviewTargetPort,
} from "./e2b-preview-relay.js";

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const ABSOLUTE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const BACKGROUND_COMMAND_REQUEST_TIMEOUT_MS = 60_000;
const PROCESS_LOG_ROOT = `${E2B_PROJECT_HOME}/.quillra-processes`;
const MAX_FILE_CHUNK_BYTES = 256 * 1024;
const ABSOLUTE_MAX_DIRECTORY_ENTRIES = 20_000;
const ABSOLUTE_MAX_DIRECTORY_OUTPUT_BYTES = 4 * 1024 * 1024;
const ABSOLUTE_MAX_TREE_DEPTH = 128;
const ABSOLUTE_MAX_TREE_PATH_BYTES = 4 * 1024;
const ABSOLUTE_MAX_TREE_FILE_BYTES = 1024 * 1024 * 1024;
const ABSOLUTE_MAX_TREE_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const TRUSTED_CONTROL_PATH = "/usr/sbin:/usr/bin:/bin";
const PROJECT_EXECUTION_PATH = "/usr/local/bin:/usr/bin:/bin";
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
const TRUSTED_SETPRIV = "/usr/bin/setpriv";
const TRUSTED_ENV = "/usr/bin/env";
const TRUSTED_LAUNCH_HOME = `${E2B_RELAY_RUNTIME_ROOT}/control-home`;
const SENSITIVE_SANDBOX_ENV_KEYS = new Set([
  "E2B_ACCESS_TOKEN",
  "E2B_API_KEY",
  "E2B_ENVD_ACCESS_TOKEN",
  "E2B_TRAFFIC_ACCESS_TOKEN",
  "ENVD_ACCESS_TOKEN",
]);

export type E2BRemoteEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "special";
  size: number;
  mode: number;
  symlinkTarget?: string;
};

export type E2BRemoteTreeEntry = E2BRemoteEntry & {
  sha256?: string;
};

export type E2BRemoteTreeManifest = {
  root: E2BRemoteEntry | null;
  entries: E2BRemoteTreeEntry[];
};

export type E2BRemoteTreeOptions = {
  maxEntries: number;
  maxOutputBytes: number;
  maxDepth: number;
  maxPathBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  excludedSegments: string[];
  signal?: AbortSignal;
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
  projectPathPrefix?: string;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
};

export interface E2BSandboxHandle {
  readonly sandboxId: string;
  readonly trafficAccessToken?: string;

  prepareExecutionEnvironment(signal?: AbortSignal): Promise<void>;
  quiesceProjectProcesses(signal?: AbortSignal): Promise<void>;
  startPreviewRelay(targetPort: number, signal?: AbortSignal): Promise<void>;
  stopPreviewRelay(signal?: AbortSignal): Promise<void>;
  list(
    path: string,
    options: {
      maxEntries: number;
      maxOutputBytes: number;
      signal?: AbortSignal;
    },
  ): Promise<E2BRemoteEntry[]>;
  /**
   * Return a freshly hashed, recursively bounded tree in one remote command.
   * Optional so alternate adapters can fall back to bounded chunk reads.
   */
  scanTree?(path: string, options: E2BRemoteTreeOptions): Promise<E2BRemoteTreeManifest>;
  getInfo(path: string, signal?: AbortSignal): Promise<E2BRemoteEntry>;
  readFileChunk(
    path: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  writeFiles(
    files: Array<{ path: string; data: Uint8Array; mode?: number }>,
    signal?: AbortSignal,
  ): Promise<void>;
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
  lifecycle?: SandboxOpts["lifecycle"];
  allowInternetAccess?: boolean;
  onSandboxCreated?: (sandboxId: string) => void | Promise<void>;
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

function validateProjectPathPrefix(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    Buffer.byteLength(value, "utf8") > 1_024 ||
    !value.startsWith(`${E2B_PROJECT_HOME}/`) ||
    !/^[A-Za-z0-9._/-]+$/.test(value) ||
    value.includes(":") ||
    value.includes("\0") ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error("Invalid E2B project PATH prefix.");
  }
  const relative = path.posix.relative(E2B_PROJECT_HOME, value);
  if (!relative || relative.startsWith("../") || relative.split("/").includes("..")) {
    throw new Error("Invalid E2B project PATH prefix.");
  }
  return value;
}

function isolatedUserShell(
  user: typeof E2B_PROJECT_USER | typeof E2B_RELAY_USER,
  command: string,
  envs: Record<string, string> = {},
  newSession = false,
  projectPathPrefix?: string,
): string {
  if (user !== E2B_PROJECT_USER && projectPathPrefix !== undefined) {
    throw new Error("A project PATH prefix cannot enter a trusted relay command.");
  }
  const normalizedProjectPathPrefix =
    user === E2B_PROJECT_USER ? validateProjectPathPrefix(projectPathPrefix) : undefined;
  for (const key of Object.keys(envs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error("Invalid E2B command environment variable name.");
    }
    if (SENSITIVE_SANDBOX_ENV_KEYS.has(key.toUpperCase())) {
      throw new Error("Sensitive E2B credentials cannot enter a sandbox command.");
    }
  }
  const home = user === E2B_PROJECT_USER ? E2B_PROJECT_HOME : "/nonexistent";
  const executionPath =
    user === E2B_PROJECT_USER && normalizedProjectPathPrefix
      ? `${normalizedProjectPathPrefix}:${PROJECT_EXECUTION_PATH}`
      : user === E2B_PROJECT_USER
        ? PROJECT_EXECUTION_PATH
        : TRUSTED_CONTROL_PATH;
  const environment = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...envs,
    HOME: home,
    LOGNAME: user,
    PATH: executionPath,
    USER: user,
  };
  const environmentArgs = Object.entries(environment)
    .map(([key, value]) => shellQuote(`${key}=${value}`))
    .join(" ");
  const sessionPrefix = newSession ? `${TRUSTED_SETSID} ` : "";
  return [
    "exec",
    TRUSTED_SETPRIV,
    `--reuid=${user}`,
    `--regid=${user}`,
    "--clear-groups",
    "--no-new-privs",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
    TRUSTED_ENV,
    "-i",
    environmentArgs,
    sessionPrefix + TRUSTED_BASH,
    "-c",
    shellQuote(command),
  ].join(" ");
}

function privilegedRelayBootstrap(command: string): string {
  const environmentArgs = [
    "HOME=/nonexistent",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    `LOGNAME=${E2B_RELAY_USER}`,
    `PATH=${TRUSTED_CONTROL_PATH}`,
    `USER=${E2B_RELAY_USER}`,
  ]
    .map(shellQuote)
    .join(" ");
  return [
    "exec",
    TRUSTED_SETPRIV,
    "--no-new-privs",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
    TRUSTED_ENV,
    "-i",
    environmentArgs,
    TRUSTED_BASH,
    "-c",
    shellQuote(command),
  ].join(" ");
}

const TRUSTED_LAUNCH_ENV = {
  BASH_ENV: "/dev/null",
  ENV: "/dev/null",
  HOME: TRUSTED_LAUNCH_HOME,
  LANG: "C",
  LC_ALL: "C",
  LOGNAME: "root",
  PATH: TRUSTED_CONTROL_PATH,
  USER: "root",
} as const;

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

export const BOUNDED_TREE_SCANNER = [
  "import base64,hashlib,json,os,stat,sys",
  "def emit(value):",
  ' sys.stdout.write(json.dumps(value,separators=(",",":")))',
  "def fail(error):",
  ' emit({"ok":False,"error":error})',
  " sys.exit(0)",
  "def encoded(value):",
  " return base64.b64encode(os.fsencode(value)).decode('ascii')",
  "def metadata(info,link=None):",
  " mode=info.st_mode",
  " if stat.S_ISLNK(mode):",
  '  kind="file"',
  "  size=0",
  " elif stat.S_ISDIR(mode):",
  '  kind="dir"',
  "  size=0",
  " elif stat.S_ISREG(mode):",
  '  kind="file"',
  "  size=info.st_size",
  " else:",
  '  kind="special"',
  "  size=0",
  ' return {"t":kind,"s":size,"m":stat.S_IMODE(mode),"l":None if link is None else encoded(link)}',
  "try:",
  " root=sys.argv[1]",
  " max_entries=int(sys.argv[2])",
  " max_output_bytes=int(sys.argv[3])",
  " max_depth=int(sys.argv[4])",
  " max_path_bytes=int(sys.argv[5])",
  " max_file_bytes=int(sys.argv[6])",
  " max_total_bytes=int(sys.argv[7])",
  " excluded=set(filter(None,sys.argv[8].split(',')))",
  " def succeed(root_record,entries):",
  "  serialized=json.dumps({'ok':True,'root':root_record,'entries':entries},separators=(',',':'))",
  "  if len(serialized.encode('utf-8'))>max_output_bytes:",
  "   fail('byte_limit')",
  "  sys.stdout.write(serialized)",
  "  sys.exit(0)",
  " try:",
  "  root_info=os.lstat(root)",
  " except FileNotFoundError:",
  "  succeed(None,[])",
  " root_link=os.readlink(root) if stat.S_ISLNK(root_info.st_mode) else None",
  " root_record=metadata(root_info,root_link)",
  " if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):",
  "  succeed(root_record,[])",
  " entries=[]",
  " encoded_bytes=96+len(json.dumps(root_record,separators=(',',':')).encode('utf-8'))",
  " total_bytes=0",
  " def append(record):",
  "  global encoded_bytes",
  "  if len(entries)>=max_entries:",
  "   fail('entry_limit')",
  "  record_bytes=len(json.dumps(record,separators=(',',':')).encode('utf-8'))+1",
  "  encoded_bytes+=record_bytes",
  "  if encoded_bytes>max_output_bytes:",
  "   fail('byte_limit')",
  "  entries.append(record)",
  " def hash_file(parent_fd,name,expected):",
  "  file_fd=os.open(name,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent_fd)",
  "  try:",
  "   opened=os.fstat(file_fd)",
  "   if not stat.S_ISREG(opened.st_mode) or opened.st_dev!=expected.st_dev or opened.st_ino!=expected.st_ino or opened.st_size!=expected.st_size:",
  "    raise RuntimeError('file changed during scan')",
  "   digest=hashlib.sha256()",
  "   remaining=opened.st_size",
  "   while remaining:",
  "    chunk=os.read(file_fd,min(262144,remaining))",
  "    if not chunk:",
  "     raise RuntimeError('short file read')",
  "    digest.update(chunk)",
  "    remaining-=len(chunk)",
  "   final=os.fstat(file_fd)",
  "   if final.st_dev!=opened.st_dev or final.st_ino!=opened.st_ino or final.st_size!=opened.st_size:",
  "    raise RuntimeError('file changed during scan')",
  "   return digest.hexdigest()",
  "  finally:",
  "   os.close(file_fd)",
  " def walk(directory_fd,parent_parts):",
  "  global total_bytes",
  "  with os.scandir(directory_fd) as iterator:",
  "   for entry in iterator:",
  "    parts=parent_parts+[entry.name]",
  "    if len(parts)>max_depth:",
  "     fail('depth_limit')",
  "    relative='/'.join(parts)",
  "    if len(os.fsencode(relative))>max_path_bytes:",
  "     fail('path_limit')",
  "    info=entry.stat(follow_symlinks=False)",
  "    link=os.readlink(entry.name,dir_fd=directory_fd) if stat.S_ISLNK(info.st_mode) else None",
  "    record=metadata(info,link)",
  "    record['p']=encoded(relative)",
  "    record['h']=None",
  "    is_excluded=entry.name in excluded",
  "    if stat.S_ISREG(info.st_mode):",
  "     if info.st_size>max_file_bytes:",
  "      fail('file_limit')",
  "     total_bytes+=info.st_size",
  "     if total_bytes>max_total_bytes:",
  "      fail('total_limit')",
  "     if not is_excluded:",
  "      record['h']=hash_file(directory_fd,entry.name,info)",
  "    append(record)",
  "    if stat.S_ISDIR(info.st_mode) and not is_excluded:",
  "     child_fd=os.open(entry.name,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=directory_fd)",
  "     try:",
  "      opened=os.fstat(child_fd)",
  "      if opened.st_dev!=info.st_dev or opened.st_ino!=info.st_ino:",
  "       raise RuntimeError('directory changed during scan')",
  "      walk(child_fd,parts)",
  "     finally:",
  "      os.close(child_fd)",
  " root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW)",
  " try:",
  "  opened_root=os.fstat(root_fd)",
  "  if opened_root.st_dev!=root_info.st_dev or opened_root.st_ino!=root_info.st_ino:",
  "   raise RuntimeError('root changed during scan')",
  "  walk(root_fd,[])",
  " finally:",
  "  os.close(root_fd)",
  " succeed(root_record,entries)",
  "except Exception:",
  " emit({'ok':False,'error':'scan_failed'})",
].join("\n");

const APPLY_FILE_MODES_SCRIPT = [
  "import base64,json,os,stat,sys",
  "root=sys.argv[1]",
  "payload=json.loads(base64.b64decode(sys.argv[2],validate=True))",
  "root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW)",
  "try:",
  " for item in payload:",
  "  relative=item[0]",
  "  mode=item[1]",
  "  if not isinstance(relative,str) or not isinstance(mode,int) or mode not in (0o644,0o755):",
  "   raise RuntimeError('invalid mode request')",
  "  parts=relative.split('/')",
  "  if not parts or any(part in ('','.','..') or '\\x00' in part for part in parts):",
  "   raise RuntimeError('invalid mode path')",
  "  parent_fd=os.dup(root_fd)",
  "  try:",
  "   for component in parts[:-1]:",
  "    next_fd=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent_fd)",
  "    os.close(parent_fd)",
  "    parent_fd=next_fd",
  "   file_fd=os.open(parts[-1],os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent_fd)",
  "   try:",
  "    info=os.fstat(file_fd)",
  "    if not stat.S_ISREG(info.st_mode):",
  "     raise RuntimeError('mode target is not regular')",
  "    os.fchmod(file_fd,mode)",
  "   finally:",
  "    os.close(file_fd)",
  "  finally:",
  "   os.close(parent_fd)",
  "finally:",
  " os.close(root_fd)",
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

type TreeScannerRecord = {
  p?: string;
  t: "file" | "dir" | "special";
  s: number;
  m: number;
  l: string | null;
  h?: string | null;
};

type TreeScannerResponse =
  | {
      ok: true;
      root: Omit<TreeScannerRecord, "p" | "h"> | null;
      entries: TreeScannerRecord[];
    }
  | {
      ok: false;
      error:
        | "entry_limit"
        | "byte_limit"
        | "depth_limit"
        | "path_limit"
        | "file_limit"
        | "total_limit"
        | "scan_failed";
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

function validateTreeScanOptions(options: E2BRemoteTreeOptions): void {
  validateDirectoryListOptions(options);
  if (
    !Number.isSafeInteger(options.maxDepth) ||
    options.maxDepth < 1 ||
    options.maxDepth > ABSOLUTE_MAX_TREE_DEPTH
  ) {
    throw new Error("Invalid bounded E2B tree depth limit.");
  }
  if (
    !Number.isSafeInteger(options.maxPathBytes) ||
    options.maxPathBytes < 1 ||
    options.maxPathBytes > ABSOLUTE_MAX_TREE_PATH_BYTES
  ) {
    throw new Error("Invalid bounded E2B tree path limit.");
  }
  if (
    !Number.isSafeInteger(options.maxFileBytes) ||
    options.maxFileBytes < 0 ||
    options.maxFileBytes > ABSOLUTE_MAX_TREE_FILE_BYTES
  ) {
    throw new Error("Invalid bounded E2B tree file limit.");
  }
  if (
    !Number.isSafeInteger(options.maxTotalBytes) ||
    options.maxTotalBytes < 0 ||
    options.maxTotalBytes > ABSOLUTE_MAX_TREE_TOTAL_BYTES
  ) {
    throw new Error("Invalid bounded E2B tree total limit.");
  }
  if (
    options.excludedSegments.length > 32 ||
    options.excludedSegments.some(
      (segment) =>
        !segment || Buffer.byteLength(segment, "utf8") > 128 || !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    throw new Error("Invalid bounded E2B tree exclusions.");
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
  envs?: Record<string, string>;
  projectPathPrefix?: string;
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
  return `${isolatedUserShell(
    E2B_PROJECT_USER,
    script,
    input.envs,
    true,
    input.projectPathPrefix,
  )} >/dev/null 2>/dev/null`;
}

/**
 * Creates/chowns only directory entries anchored beneath a root-owned,
 * non-writable parent. O_NOFOLLOW prevents an existing leaf symlink from
 * redirecting root metadata changes to a trusted system directory.
 *
 * Arguments repeat as: absolute-path uid gid octal-mode.
 */
export const SECURE_DIRECTORY_SETUP_SCRIPT = [
  "import os,stat,sys",
  "TRUSTED_PARENT_UID=0",
  "if len(sys.argv)<5 or (len(sys.argv)-1)%4:",
  " sys.exit(1)",
  "flags=os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW",
  "for index in range(1,len(sys.argv),4):",
  " path=sys.argv[index]",
  " try:",
  "  uid=int(sys.argv[index+1])",
  "  gid=int(sys.argv[index+2])",
  "  mode=int(sys.argv[index+3],8)",
  " except ValueError:",
  "  sys.exit(1)",
  ' if not path.startswith("/") or path=="/" or "\\x00" in path or uid<0 or gid<0 or mode<0 or mode>0o777:',
  "  sys.exit(1)",
  " parent,leaf=os.path.split(path)",
  ' if not parent or leaf in ("",".",".."):',
  "  sys.exit(1)",
  " parent_fd=os.open(parent,flags)",
  " try:",
  "  parent_info=os.fstat(parent_fd)",
  "  if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid!=TRUSTED_PARENT_UID or parent_info.st_mode&0o022:",
  "   sys.exit(1)",
  "  try:",
  "   os.mkdir(leaf,mode,dir_fd=parent_fd)",
  "  except FileExistsError:",
  "   pass",
  "  child_fd=os.open(leaf,flags,dir_fd=parent_fd)",
  "  try:",
  "   child_info=os.fstat(child_fd)",
  "   if not stat.S_ISDIR(child_info.st_mode) or child_info.st_uid not in (TRUSTED_PARENT_UID,uid) or child_info.st_gid not in (0,gid):",
  "    sys.exit(1)",
  "   os.fchown(child_fd,uid,gid)",
  "   os.fchmod(child_fd,mode)",
  "   final_info=os.fstat(child_fd)",
  "   if final_info.st_uid!=uid or final_info.st_gid!=gid or stat.S_IMODE(final_info.st_mode)!=mode:",
  "    sys.exit(1)",
  "  finally:",
  "   os.close(child_fd)",
  " finally:",
  "  os.close(parent_fd)",
].join("\n");

/**
 * Used only for a freshly created sandbox, before project code can execute.
 * E2B's base Node is root-owned but intentionally mode 0777 under its
 * developer-writable /usr/local. Copy it once into the sealed trust root via
 * an atomic, dirfd-anchored destination; reconnects never run this script.
 */
export const SEAL_RELAY_NODE_SCRIPT = [
  "import errno,os,stat,sys",
  "destination=sys.argv[1]",
  "relay_gid=int(sys.argv[2])",
  'candidates=("/usr/bin/node","/usr/local/bin/node")',
  "parent,leaf=os.path.split(destination)",
  'if not parent or leaf in ("",".","..") or relay_gid<0:',
  " sys.exit(1)",
  "source_fd=None",
  "for candidate in candidates:",
  " try:",
  "  source_fd=os.open(candidate,os.O_RDONLY|os.O_CLOEXEC)",
  " except OSError as error:",
  "  if error.errno in (errno.ENOENT,errno.ENOTDIR):",
  "   continue",
  "  raise",
  " source_info=os.fstat(source_fd)",
  " if not stat.S_ISREG(source_info.st_mode) or source_info.st_uid!=0 or source_info.st_size<1 or source_info.st_size>536870912 or not source_info.st_mode&0o111:",
  "  os.close(source_fd)",
  "  sys.exit(1)",
  " break",
  "if source_fd is None:",
  " sys.exit(1)",
  "flags=os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW",
  "parent_fd=os.open(parent,flags)",
  'temporary=".node-install-"+os.urandom(16).hex()',
  "temporary_created=False",
  "try:",
  " parent_info=os.fstat(parent_fd)",
  " if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid!=0 or parent_info.st_mode&0o022:",
  "  sys.exit(1)",
  " destination_fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC|os.O_NOFOLLOW,0o500,dir_fd=parent_fd)",
  " temporary_created=True",
  " try:",
  "  copied=0",
  "  while True:",
  "   chunk=os.read(source_fd,1048576)",
  "   if not chunk:",
  "    break",
  "   copied+=len(chunk)",
  "   if copied>source_info.st_size:",
  "    sys.exit(1)",
  "   view=memoryview(chunk)",
  "   while view:",
  "    written=os.write(destination_fd,view)",
  "    if written<1:",
  "     sys.exit(1)",
  "    view=view[written:]",
  "  if copied!=source_info.st_size:",
  "   sys.exit(1)",
  "  os.fchown(destination_fd,0,relay_gid)",
  "  os.fchmod(destination_fd,0o550)",
  "  os.fsync(destination_fd)",
  " finally:",
  "  os.close(destination_fd)",
  " os.replace(temporary,leaf,src_dir_fd=parent_fd,dst_dir_fd=parent_fd)",
  " temporary_created=False",
  " sealed_fd=os.open(leaf,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent_fd)",
  " try:",
  "  sealed_info=os.fstat(sealed_fd)",
  "  if not stat.S_ISREG(sealed_info.st_mode) or sealed_info.st_uid!=0 or sealed_info.st_gid!=relay_gid or stat.S_IMODE(sealed_info.st_mode)!=0o550 or sealed_info.st_nlink!=1 or sealed_info.st_size!=source_info.st_size:",
  "   sys.exit(1)",
  " finally:",
  "  os.close(sealed_fd)",
  "finally:",
  " os.close(source_fd)",
  " if temporary_created:",
  "  try:",
  "   os.unlink(temporary,dir_fd=parent_fd)",
  "  except OSError:",
  "   pass",
  " os.close(parent_fd)",
].join("\n");

const SEALED_RELAY_NODE_VALIDATION_SCRIPT = [
  "import os,stat,sys",
  "path=sys.argv[1]",
  "relay_gid=int(sys.argv[2])",
  "parent,leaf=os.path.split(path)",
  "parent_fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW)",
  "try:",
  " parent_info=os.fstat(parent_fd)",
  " if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid!=0 or parent_info.st_mode&0o022:",
  "  sys.exit(1)",
  " node_fd=os.open(leaf,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent_fd)",
  " try:",
  "  info=os.fstat(node_fd)",
  "  if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_gid!=relay_gid or stat.S_IMODE(info.st_mode)!=0o550 or info.st_nlink!=1 or info.st_size<1:",
  "   sys.exit(1)",
  " finally:",
  "  os.close(node_fd)",
  "finally:",
  " os.close(parent_fd)",
].join("\n");

/**
 * Node binds the protected low port before the relay source drops privileges,
 * so the ELF loader itself is part of the root trust boundary. Validate that
 * boundary as the locked relay user, then inspect the kernel's resolved maps
 * from the root control process. Custom templates with mutable search paths or
 * dependencies fail closed before Node is ever launched as root.
 */
export const SEALED_RELAY_RUNTIME_VALIDATION_SCRIPT = [
  "import os,re,select,stat,subprocess,sys,time",
  "node=os.path.realpath(sys.argv[1])",
  "relay_user=sys.argv[2]",
  "MAX_TOOL_OUTPUT=131072",
  "MAX_MAPS_BYTES=4194304",
  "def trusted(candidate,regular=False):",
  " if not candidate.startswith('/') or '\\x00' in candidate:",
  "  raise RuntimeError('invalid trusted path')",
  " real=os.path.realpath(candidate)",
  " info=os.stat(real)",
  " if info.st_uid!=0 or info.st_mode&0o022:",
  "  raise RuntimeError('mutable trusted path')",
  " if regular and not stat.S_ISREG(info.st_mode):",
  "  raise RuntimeError('trusted dependency is not a regular file')",
  " current=os.path.dirname(real) if regular else real",
  " while current!='/':",
  "  component=os.stat(current)",
  "  if not stat.S_ISDIR(component.st_mode) or component.st_uid!=0 or component.st_mode&0o022:",
  "   raise RuntimeError('mutable trusted path component')",
  "  current=os.path.dirname(current)",
  " return real",
  "def tool_output(arguments):",
  " result=subprocess.run(arguments,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5,check=False)",
  " if result.returncode!=0 or len(result.stdout)>MAX_TOOL_OUTPUT:",
  "  raise RuntimeError('ELF inspection failed')",
  " return result.stdout.decode('utf-8','strict')",
  "node=trusted(node,True)",
  "readelf=trusted('/usr/bin/readelf',True)",
  "dynamic=tool_output([readelf,'-d',node])",
  "if re.search(r'\\((?:RPATH|RUNPATH)\\)',dynamic):",
  " raise RuntimeError('mutable ELF search paths are not allowed')",
  "program=tool_output([readelf,'-l',node])",
  "interpreters=re.findall(r'Requesting program interpreter:\\s*([^\\]]+)',program)",
  "if len(interpreters)!=1:",
  " raise RuntimeError('ambiguous ELF interpreter')",
  "trusted(interpreters[0],True)",
  "ready_read,ready_write=os.pipe()",
  "probe=\"require('node:http');const fs=require('node:fs');const fd=Number(process.env.QUILLRA_READY_FD);fs.writeSync(fd,'ready');fs.closeSync(fd);setInterval(()=>{},1000)\"",
  "command=['/usr/bin/setpriv','--reuid='+relay_user,'--regid='+relay_user,'--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--','/usr/bin/env','-i','HOME=/nonexistent','LANG=C','LC_ALL=C','LOGNAME='+relay_user,'PATH=/usr/sbin:/usr/bin:/bin','QUILLRA_READY_FD='+str(ready_write),'USER='+relay_user,node,'-e',probe]",
  "try:",
  " process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,pass_fds=(ready_write,))",
  "finally:",
  " os.close(ready_write)",
  "try:",
  " deadline=time.monotonic()+3",
  " ready=b''",
  " while process.poll() is None and time.monotonic()<deadline and len(ready)<5:",
  "  remaining=max(0,deadline-time.monotonic())",
  "  readable,_,_=select.select([ready_read],[],[],min(0.1,remaining))",
  "  if readable:",
  "   chunk=os.read(ready_read,5-len(ready))",
  "   if not chunk:",
  "    break",
  "   ready+=chunk",
  " if process.poll() is not None or ready!=b'ready':",
  "  raise RuntimeError('sealed Node readiness probe failed')",
  " executable=os.path.realpath('/proc/'+str(process.pid)+'/exe')",
  " if executable!=node:",
  "  raise RuntimeError('sealed Node executable changed')",
  " with open('/proc/'+str(process.pid)+'/maps','rb',buffering=0) as handle:",
  "  raw=handle.read(MAX_MAPS_BYTES+1)",
  " if not raw or len(raw)>MAX_MAPS_BYTES:",
  "  raise RuntimeError('sealed Node load probe failed')",
  " mapped={node}",
  " for line in raw.decode('utf-8','strict').splitlines():",
  "  fields=line.split(None,5)",
  "  if len(fields)==6 and fields[5].startswith('/'):",
  "   if fields[5].endswith(' (deleted)'):",
  "    raise RuntimeError('deleted runtime dependency')",
  "   mapped.add(fields[5])",
  " if len(mapped)<2:",
  "  raise RuntimeError('runtime dependency closure is empty')",
  " for candidate in mapped:",
  "  trusted(candidate,True)",
  "finally:",
  " os.close(ready_read)",
  " if process.poll() is None:",
  "  process.terminate()",
  " try:",
  "  process.wait(timeout=3)",
  " except subprocess.TimeoutExpired:",
  "  process.kill()",
  "  process.wait(timeout=3)",
].join("\n");

const TRUSTED_NODE_COMMAND = [
  `quillra_node=${shellQuote(E2B_RELAY_NODE_PATH)}`,
  '[ -x "$quillra_node" ]',
].join("\n");

const SANDBOX_BOOTSTRAP_SCRIPT = [
  "set -eu",
  `export PATH=${shellQuote(TRUSTED_CONTROL_PATH)}`,
  "for quillra_tool in /bin/bash /bin/rm /usr/bin/awk /usr/bin/base64 /usr/bin/cat /usr/bin/cut /usr/bin/dd /usr/bin/env /usr/bin/getent /usr/bin/head /usr/bin/id /usr/bin/install /usr/bin/kill /usr/bin/mkfifo /usr/bin/python3 /usr/bin/readelf /usr/bin/setpriv /usr/bin/setsid /usr/bin/sha256sum /usr/bin/stat /usr/bin/true /usr/sbin/groupadd /usr/sbin/nologin /usr/sbin/useradd /usr/sbin/usermod; do",
  '  [ -x "$quillra_tool" ]',
  "done",
  `if ! /usr/bin/getent group ${E2B_PROJECT_USER} >/dev/null; then`,
  `  /usr/sbin/groupadd --system ${E2B_PROJECT_USER}`,
  "fi",
  `if ! /usr/bin/getent passwd ${E2B_PROJECT_USER} >/dev/null; then`,
  `  /usr/sbin/useradd --system --gid ${E2B_PROJECT_USER} --home-dir ${E2B_PROJECT_HOME} --no-create-home --shell /usr/sbin/nologin ${E2B_PROJECT_USER}`,
  "fi",
  `if ! /usr/bin/getent group ${E2B_RELAY_USER} >/dev/null; then`,
  `  /usr/sbin/groupadd --system ${E2B_RELAY_USER}`,
  "fi",
  `if ! /usr/bin/getent passwd ${E2B_RELAY_USER} >/dev/null; then`,
  `  /usr/sbin/useradd --system --gid ${E2B_RELAY_USER} --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin ${E2B_RELAY_USER}`,
  "fi",
  `/usr/sbin/usermod --lock --shell /usr/sbin/nologin ${E2B_PROJECT_USER}`,
  `/usr/sbin/usermod --lock --shell /usr/sbin/nologin ${E2B_RELAY_USER}`,
  `quillra_project_uid=$(/usr/bin/id -u ${E2B_PROJECT_USER})`,
  `quillra_project_gid=$(/usr/bin/id -g ${E2B_PROJECT_USER})`,
  `quillra_relay_uid=$(/usr/bin/id -u ${E2B_RELAY_USER})`,
  `quillra_relay_gid=$(/usr/bin/id -g ${E2B_RELAY_USER})`,
  '[ "$quillra_project_uid" -ne 0 ]',
  '[ "$quillra_project_gid" -ne 0 ]',
  '[ "$quillra_relay_uid" -ne 0 ]',
  '[ "$quillra_relay_gid" -ne 0 ]',
  '[ "$quillra_project_uid" -ne "$quillra_relay_uid" ]',
  `set -- $(/usr/bin/id -G ${E2B_PROJECT_USER})`,
  '[ "$#" -eq 1 ]',
  '[ "$1" = "$quillra_project_gid" ]',
  `set -- $(/usr/bin/id -G ${E2B_RELAY_USER})`,
  '[ "$#" -eq 1 ]',
  '[ "$1" = "$quillra_relay_gid" ]',
  `${TRUSTED_PYTHON} -I -S -c ${shellQuote(SECURE_DIRECTORY_SETUP_SCRIPT)} ${shellQuote(E2B_PROJECT_HOME)} "$quillra_project_uid" "$quillra_project_gid" 0700 ${shellQuote(E2B_RELAY_RUNTIME_ROOT)} 0 0 0711 ${shellQuote(E2B_RELAY_BIN_ROOT)} 0 0 0711 ${shellQuote(E2B_RELAY_STAGING_ROOT)} 0 0 0700 ${shellQuote(TRUSTED_LAUNCH_HOME)} 0 0 0700`,
  "quillra_unprivileged_port_start=$(/usr/bin/cat /proc/sys/net/ipv4/ip_unprivileged_port_start)",
  'case "$quillra_unprivileged_port_start" in ""|*[!0-9]*) exit 1 ;; esac',
  'if [ "$quillra_unprivileged_port_start" -lt 1024 ]; then',
  "  echo 1024 > /proc/sys/net/ipv4/ip_unprivileged_port_start",
  "fi",
  '[ "$(/usr/bin/cat /proc/sys/net/ipv4/ip_unprivileged_port_start)" -ge 1024 ]',
  `${TRUSTED_PYTHON} -I -S -c ${shellQuote(
    [
      "import os,stat,sys",
      'trusted=("/bin/bash","/bin/rm","/usr/bin/awk","/usr/bin/base64","/usr/bin/cat","/usr/bin/cut","/usr/bin/dd","/usr/bin/env","/usr/bin/getent","/usr/bin/head","/usr/bin/id","/usr/bin/install","/usr/bin/kill","/usr/bin/mkfifo","/usr/bin/python3","/usr/bin/readelf","/usr/bin/setpriv","/usr/bin/setsid","/usr/bin/sha256sum","/usr/bin/stat","/usr/bin/true","/usr/sbin/groupadd","/usr/sbin/nologin","/usr/sbin/useradd","/usr/sbin/usermod")',
      "def valid(candidate):",
      " try:",
      "  info=os.stat(candidate)",
      " except OSError:",
      "  return False",
      " return stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode & 0o022 and os.access(candidate,os.X_OK)",
      "if not all(valid(candidate) for candidate in trusted):",
      " sys.exit(1)",
    ].join("\n"),
  )}`,
].join("\n");

const UNAUTHENTICATED_ENVD_PROBE = [
  "import errno,http.client,os,sys",
  'for name in ("E2B_ACCESS_TOKEN","E2B_API_KEY","E2B_ENVD_ACCESS_TOKEN","E2B_TRAFFIC_ACCESS_TOKEN","ENVD_ACCESS_TOKEN"):',
  " if name in os.environ:",
  "  sys.exit(1)",
  "try:",
  ` connection=http.client.HTTPConnection("127.0.0.1",${E2B_ENVD_PORT},timeout=0.5)`,
  ' connection.request("POST","/process.Process/List",body=b"{}",headers={"Authorization":"Basic cm9vdDo=","Connect-Protocol-Version":"1","Content-Type":"application/json"})',
  " response=connection.getresponse()",
  " response.read(4096)",
  " status=response.status",
  " connection.close()",
  "except ConnectionRefusedError:",
  " sys.exit(0)",
  "except OSError as error:",
  " sys.exit(0 if error.errno==errno.ECONNREFUSED else 1)",
  "sys.exit(0 if status in (401,403) else 1)",
].join("\n");

const PROJECT_PRIVILEGED_PORT_PROBE = [
  "import errno,socket,sys",
  `targets=((socket.AF_INET,("0.0.0.0",${E2B_PREVIEW_RELAY_PORT})),(socket.AF_INET6,("::",${E2B_PREVIEW_RELAY_PORT},0,0)))`,
  "for family,address in targets:",
  " try:",
  "  sock=socket.socket(family,socket.SOCK_STREAM)",
  " except OSError as error:",
  "  if family==socket.AF_INET6 and error.errno in (errno.EAFNOSUPPORT,errno.EPROTONOSUPPORT):",
  "   continue",
  "  sys.exit(1)",
  " try:",
  "  sock.bind(address)",
  " except OSError as error:",
  "  sock.close()",
  "  if error.errno in (errno.EACCES,errno.EPERM):",
  "   continue",
  "  sys.exit(1)",
  " sock.close()",
  " sys.exit(1)",
  "sys.exit(0)",
].join("\n");

const PROJECT_ISOLATION_PROBE = [
  "set -eu",
  '[ "$(/usr/bin/id -u)" -ne 0 ]',
  '[ "$(/usr/bin/id -g)" -ne 0 ]',
  "for quillra_capability_field in CapInh CapPrm CapEff CapBnd CapAmb; do",
  "  quillra_capability_value=$(/usr/bin/awk -v field=\"$quillra_capability_field:\" '$1 == field { print $2 }' /proc/self/status)",
  '  [ -n "$quillra_capability_value" ]',
  '  case "$quillra_capability_value" in *[!0]*) exit 1 ;; esac',
  "done",
  "[ \"$(/usr/bin/awk '/^NoNewPrivs:/ { print $2 }' /proc/self/status)\" = 1 ]",
  "quillra_unprivileged_port_start=$(/usr/bin/cat /proc/sys/net/ipv4/ip_unprivileged_port_start)",
  'case "$quillra_unprivileged_port_start" in ""|*[!0-9]*) exit 1 ;; esac',
  '[ "$quillra_unprivileged_port_start" -ge 1024 ]',
  `[ ! -r ${shellQuote(E2B_RELAY_RUNTIME_ROOT)} ]`,
  `[ ! -w ${shellQuote(E2B_RELAY_RUNTIME_ROOT)} ]`,
  `[ ! -r ${shellQuote(TRUSTED_LAUNCH_HOME)} ]`,
  `[ ! -r ${shellQuote(E2B_RELAY_NODE_PATH)} ]`,
  `[ ! -w ${shellQuote(E2B_RELAY_NODE_PATH)} ]`,
  `[ ! -r ${shellQuote(E2B_RELAY_INSTALL_PATH)} ]`,
  `[ ! -w ${shellQuote(E2B_RELAY_INSTALL_PATH)} ]`,
  "if [ -x /usr/bin/sudo ] && /usr/bin/sudo -n /usr/bin/true >/dev/null 2>&1; then",
  "  exit 1",
  "fi",
  `${TRUSTED_PYTHON} -I -S -c ${shellQuote(UNAUTHENTICATED_ENVD_PROBE)}`,
].join("\n");

const KILL_USER_PROCESSES_SCRIPT = [
  "import errno,os,pwd,signal,sys,time",
  "uid=pwd.getpwnam(sys.argv[1]).pw_uid",
  "def process_status(name):",
  ' path="/proc/"+name+"/status"',
  " try:",
  '  with open(path,"rb",buffering=0) as handle:',
  "   raw=handle.read(65536)",
  "   if handle.read(1):",
  '    raise RuntimeError("oversized proc status")',
  " except (FileNotFoundError,ProcessLookupError):",
  "  return None",
  " except OSError as error:",
  "  if error.errno in (errno.ENOENT,errno.ESRCH):",
  "   return None",
  "  raise",
  ' uid_lines=[line for line in raw.splitlines() if line.startswith(b"Uid:")]',
  ' state_lines=[line for line in raw.splitlines() if line.startswith(b"State:")]',
  " if len(uid_lines)!=1 or len(state_lines)!=1:",
  '  raise RuntimeError("ambiguous proc status")',
  " uid_fields=uid_lines[0].split()",
  " state_fields=state_lines[0].split()",
  " if len(uid_fields)!=5 or len(state_fields)<2:",
  '  raise RuntimeError("invalid proc status")',
  " try:",
  "  process_uids=tuple(int(value) for value in uid_fields[1:])",
  " except ValueError:",
  '  raise RuntimeError("invalid proc uid")',
  " return process_uids,state_fields[1]",
  "def live_pids():",
  " result=[]",
  ' for name in os.listdir("/proc"):',
  "  if not name.isdigit():",
  "   continue",
  "  status=process_status(name)",
  "  if status is None:",
  "   continue",
  "  process_uids,state=status",
  '  if uid not in process_uids or state in (b"Z",b"X"):',
  "   continue",
  "  result.append(int(name))",
  " return result",
  "for _ in range(20):",
  " pids=live_pids()",
  " if not pids:",
  "  sys.exit(0)",
  " for pid in pids:",
  "  try:",
  "   status=process_status(str(pid))",
  "   if status is not None and uid in status[0]:",
  "    os.kill(pid,signal.SIGKILL)",
  "  except ProcessLookupError:",
  "   pass",
  " time.sleep(0.025)",
  "sys.exit(1)",
].join("\n");

const ASSERT_RELAY_PORT_FREE_SCRIPT = [
  "import socket,sys",
  "sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM)",
  "try:",
  // A stopped HTTP relay can leave harmless TIME_WAIT entries. Reuse permits
  // a trusted restart while an active listener still makes bind() fail.
  " sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)",
  ` sock.bind(("127.0.0.1",${E2B_PREVIEW_RELAY_PORT}))`,
  "except OSError:",
  " sys.exit(1)",
  "finally:",
  " sock.close()",
].join("\n");

const WAIT_FOR_RELAY_SCRIPT = [
  "import socket,sys,time",
  "request=b'GET / HTTP/1.1\\r\\nHost: relay-check\\r\\nConnection: close\\r\\n\\r\\n'",
  "for _ in range(100):",
  " try:",
  `  sock=socket.create_connection(("127.0.0.1",${E2B_PREVIEW_RELAY_PORT}),0.1)`,
  "  sock.settimeout(0.5)",
  "  sock.sendall(request)",
  "  response=b''",
  "  while len(response)<4096:",
  "   chunk=sock.recv(4096-len(response))",
  "   if not chunk:",
  "    break",
  "   response+=chunk",
  "  sock.close()",
  "  if response.startswith(b'HTTP/1.1 502') and b'Preview upstream unavailable' in response:",
  "   sys.exit(0)",
  " except OSError:",
  "  pass",
  " time.sleep(0.05)",
  "sys.exit(1)",
].join("\n");

class SdkSandboxHandle implements E2BSandboxHandle {
  private preparation: Promise<void> | undefined;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly allowRuntimeInstall: boolean,
  ) {}

  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  get trafficAccessToken(): string | undefined {
    return this.sandbox.trafficAccessToken;
  }

  async prepareExecutionEnvironment(signal?: AbortSignal): Promise<void> {
    this.preparation ??= this.prepareExecutionEnvironmentNow(signal);
    try {
      await this.preparation;
    } catch (error) {
      this.preparation = undefined;
      if (error instanceof E2BTrustedEnvironmentError) throw error;
      throw new E2BTrustedEnvironmentError("bootstrap");
    }
  }

  async quiesceProjectProcesses(signal?: AbortSignal): Promise<void> {
    await this.prepareExecutionEnvironment(signal);
    await this.killAllProcessesForUser(E2B_PROJECT_USER, "project-quiesce", signal);
  }

  async stopPreviewRelay(signal?: AbortSignal): Promise<void> {
    await this.prepareExecutionEnvironment(signal);
    await this.killAllProcessesForUser(E2B_RELAY_USER, "relay-stop", signal);
  }

  async startPreviewRelay(targetPort: number, signal?: AbortSignal): Promise<void> {
    assertE2BPreviewTargetPort(targetPort);
    await this.prepareExecutionEnvironment(signal);

    // Nothing controlled by the project may run while the trusted public port
    // is unbound. This closes both process-group escape and port-squatting
    // races before the relay starts.
    await this.quiesceProjectProcesses(signal);
    await this.stopPreviewRelay(signal);
    await this.runTrustedCommand(
      `${TRUSTED_PYTHON} -I -S -c ${shellQuote(ASSERT_RELAY_PORT_FREE_SCRIPT)}`,
      "root",
      "relay-start",
      signal,
    );
    await this.runTrustedCommand(
      `${TRUSTED_PYTHON} -I -S -c ${shellQuote(PROJECT_PRIVILEGED_PORT_PROBE)}`,
      E2B_PROJECT_USER,
      "relay-start",
      signal,
    );
    await this.assertSealedRelayRuntime("relay-start", signal);

    const startScript = [
      "set -eu",
      TRUSTED_NODE_COMMAND,
      `exec ${TRUSTED_SETSID} --fork "$quillra_node" ${shellQuote(E2B_RELAY_INSTALL_PATH)} ${targetPort} </dev/null >/dev/null 2>&1`,
    ].join("\n");
    await this.runTrustedCommand(
      privilegedRelayBootstrap(startScript),
      "root",
      "relay-start",
      signal,
    );
    try {
      await this.runTrustedCommand(
        `${TRUSTED_PYTHON} -I -S -c ${shellQuote(WAIT_FOR_RELAY_SCRIPT)}`,
        "root",
        "relay-ready",
        signal,
        10_000,
      );
    } catch (error) {
      await this.stopPreviewRelay().catch(() => undefined);
      throw error;
    }
  }

  private assertSealedRelayRuntime(
    stage: "bootstrap" | "relay-start",
    signal?: AbortSignal,
  ): Promise<void> {
    return this.runTrustedCommand(
      `${TRUSTED_PYTHON} -I -S -c ${shellQuote(SEALED_RELAY_RUNTIME_VALIDATION_SCRIPT)} ${shellQuote(E2B_RELAY_NODE_PATH)} ${shellQuote(E2B_RELAY_USER)}`,
      "root",
      stage,
      signal,
      20_000,
    );
  }

  private async prepareExecutionEnvironmentNow(signal?: AbortSignal): Promise<void> {
    await this.runTrustedCommand(
      `${TRUSTED_BASH} -c ${shellQuote(SANDBOX_BOOTSTRAP_SCRIPT)}`,
      "root",
      "bootstrap",
      signal,
      20_000,
    );

    const nodePreparationScript = [
      "set -eu",
      `quillra_relay_gid=$(/usr/bin/id -g ${E2B_RELAY_USER})`,
      ...(this.allowRuntimeInstall
        ? [
            `${TRUSTED_PYTHON} -I -S -c ${shellQuote(SEAL_RELAY_NODE_SCRIPT)} ${shellQuote(E2B_RELAY_NODE_PATH)} "$quillra_relay_gid"`,
          ]
        : []),
      `${TRUSTED_PYTHON} -I -S -c ${shellQuote(SEALED_RELAY_NODE_VALIDATION_SCRIPT)} ${shellQuote(E2B_RELAY_NODE_PATH)} "$quillra_relay_gid"`,
    ].join("\n");
    await this.runTrustedCommand(
      `${TRUSTED_BASH} -c ${shellQuote(nodePreparationScript)}`,
      "root",
      "bootstrap",
      signal,
      20_000,
    );
    await this.assertSealedRelayRuntime("bootstrap", signal);

    const uploadPath = `${E2B_RELAY_STAGING_ROOT}/relay-${randomUUID()}.mjs`;
    try {
      await this.sandbox.files.write([{ path: uploadPath, data: E2B_PREVIEW_RELAY_SOURCE }], {
        user: "root",
        signal,
      });
      const expectedHash = createHash("sha256")
        .update(E2B_PREVIEW_RELAY_SOURCE, "utf8")
        .digest("hex");
      const installScript = [
        "set -eu",
        `/usr/bin/install -o root -g ${E2B_RELAY_USER} -m 0550 ${shellQuote(uploadPath)} ${shellQuote(E2B_RELAY_INSTALL_PATH)}`,
        `quillra_relay_hash=$(/usr/bin/sha256sum ${shellQuote(E2B_RELAY_INSTALL_PATH)} | /usr/bin/cut -d ' ' -f 1)`,
        `[ "$quillra_relay_hash" = ${shellQuote(expectedHash)} ]`,
      ].join("\n");
      await this.runTrustedCommand(
        `${TRUSTED_BASH} -c ${shellQuote(installScript)}`,
        "root",
        "bootstrap",
        signal,
      );
    } catch (error) {
      if (error instanceof E2BTrustedEnvironmentError) throw error;
      throw new E2BTrustedEnvironmentError("bootstrap");
    } finally {
      await this.sandbox.files.remove(uploadPath, { user: "root" }).catch(() => undefined);
    }

    await this.runTrustedCommand(
      `${TRUSTED_BASH} -c ${shellQuote(PROJECT_ISOLATION_PROBE)}`,
      E2B_PROJECT_USER,
      "project-isolation",
      signal,
    );
    const relayProbe = [
      "set -eu",
      TRUSTED_NODE_COMMAND,
      `"$quillra_node" --check ${shellQuote(E2B_RELAY_INSTALL_PATH)} >/dev/null`,
    ].join("\n");
    await this.runTrustedCommand(
      `${TRUSTED_BASH} -c ${shellQuote(relayProbe)}`,
      E2B_RELAY_USER,
      "bootstrap",
      signal,
    );
  }

  private async killAllProcessesForUser(
    user: string,
    stage: E2BTrustedEnvironmentStage,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.runTrustedCommand(
      `${TRUSTED_PYTHON} -I -S -c ${shellQuote(KILL_USER_PROCESSES_SCRIPT)} ${shellQuote(user)}`,
      "root",
      stage,
      signal,
    );
  }

  private async runTrustedCommand(
    command: string,
    user: string,
    stage: E2BTrustedEnvironmentStage,
    signal?: AbortSignal,
    timeoutMs = 10_000,
  ): Promise<void> {
    try {
      const outerUser = user === E2B_PROJECT_USER || user === E2B_RELAY_USER ? "root" : user;
      const trustedCommand =
        user === E2B_PROJECT_USER || user === E2B_RELAY_USER
          ? isolatedUserShell(user, command)
          : command;
      const result = await this.sandbox.commands.run(trustedCommand, {
        user: outerUser,
        timeoutMs,
        requestTimeoutMs: timeoutMs,
        signal,
        envs: TRUSTED_LAUNCH_ENV,
      });
      if (result.exitCode !== 0) throw new Error("Trusted E2B command failed.");
    } catch {
      throw new E2BTrustedEnvironmentError(stage);
    }
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
    const scanCommand = `${TRUSTED_PYTHON} -I -S -c ${shellQuote(BOUNDED_DIRECTORY_SCANNER)} ${shellQuote(directory)} ${options.maxEntries} ${options.maxOutputBytes} 2>/dev/null`;
    const result = await this.sandbox.commands.run(
      isolatedUserShell(E2B_PROJECT_USER, scanCommand),
      {
        user: "root",
        timeoutMs: 10_000,
        requestTimeoutMs: 10_000,
        signal: options.signal,
        envs: TRUSTED_LAUNCH_ENV,
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

  async scanTree(treeRoot: string, options: E2BRemoteTreeOptions): Promise<E2BRemoteTreeManifest> {
    validateTreeScanOptions(options);
    const resolvedRoot = path.posix.resolve(treeRoot);
    if (
      treeRoot !== resolvedRoot ||
      !resolvedRoot.startsWith(`${E2B_PROJECT_HOME}/`) ||
      Buffer.byteLength(resolvedRoot, "utf8") > ABSOLUTE_MAX_TREE_PATH_BYTES ||
      resolvedRoot.includes("\0")
    ) {
      throw new Error("Invalid bounded E2B tree root.");
    }
    const exclusions = [...new Set(options.excludedSegments)].sort().join(",");
    const scanCommand = [
      `${TRUSTED_PYTHON} -I -S -c ${shellQuote(BOUNDED_TREE_SCANNER)}`,
      shellQuote(resolvedRoot),
      options.maxEntries,
      options.maxOutputBytes,
      options.maxDepth,
      options.maxPathBytes,
      options.maxFileBytes,
      options.maxTotalBytes,
      shellQuote(exclusions),
      "2>/dev/null",
    ].join(" ");
    const result = await this.sandbox.commands.run(
      isolatedUserShell(E2B_PROJECT_USER, scanCommand),
      {
        user: "root",
        timeoutMs: 30_000,
        requestTimeoutMs: 30_000,
        signal: options.signal,
        envs: TRUSTED_LAUNCH_ENV,
      },
    );
    if (Buffer.byteLength(result.stdout, "utf8") > options.maxOutputBytes) {
      throw new Error("E2B tree manifest exceeded its hard byte limit.");
    }
    let payload: TreeScannerResponse;
    try {
      payload = JSON.parse(result.stdout) as TreeScannerResponse;
    } catch {
      throw new Error("E2B returned an invalid bounded tree manifest.");
    }
    if (typeof payload !== "object" || payload === null || typeof payload.ok !== "boolean") {
      throw new Error("E2B returned an invalid bounded tree manifest.");
    }
    if (!payload.ok) {
      const messages: Record<Extract<TreeScannerResponse, { ok: false }>["error"], string> = {
        entry_limit: "E2B tree exceeds the workspace entry limit.",
        byte_limit: "E2B tree manifest exceeds the hard byte limit.",
        depth_limit: "E2B tree exceeds the workspace depth limit.",
        path_limit: "E2B tree contains an oversized path.",
        file_limit: "E2B tree contains an oversized file.",
        total_limit: "E2B tree exceeds the total workspace byte limit.",
        scan_failed: "E2B tree could not be inspected safely.",
      };
      if (!(payload.error in messages)) {
        throw new Error("E2B returned an invalid bounded tree manifest.");
      }
      throw new Error(messages[payload.error]);
    }
    if (
      !Array.isArray(payload.entries) ||
      payload.entries.length > options.maxEntries ||
      (payload.root !== null && (typeof payload.root !== "object" || payload.root === null))
    ) {
      throw new Error("E2B returned an invalid bounded tree manifest.");
    }

    const parseMetadata = (
      record: Omit<TreeScannerRecord, "p">,
      entryPath: string,
      name: string,
      isExcluded: boolean,
      requiresHash = true,
    ): E2BRemoteTreeEntry => {
      if (
        !["file", "dir", "special"].includes(record.t) ||
        !Number.isSafeInteger(record.s) ||
        record.s < 0 ||
        record.s > options.maxFileBytes ||
        !Number.isSafeInteger(record.m) ||
        record.m < 0 ||
        (record.l !== null && typeof record.l !== "string") ||
        (record.h !== undefined &&
          record.h !== null &&
          (typeof record.h !== "string" || !/^[a-f0-9]{64}$/.test(record.h)))
      ) {
        throw new Error("E2B returned invalid tree entry metadata.");
      }
      const symlinkTarget =
        record.l === null ? undefined : decodeFilesystemText(record.l, "symbolic-link target");
      const isRegularFile = record.t === "file" && symlinkTarget === undefined && record.s >= 0;
      if (
        (record.t !== "file" && record.h != null) ||
        (symlinkTarget !== undefined && record.h != null) ||
        (isRegularFile && requiresHash && !isExcluded && record.h == null)
      ) {
        throw new Error("E2B returned invalid tree content metadata.");
      }
      return {
        name,
        path: entryPath,
        type: record.t,
        size: record.s,
        mode: record.m,
        symlinkTarget,
        sha256: record.h ?? undefined,
      };
    };

    let totalBytes = 0;
    const seen = new Set<string>();
    const entries = payload.entries.map((record) => {
      if (!record || typeof record !== "object" || typeof record.p !== "string") {
        throw new Error("E2B returned invalid tree entry metadata.");
      }
      const relativePath = decodeFilesystemText(record.p, "filesystem path");
      const segments = relativePath.split("/");
      if (
        !relativePath ||
        path.posix.isAbsolute(relativePath) ||
        path.win32.isAbsolute(relativePath) ||
        segments.length > options.maxDepth ||
        Buffer.byteLength(relativePath, "utf8") > options.maxPathBytes ||
        segments.some(
          (segment) =>
            !segment ||
            segment === "." ||
            segment === ".." ||
            segment.includes("\\") ||
            segment.includes("\0"),
        )
      ) {
        throw new Error("E2B returned an unsafe tree path.");
      }
      const entryPath = path.posix.join(resolvedRoot, ...segments);
      if (path.posix.relative(resolvedRoot, entryPath) !== relativePath || seen.has(relativePath)) {
        throw new Error("E2B returned an unsafe tree path.");
      }
      seen.add(relativePath);
      const entry = parseMetadata(
        record,
        entryPath,
        segments.at(-1) ?? "",
        segments.some((segment) => options.excludedSegments.includes(segment)),
      );
      if (entry.type === "file") {
        totalBytes += entry.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > options.maxTotalBytes) {
          throw new Error("E2B tree exceeds the total workspace byte limit.");
        }
      }
      return entry;
    });

    const root =
      payload.root === null
        ? null
        : parseMetadata(
            payload.root,
            resolvedRoot,
            path.posix.basename(resolvedRoot),
            false,
            false,
          );
    return { root, entries };
  }

  async getInfo(path: string, signal?: AbortSignal): Promise<E2BRemoteEntry> {
    return toRemoteEntry(
      await this.sandbox.files.getInfo(path, { user: E2B_PROJECT_USER, signal }),
    );
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
    const readCommand = `${TRUSTED_DD} if=${shellQuote(filePath)} iflag=skip_bytes,count_bytes skip=${offset} count=${length} status=none 2>/dev/null | ${TRUSTED_BASE64}`;
    const result = await this.sandbox.commands.run(
      isolatedUserShell(E2B_PROJECT_USER, readCommand),
      {
        user: "root",
        timeoutMs: 10_000,
        requestTimeoutMs: 10_000,
        signal,
        envs: TRUSTED_LAUNCH_ENV,
      },
    );
    const decoded = Buffer.from(result.stdout.replaceAll(/\s/g, ""), "base64");
    if (decoded.byteLength > length) {
      throw new Error("E2B returned more file data than requested.");
    }
    return Uint8Array.from(decoded);
  }

  async writeFiles(
    files: Array<{ path: string; data: Uint8Array; mode?: number }>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (files.length === 0) return;
    const modeRequests = files.flatMap((file): Array<[string, number]> => {
      if (file.mode === undefined) return [];
      if (!Number.isSafeInteger(file.mode) || file.mode < 0) {
        throw new Error("Invalid E2B file mode.");
      }
      const resolved = path.posix.resolve(file.path);
      const relative = path.posix.relative(E2B_PROJECT_HOME, resolved);
      if (
        resolved !== file.path ||
        !relative ||
        relative.startsWith("../") ||
        relative.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
        Buffer.byteLength(relative, "utf8") > ABSOLUTE_MAX_TREE_PATH_BYTES
      ) {
        throw new Error("Invalid E2B file mode path.");
      }
      return [[relative, file.mode & 0o111 ? 0o755 : 0o644]];
    });
    if (modeRequests.length > 256) {
      throw new Error("Too many E2B file mode requests.");
    }
    const encodedModeRequests = Buffer.from(JSON.stringify(modeRequests), "utf8").toString(
      "base64",
    );
    if (Buffer.byteLength(encodedModeRequests, "utf8") > 256 * 1024) {
      throw new Error("E2B file mode request is too large.");
    }
    await this.sandbox.files.write(
      files.map((file) => ({
        path: file.path,
        data: Uint8Array.from(file.data).buffer,
      })),
      { gzip: true, user: E2B_PROJECT_USER, signal },
    );
    if (modeRequests.length > 0) {
      const command = `${TRUSTED_PYTHON} -I -S -c ${shellQuote(APPLY_FILE_MODES_SCRIPT)} ${shellQuote(E2B_PROJECT_HOME)} ${shellQuote(encodedModeRequests)} >/dev/null 2>/dev/null`;
      const result = await this.sandbox.commands.run(isolatedUserShell(E2B_PROJECT_USER, command), {
        user: "root",
        timeoutMs: 10_000,
        requestTimeoutMs: 10_000,
        signal,
        envs: TRUSTED_LAUNCH_ENV,
      });
      if (result.exitCode !== 0) {
        throw new Error("E2B could not apply a safe file mode.");
      }
    }
  }

  async makeDir(path: string, signal?: AbortSignal): Promise<void> {
    await this.sandbox.files.makeDir(path, { user: E2B_PROJECT_USER, signal });
  }

  exists(path: string, signal?: AbortSignal): Promise<boolean> {
    return this.sandbox.files.exists(path, { user: E2B_PROJECT_USER, signal });
  }

  async remove(path: string, signal?: AbortSignal): Promise<void> {
    await this.sandbox.files.remove(path, { user: E2B_PROJECT_USER, signal });
  }

  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await this.sandbox.files.rename(from, to, { user: E2B_PROJECT_USER, signal });
  }

  async startCommand(command: string, options: E2BCommandOptions): Promise<E2BProcess> {
    const maxOutputBytes = validateOutputLimit(options.maxOutputBytes);
    const projectPathPrefix = validateProjectPathPrefix(options.projectPathPrefix);
    const logDirectory = `${PROCESS_LOG_ROOT}/${randomUUID()}`;
    const stdoutFile = `${logDirectory}/stdout`;
    const stderrFile = `${logDirectory}/stderr`;
    // Every operation beneath the project-owned home runs as the project UID.
    // If an attacker replaces this path with a system-directory symlink, these
    // calls fail without granting a root chown/chmod primitive.
    await this.sandbox.files.makeDir(PROCESS_LOG_ROOT, {
      user: E2B_PROJECT_USER,
      signal: options.signal,
    });
    await this.sandbox.files.makeDir(logDirectory, {
      user: E2B_PROJECT_USER,
      signal: options.signal,
    });
    await this.sandbox.files.write(
      [
        { path: stdoutFile, data: "" },
        { path: stderrFile, data: "" },
      ],
      { user: E2B_PROJECT_USER, signal: options.signal },
    );
    const handle = await this.sandbox.commands.run(
      boundedCommandWrapper({
        command,
        logDirectory,
        maxOutputBytes,
        envs: options.envs,
        projectPathPrefix,
      }),
      {
        background: true,
        user: "root",
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        requestTimeoutMs: Math.min(options.timeoutMs, BACKGROUND_COMMAND_REQUEST_TIMEOUT_MS),
        signal: options.signal,
        envs: TRUSTED_LAUNCH_ENV,
        // Deliberately no stdout/stderr callbacks. The wrapped command redirects
        // both streams before the SDK can accumulate them.
      },
    );
    let waitPromise: Promise<E2BCommandResult> | undefined;
    const readBoundedLog = async (filePath: string): Promise<string> => {
      // Never use files.read for a path the sandbox command can replace between
      // stat and read (symlink, FIFO, /dev/zero, or a growing file). This fixed
      // control command can emit at most maxOutputBytes into the SDK.
      const readCommand = `${TRUSTED_HEAD} -c ${maxOutputBytes} -- ${shellQuote(filePath)} 2>/dev/null || true`;
      const result = await this.sandbox.commands.run(
        isolatedUserShell(E2B_PROJECT_USER, readCommand),
        {
          user: "root",
          timeoutMs: 5_000,
          requestTimeoutMs: 5_000,
          envs: TRUSTED_LAUNCH_ENV,
        },
      );
      return result.stdout;
    };
    const killGroup = async (): Promise<void> => {
      const killCommand = `${TRUSTED_KILL} -KILL -- -${handle.pid} >/dev/null 2>&1 || true`;
      await this.sandbox.commands
        .run(isolatedUserShell(E2B_PROJECT_USER, killCommand), {
          user: "root",
          timeoutMs: 5_000,
          requestTimeoutMs: 5_000,
          envs: TRUSTED_LAUNCH_ENV,
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
          }
          // Never signal the numeric process group after wait has observed its
          // leader exit: Linux may already have reused that PID for a newer
          // preview. Runtime callers quiesce the whole project UID before
          // writeback, restart, or relay teardown.
          const stdout = await readBoundedLog(stdoutFile);
          const stderr = await readBoundedLog(stderrFile);
          if (options.onStdout && stdout) await options.onStdout(stdout);
          if (options.onStderr && stderr) await options.onStderr(stderr);
          return { ...commandResult, stdout, stderr };
        })().finally(async () => {
          await this.sandbox.files
            .remove(logDirectory, { user: E2B_PROJECT_USER })
            .catch(() => undefined);
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
    const killCommand = `${TRUSTED_KILL} -KILL -- -${pid} >/dev/null 2>&1 || true`;
    await this.sandbox.commands
      .run(isolatedUserShell(E2B_PROJECT_USER, killCommand), {
        user: "root",
        timeoutMs: 5_000,
        requestTimeoutMs: 5_000,
        signal,
        envs: TRUSTED_LAUNCH_ENV,
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

async function cleanupFailedSandbox(
  sandboxId: string,
  options: Pick<E2BCreateOptions, "apiKey" | "requestTimeoutMs">,
): Promise<"confirmed" | "failed"> {
  try {
    await Sandbox.kill(sandboxId, {
      apiKey: options.apiKey,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    return "confirmed";
  } catch {
    return "failed";
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
      allowInternetAccess: options.allowInternetAccess,
      lifecycle:
        options.lifecycle ??
        ({
          onTimeout: "pause",
          autoResume: true,
        } as const),
      network: {
        allowPublicTraffic: false,
        ...(options.allowInternetAccess === false
          ? {
              denyOut: ({ allTraffic }: { allTraffic: string }) => [allTraffic],
            }
          : {}),
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
    const handle = new SdkSandboxHandle(sandbox, true);
    try {
      await options.onSandboxCreated?.(sandbox.sandboxId);
      await handle.prepareExecutionEnvironment(options.signal);
      return handle;
    } catch (error) {
      const cleanupStatus = await cleanupFailedSandbox(sandbox.sandboxId, options);
      throw new E2BTrustedEnvironmentError(
        error instanceof E2BTrustedEnvironmentError ? error.stage : "bootstrap",
        cleanupStatus,
        sandbox.sandboxId,
      );
    }
  }

  async connect(sandboxId: string, options: E2BConnectOptions): Promise<E2BSandboxHandle> {
    const sandbox = await Sandbox.connect(sandboxId, {
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      signal: options.signal,
    });
    const handle = new SdkSandboxHandle(sandbox, false);
    try {
      await handle.prepareExecutionEnvironment(options.signal);
      return handle;
    } catch (error) {
      const cleanupStatus = await cleanupFailedSandbox(sandbox.sandboxId, options);
      throw new E2BTrustedEnvironmentError(
        error instanceof E2BTrustedEnvironmentError ? error.stage : "bootstrap",
        cleanupStatus,
        sandbox.sandboxId,
      );
    }
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
