import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import path from "node:path";
import {
  parseProjectDevEngineEntries,
  projectDevEngineFailureIsBlocking,
  validateProjectDevEngineVersionRange,
} from "./dev-engines.js";
import { E2B_PROJECT_HOME } from "./e2b-preview-relay.js";

export const DEFAULT_E2B_NODE_VERSION = "22.23.1";
export const SECONDARY_E2B_NODE_VERSION = "24.18.0";
export const E2B_COREPACK_VERSION = "0.34.7";

const RUNTIME_LAYOUT_VERSION = 1;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_VERSION_FILE_BYTES = 4 * 1024;
const VERSION_SELECTOR_MAX_BYTES = 128;

export type E2BNodeVersionSource =
  | "volta"
  | ".nvmrc"
  | ".node-version"
  | ".tool-versions"
  | "devEngines.runtime"
  | "engines"
  | "package-default"
  | "preview-default";

export type E2BNodeRuntimeRequest = {
  source: E2BNodeVersionSource;
  selector: string;
  preferredSelectors?: string[];
  fallbackOnUnsupported?: boolean;
};

export type E2BNodeRuntimePlan = E2BNodeRuntimeRequest & {
  runtimeId: string;
  runtimeRoot: string;
  pathPrefix: string;
  environment: {
    COREPACK_DEFAULT_TO_LATEST: "0";
    COREPACK_ENABLE_AUTO_PIN: "0";
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0";
    COREPACK_ENV_FILE: "0";
    COREPACK_ENABLE_PROJECT_SPEC: "0";
    COREPACK_HOME: string;
  };
  bootstrapCommand: string;
};

type RuntimeSources = {
  packageJson?: string;
  nvmrc?: string;
  nodeVersion?: string;
  toolVersions?: string;
};

type PackageJsonRuntime = {
  volta?: { node?: unknown };
  devEngines?: {
    runtime?: unknown;
  };
  engines?: { node?: unknown };
};

function firstMeaningfulLine(value: string): string | undefined {
  for (const line of value.split(/\r?\n/)) {
    const withoutComment = line.replace(/(?:^|\s+)#.*$/, "").trim();
    if (withoutComment) return withoutComment;
  }
  return undefined;
}

function toolVersionsNodeSelector(value: string): string | undefined {
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/(?:^|\s+)#.*$/, "").trim();
    if (!line) continue;
    const [tool, selector] = line.split(/\s+/);
    if ((tool === "node" || tool === "nodejs") && selector) return selector;
  }
  return undefined;
}

function normalizeNodeSelector(value: string, source: E2BNodeVersionSource): string {
  let selector = value.trim();
  if (/^v\d/i.test(selector)) selector = selector.slice(1);

  const alias = selector.toLowerCase();
  if (alias === "lts/*" || alias === "lts/krypton") return SECONDARY_E2B_NODE_VERSION;
  if (alias === "lts/jod") return DEFAULT_E2B_NODE_VERSION;
  if (alias === "lts/iron") return "20";
  if (selector === "*" && (source === "engines" || source === "devEngines.runtime")) {
    return DEFAULT_E2B_NODE_VERSION;
  }
  if (alias === "node" || alias === "stable" || alias === "default") {
    throw new Error(`Unsupported Node.js version selector in ${source}.`);
  }

  if (
    !selector ||
    Buffer.byteLength(selector, "utf8") > VERSION_SELECTOR_MAX_BYTES ||
    !/\d/.test(selector) ||
    !/^[0-9A-Za-z*+.<>=^~| -]+$/.test(selector) ||
    /(?:^|\s)(?:file|git|https?)(?:\s|$)/i.test(selector)
  ) {
    throw new Error(`Unsupported Node.js version selector in ${source}.`);
  }
  if (source === "engines" || source === "devEngines.runtime") {
    validateProjectDevEngineVersionRange(selector, source);
  }
  return selector;
}

function parsePackageJson(value: string | undefined): PackageJsonRuntime | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PackageJsonRuntime)
      : {};
  } catch {
    // A malformed package.json will fail at the package-manager boundary. It
    // still identifies a JavaScript project, so give it the deterministic
    // Node 22 fallback instead of silently using the old template runtime.
    return {};
  }
}

function intersectEngineRange(engineRange: string, version: string): string {
  return engineRange
    .split("||")
    .map((clause) => `${clause.trim()} ${version}`)
    .join(" || ");
}

