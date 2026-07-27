import fs from "node:fs";
import path from "node:path";

export const MAX_PROJECT_PACKAGE_JSON_BYTES = 1024 * 1024;

export type ProjectPackageJson = {
  packageManager?: unknown;
  devEngines?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  volta?: unknown;
  engines?: unknown;
};

function isMissingOrSymlink(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/**
 * Reads the project manifest through one O_NOFOLLOW file descriptor. The
 * descriptor is checked and read directly so a repository cannot swap a
 * previously inspected path for a host-file symlink between stat and read.
 */
export function readProjectPackageJson(repoPath: string): ProjectPackageJson | null {
  const manifestPath = path.join(repoPath, "package.json");
  let descriptor: number;
  try {
    descriptor = fs.openSync(manifestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingOrSymlink(error)) return null;
    throw error;
  }

  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile()) return null;
    if (info.size > MAX_PROJECT_PACKAGE_JSON_BYTES) {
      throw new Error("package.json exceeds Quillra's 1 MiB inspection limit.");
    }

    const bytes = Buffer.alloc(MAX_PROJECT_PACKAGE_JSON_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset > MAX_PROJECT_PACKAGE_JSON_BYTES) {
      throw new Error("package.json exceeds Quillra's 1 MiB inspection limit.");
    }

    const parsed = JSON.parse(bytes.subarray(0, offset).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ProjectPackageJson;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}
