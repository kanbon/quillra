import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FINGERPRINT_VERSION = 2;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 40;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([".git", ".quillra-temp", "node_modules"]);
const ROOT_DEPENDENCY_FILES = new Set([
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.js",
  ".yarnrc",
  ".yarnrc.yml",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
]);
const CACHE_BLOCKING_ROOT_PATHS = [
  ".pnp.cjs",
  ".pnp.js",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  ".pnpmfile.js",
  ".yarn",
  ".patches",
  "patches",
] as const;
const LOCAL_DEPENDENCY_PROTOCOL = /\b(?:file|link|patch|portal):[^\s"',}\]]+/i;
const PNP_NODE_LINKER = /["']?node[-_]?linker["']?\s*[:=]\s*["']?pnp\b/i;
const EXTERNAL_INSTALL_ARTIFACT =
  /\b(?:configDependencies|global[-_]?pnpmfile|patchedDependencies|pnpmfile|yarnPath)\b/i;
const INSTALL_LIFECYCLE_SCRIPT = /"(?:install|postinstall|preinstall|prepare)"\s*:/;

type PackageManagerFingerprint = {
  name: "npm" | "pnpm" | "yarn";
  version: string | null;
};

function hasCacheBlockingRootPath(root: string): boolean {
  return CACHE_BLOCKING_ROOT_PATHS.some((relativePath) =>
    fs.existsSync(path.join(root, relativePath)),
  );
}

function metadataRequiresExternalInstallArtifacts(data: Buffer): boolean {
  const text = data.toString("utf8");
  return (
    LOCAL_DEPENDENCY_PROTOCOL.test(text) ||
    PNP_NODE_LINKER.test(text) ||
    EXTERNAL_INSTALL_ARTIFACT.test(text) ||
    INSTALL_LIFECYCLE_SCRIPT.test(text)
  );
}

function dependencyInputPaths(repoPath: string): string[] {
  const inputs: string[] = [];
  let entries = 0;

  const visit = (directory: string, relativeDirectory: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      throw new Error("The project dependency layout exceeds Quillra's depth limit.");
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ENTRIES) {
        throw new Error("The project dependency layout exceeds Quillra's entry limit.");
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Dependency metadata cannot be a symbolic link: ${entry.name}`);
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          visit(absolutePath, relativePath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (
        entry.name === "package.json" ||
        (!relativeDirectory && ROOT_DEPENDENCY_FILES.has(entry.name))
      ) {
        inputs.push(relativePath);
      }
    }
  };

  visit(repoPath, "", 0);
  return inputs.sort((left, right) => left.localeCompare(right));
}

/**
 * Identifies the dependency tree that belongs in one project's E2B preview.
 * Source-only edits deliberately keep the same value; package manifests,
 * lockfiles, manager selection, and package-manager config invalidate it.
 */
export function dependencyInstallFingerprint(
  repoPath: string,
  packageManager: PackageManagerFingerprint,
): string | undefined {
  const root = fs.realpathSync.native(path.resolve(repoPath));
  // Yarn installs can generate required state outside node_modules (.pnp.*,
  // .yarn/cache, plugins and custom releases). The preview sync deliberately
  // reconciles those project paths, so a node_modules marker cannot prove
  // that a previous Yarn install is still complete.
  if (packageManager.name === "yarn" || hasCacheBlockingRootPath(root)) {
    return undefined;
  }
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      version: FINGERPRINT_VERSION,
      packageManager,
    }),
  );

  let totalBytes = 0;
  for (const relativePath of dependencyInputPaths(root)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const info = fs.lstatSync(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Dependency metadata must be a regular file: ${relativePath}`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`Dependency metadata exceeds Quillra's file limit: ${relativePath}`);
    }
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("Project dependency metadata exceeds Quillra's total size limit.");
    }
    const data = fs.readFileSync(absolutePath);
    // Local/file dependencies and install hooks can depend on bytes outside
    // the bounded metadata set. pnpm PnP also generates .pnp files outside
    // node_modules. Re-run setup instead of risking a false warm-cache hit.
    if (metadataRequiresExternalInstallArtifacts(data)) {
      return undefined;
    }
    hash.update("\0");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(data.byteLength));
    hash.update("\0");
    hash.update(data);
  }
  return `v${FINGERPRINT_VERSION}:${hash.digest("hex")}`;
}