function devEnginesRuntimeRequest(value: unknown): E2BNodeRuntimeRequest | null {
  const entries = parseProjectDevEngineEntries(value, "devEngines.runtime");
  if (entries.length === 0) return null;

  const selectors: string[] = [];
  let firstError: Error | undefined;
  for (const entry of entries) {
    if (entry.name !== "node") {
      firstError ??= new Error(
        `Unsupported runtime "${entry.name}" in devEngines.runtime. Quillra supports Node.js.`,
      );
      continue;
    }
    try {
      selectors.push(
        entry.version === undefined
          ? DEFAULT_E2B_NODE_VERSION
          : normalizeNodeSelector(entry.version, "devEngines.runtime"),
      );
    } catch (error) {
      firstError ??=
        error instanceof Error ? error : new Error("Quillra could not resolve devEngines.runtime.");
    }
  }

  const blocking = projectDevEngineFailureIsBlocking(entries);
  if (selectors.length === 0) {
    if (!blocking) return null;
    throw firstError ?? new Error("devEngines.runtime has no supported alternative.");
  }

  const selector = selectors.join(" || ");
  return {
    source: "devEngines.runtime",
    selector,
    ...(selectors.length === 1 && /^\d+\.\d+\.\d+$/.test(selector)
      ? {}
      : {
          preferredSelectors: [
            intersectEngineRange(selector, DEFAULT_E2B_NODE_VERSION),
            intersectEngineRange(selector, SECONDARY_E2B_NODE_VERSION),
          ],
        }),
    ...(!blocking ? { fallbackOnUnsupported: true } : {}),
  };
}

export function resolveE2BNodeRuntimeRequest(
  sources: RuntimeSources,
): E2BNodeRuntimeRequest | null {
  const packageJson = parsePackageJson(sources.packageJson);
  const voltaNode = packageJson?.volta?.node;
  if (typeof voltaNode === "string" && voltaNode.trim()) {
    return {
      source: "volta",
      selector: normalizeNodeSelector(voltaNode, "volta"),
    };
  }

  const nvmrc = sources.nvmrc === undefined ? undefined : firstMeaningfulLine(sources.nvmrc);
  if (nvmrc) {
    return {
      source: ".nvmrc",
      selector: normalizeNodeSelector(nvmrc, ".nvmrc"),
    };
  }

  const nodeVersion =
    sources.nodeVersion === undefined ? undefined : firstMeaningfulLine(sources.nodeVersion);
  if (nodeVersion) {
    return {
      source: ".node-version",
      selector: normalizeNodeSelector(nodeVersion, ".node-version"),
    };
  }

  const toolVersion =
    sources.toolVersions === undefined ? undefined : toolVersionsNodeSelector(sources.toolVersions);
  if (toolVersion) {
    return {
      source: ".tool-versions",
      selector: normalizeNodeSelector(toolVersion, ".tool-versions"),
    };
  }

  if (packageJson?.devEngines && Object.hasOwn(packageJson.devEngines, "runtime")) {
    const developmentRuntime = devEnginesRuntimeRequest(packageJson.devEngines.runtime);
    if (developmentRuntime) return developmentRuntime;
  }

  const engineNode = packageJson?.engines?.node;
  if (typeof engineNode === "string" && engineNode.trim()) {
    const selector = normalizeNodeSelector(engineNode, "engines");
    return {
      source: "engines",
      selector,
      // Prefer the maintained Node 22 fallback whenever it satisfies the
      // declared range, then the current Node 24 LTS. Only if neither LTS
      // satisfies the project does bootstrap resolve the original range.
      preferredSelectors: [
        intersectEngineRange(selector, DEFAULT_E2B_NODE_VERSION),
        intersectEngineRange(selector, SECONDARY_E2B_NODE_VERSION),
      ],
    };
  }

  if (sources.packageJson !== undefined) {
    return {
      source: "package-default",
      selector: DEFAULT_E2B_NODE_VERSION,
    };
  }
  return null;
}

