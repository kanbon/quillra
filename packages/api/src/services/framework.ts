/**
 * Framework detection. Inspects a project repo to identify which static-site
 * framework (if any) is in use, so we can pick a sensible asset destination
 * and decide whether the framework will optimise images at build time.
 */
import fs from "node:fs";
import path from "node:path";

export type FrameworkInfo = {
  id: string;
  label: string;
  /** Repo-relative directory where new image assets should be written */
  assetsDir: string;
  /** True if the framework produces optimised image variants at build time */
  optimizes: boolean;
};

const UNKNOWN: FrameworkInfo = {
  id: "unknown",
  label: "Static site",
  assetsDir: "images",
  optimizes: false,
};

type CacheEntry = { mtimeMs: number; info: FrameworkInfo };
const cache = new Map<string, CacheEntry>();

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasDep(pkg: Record<string, unknown> | null, name: string): boolean {
  if (!pkg) return false;
  const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
  return name in deps;
}

function detect(repoPath: string): FrameworkInfo {
  const pkgPath = path.join(repoPath, "package.json");
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;

  if (hasDep(pkg, "astro")) {
    return { id: "astro", label: "Astro", assetsDir: "src/assets", optimizes: true };
  }
  if (hasDep(pkg, "next")) {
    return { id: "next", label: "Next.js", assetsDir: "public/images", optimizes: true };
  }
  if (hasDep(pkg, "nuxt") || hasDep(pkg, "nuxt3")) {
    const optimizes = hasDep(pkg, "@nuxt/image");
    return { id: "nuxt", label: "Nuxt", assetsDir: "public/images", optimizes };
  }
  if (hasDep(pkg, "gatsby")) {
    return { id: "gatsby", label: "Gatsby", assetsDir: "src/images", optimizes: true };
  }
  if (hasDep(pkg, "@sveltejs/kit")) {
    return { id: "sveltekit", label: "SvelteKit", assetsDir: "static/images", optimizes: false };
  }
  if (hasDep(pkg, "@11ty/eleventy")) {
    return { id: "eleventy", label: "Eleventy", assetsDir: "src/images", optimizes: false };
  }
  if (hasDep(pkg, "remix") || hasDep(pkg, "@remix-run/react")) {
    return { id: "remix", label: "Remix", assetsDir: "public/images", optimizes: false };
  }

  // Non-Node frameworks
  if (
    fs.existsSync(path.join(repoPath, "hugo.toml")) ||
    fs.existsSync(path.join(repoPath, "hugo.yaml")) ||
    fs.existsSync(path.join(repoPath, "config.toml")) ||
    fs.existsSync(path.join(repoPath, "config.yaml"))
  ) {
    if (fs.existsSync(path.join(repoPath, "content"))) {
      return { id: "hugo", label: "Hugo", assetsDir: "static/images", optimizes: false };
    }
  }
  if (
    fs.existsSync(path.join(repoPath, "_config.yml")) ||
    fs.existsSync(path.join(repoPath, "_config.yaml"))
  ) {
    return { id: "jekyll", label: "Jekyll", assetsDir: "assets/images", optimizes: false };
  }

  return UNKNOWN;
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
    // No package.json — still cache by repo path with mtime 0
  }
  const cached = cache.get(repoPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.info;

  const info = detect(repoPath);
  cache.set(repoPath, { mtimeMs, info });
  return info;
}
