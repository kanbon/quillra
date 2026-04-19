/**
 * Framework detection, thin wrapper around the central registry.
 *
 * The registry in framework-registry.ts is the single source of truth for
 * every framework Quillra supports (label, icon, dev command, assets dir,
 * detection rules). This file just inspects a cloned repo on disk and
 * matches it against the registry, with mtime-based caching.
 */
import fs from "node:fs";
import path from "node:path";
import { type FrameworkDef, detectFromManifest } from "./framework-registry.js";

export type FrameworkInfo = {
  id: string;
  label: string;
  iconSlug: string;
  color: string;
  /** Repo-relative directory where new image assets should be written */
  assetsDir: string;
  /** True if the framework produces optimised image variants at build time */
  optimizes: boolean;
};

const UNKNOWN: FrameworkInfo = {
  id: "unknown",
  label: "Static site",
  iconSlug: "html5",
  color: "#737373",
  assetsDir: "images",
  optimizes: false,
};

function defToInfo(def: FrameworkDef): FrameworkInfo {
  return {
    id: def.id,
    label: def.label,
    iconSlug: def.iconSlug,
    color: def.color,
    assetsDir: def.assetsDir,
    optimizes: def.optimizes,
  };
}

type CacheEntry = { mtimeMs: number; info: FrameworkInfo };
const cache = new Map<string, CacheEntry>();

function readJson(
  file: string,
): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function detect(repoPath: string): FrameworkInfo {
  const pkgPath = path.join(repoPath, "package.json");
  const packageJson = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;
  let rootFiles: string[] = [];
  try {
    rootFiles = fs.readdirSync(repoPath);
  } catch {
    /* ignore */
  }
  const def = detectFromManifest({ packageJson, rootFiles });
  return def ? defToInfo(def) : UNKNOWN;
}

/**
 * Detect the framework for a project repo. Cached by package.json mtime so
 * we re-check whenever dependencies change.
 */
export function detectFramework(repoPath: string): FrameworkInfo {
  const pkgPath = path.join(repoPath, "package.json");
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(pkgPath).mtimeMs;
  } catch {
    // No package.json, still cache by repo path with mtime 0
  }
  const cached = cache.get(repoPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.info;

  const info = detect(repoPath);
  cache.set(repoPath, { mtimeMs, info });
  return info;
}