async function readBoundedRegularFile(
  localRoot: string,
  name: string,
  maxBytes: number,
): Promise<string | undefined> {
  const filePath = path.join(localRoot, name);
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    if (info.size > maxBytes) {
      throw new Error(`${name} exceeds Quillra's Node runtime metadata limit.`);
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new Error(`${name} exceeds Quillra's Node runtime metadata limit.`);
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function bootstrapCommand(request: E2BNodeRuntimeRequest, runtimeId: string): string {
  const runtimeRoot = `${E2B_PROJECT_HOME}/.quillra/node-runtimes/${runtimeId}`;
  const parseNpmVersionJson = [
    'let input="";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data",chunk=>{input+=chunk});',
    'process.stdin.on("end",()=>{',
    " try {",
    "  const parsed=JSON.parse(input);",
    "  const values=Array.isArray(parsed)?parsed:[parsed];",
    '  const versions=values.filter(value=>typeof value==="string").map(value=>value.replace(/^v/,"")).filter(value=>/^\\d+\\.\\d+\\.\\d+$/.test(value));',
    "  const selected=versions.at(-1);",
    "  if(!selected) process.exit(1);",
    "  process.stdout.write(selected);",
    " } catch { process.exit(1); }",
    "});",
  ].join("");
  return [
    "set -euo pipefail",
    `runtime_id=${shellQuote(runtimeId)}`,
    `runtime_root=${shellQuote(runtimeRoot)}`,
    `selector=${shellQuote(request.selector)}`,
    `preferred_selectors=(${(request.preferredSelectors ?? []).map(shellQuote).join(" ")})`,
    `fallback_node=${shellQuote(request.fallbackOnUnsupported ? DEFAULT_E2B_NODE_VERSION : "")}`,
    `corepack_version=${shellQuote(E2B_COREPACK_VERSION)}`,
    'marker="$runtime_root/.quillra-runtime"',
    'if [ -x "$runtime_root/bin/node" ] && [ -x "$runtime_root/bin/corepack" ] && [ -f "$marker" ]; then',
    '  read -r marker_id marker_node marker_corepack < "$marker" || true',
    '  if [ "$marker_id" = "$runtime_id" ] && [ "$marker_corepack" = "$corepack_version" ] && [ "$("$runtime_root/bin/node" --version)" = "v$marker_node" ] && [ "$(PATH="$runtime_root/bin:$PATH" "$runtime_root/bin/corepack" --version)" = "$corepack_version" ]; then',
    "    exit 0",
    "  fi",
    "fi",
    "resolve_selector() {",
    '  candidate="$1"',
    '  if [[ "$candidate" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
    '    printf "%s" "$candidate"',
    "    return",
    "  fi",
    `  npm view --json "node@$candidate" version | node -e ${shellQuote(parseNpmVersionJson)}`,
    "}",
    'resolved=""',
    'for preferred_selector in "${preferred_selectors[@]}"; do',
    '  resolved="$(resolve_selector "$preferred_selector" 2>/dev/null || true)"',
    '  [ -n "$resolved" ] && break',
    "done",
    'if [ -z "$resolved" ]; then',
    '  resolved="$(resolve_selector "$selector" 2>/dev/null || true)"',
    "fi",
    'if [[ ! "$resolved" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
    '  if [ -n "$fallback_node" ]; then',
    '    resolved="$fallback_node"',
    "  else",
    '    echo "Quillra could not resolve the requested Node.js version." >&2',
    "    exit 1",
    "  fi",
    "fi",
    'IFS=. read -r node_major node_minor _node_patch <<< "$resolved"',
    'if ! { { [ "$node_major" -eq 20 ] && [ "$node_minor" -ge 10 ]; } || { [ "$node_major" -eq 22 ] && [ "$node_minor" -ge 11 ]; } || [ "$node_major" -ge 24 ]; }; then',
    '  if [ -n "$fallback_node" ]; then',
    '    resolved="$fallback_node"',
    '    IFS=. read -r node_major node_minor _node_patch <<< "$resolved"',
    "  else",
    `    echo "Quillra's pinned Corepack ${E2B_COREPACK_VERSION} requires Node.js 20.10+, 22.11+, or 24+." >&2`,
    "    exit 1",
    "  fi",
    "fi",
    'case "$(/usr/bin/uname -m)" in',
    '  x86_64) node_arch="x64" ;;',
    '  aarch64|arm64) node_arch="arm64" ;;',
    '  *) echo "Quillra does not support this E2B CPU architecture." >&2; exit 1 ;;',
    "esac",
    'archive_name="node-v${resolved}-linux-${node_arch}.tar.xz"',
    'distribution_url="https://nodejs.org/dist/v${resolved}"',
    'parent="${runtime_root%/*}"',
    'staging="${runtime_root}.tmp.$$"',
    '/bin/rm -rf -- "$staging"',
    '/usr/bin/mkdir -p -- "$parent" "$staging"',
    "trap '/bin/rm -rf -- \"$staging\"' EXIT",
    '/usr/bin/curl --fail --silent --show-error --location --retry 2 --output "$staging/$archive_name" "$distribution_url/$archive_name"',
    '/usr/bin/curl --fail --silent --show-error --location --retry 2 --output "$staging/SHASUMS256.txt" "$distribution_url/SHASUMS256.txt"',
    'expected_checksum="$(/usr/bin/awk -v name="$archive_name" \'$2 == name { print $1 }\' "$staging/SHASUMS256.txt")"',
    'actual_checksum="$(/usr/bin/sha256sum "$staging/$archive_name" | /usr/bin/awk \'{ print $1 }\')"',
    'if [ -z "$expected_checksum" ] || [ "$actual_checksum" != "$expected_checksum" ]; then',
    '  echo "The official Node.js archive checksum did not match." >&2',
    "  exit 1",
    "fi",
    '/usr/bin/tar -xJf "$staging/$archive_name" --strip-components=1 -C "$staging"',
    '/bin/rm -f -- "$staging/$archive_name" "$staging/SHASUMS256.txt"',
    '"$staging/bin/node" "$staging/lib/node_modules/npm/bin/npm-cli.js" install --global --prefix "$staging" --force --ignore-scripts --no-audit --no-fund "corepack@$corepack_version"',
    'if [ "$("$staging/bin/node" --version)" != "v$resolved" ] || [ "$(PATH="$staging/bin:$PATH" "$staging/bin/corepack" --version)" != "$corepack_version" ]; then',
    '  echo "The project Node.js runtime failed its post-install check." >&2',
    "  exit 1",
    "fi",
    'printf "%s %s %s\\n" "$runtime_id" "$resolved" "$corepack_version" > "$staging/.quillra-runtime"',
    '/bin/rm -rf -- "$runtime_root"',
    '/usr/bin/mv -- "$staging" "$runtime_root"',
    "trap - EXIT",
  ].join("\n");
}

export function createE2BNodeRuntimePlan(request: E2BNodeRuntimeRequest): E2BNodeRuntimePlan {
  const runtimeId = createHash("sha256")
    .update(
      JSON.stringify({
        corepack: E2B_COREPACK_VERSION,
        layout: RUNTIME_LAYOUT_VERSION,
        request,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  const runtimeRoot = `${E2B_PROJECT_HOME}/.quillra/node-runtimes/${runtimeId}`;
  return {
    ...request,
    runtimeId,
    runtimeRoot,
    pathPrefix: `${runtimeRoot}/bin`,
    environment: {
      COREPACK_DEFAULT_TO_LATEST: "0",
      COREPACK_ENABLE_AUTO_PIN: "0",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      COREPACK_ENV_FILE: "0",
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      COREPACK_HOME: `${runtimeRoot}/corepack-cache`,
    },
    bootstrapCommand: bootstrapCommand(request, runtimeId),
  };
}

export async function resolveProjectE2BNodeRuntime(
  localRoot: string,
  options: { defaultWhenMissing?: boolean } = {},
): Promise<E2BNodeRuntimePlan | null> {
  const [packageJson, nvmrc, nodeVersion, toolVersions] = await Promise.all([
    readBoundedRegularFile(localRoot, "package.json", MAX_PACKAGE_JSON_BYTES),
    readBoundedRegularFile(localRoot, ".nvmrc", MAX_VERSION_FILE_BYTES),
    readBoundedRegularFile(localRoot, ".node-version", MAX_VERSION_FILE_BYTES),
    readBoundedRegularFile(localRoot, ".tool-versions", MAX_VERSION_FILE_BYTES),
  ]);
  const request =
    resolveE2BNodeRuntimeRequest({
      packageJson,
      nvmrc,
      nodeVersion,
      toolVersions,
    }) ??
    (options.defaultWhenMissing
      ? {
          source: "preview-default" as const,
          selector: DEFAULT_E2B_NODE_VERSION,
        }
      : null);
  return request ? createE2BNodeRuntimePlan(request) : null;
}
