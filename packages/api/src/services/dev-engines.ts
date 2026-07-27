import { validRange } from "semver";

export type ProjectDevEngineOnFail = "error" | "warn" | "ignore" | "download";

export type ProjectDevEngineEntry = {
  name: string;
  version?: string;
  onFail?: ProjectDevEngineOnFail;
};

const ALLOWED_PROPERTIES = new Set(["name", "version", "onFail"]);
const ALLOWED_ON_FAIL = new Set<ProjectDevEngineOnFail>(["error", "warn", "ignore", "download"]);
const MAX_DEV_ENGINE_VALUE_BYTES = 256;
const MAX_DEV_ENGINE_ALTERNATIVES = 32;

/**
 * npm accepts either one object or an array of alternative objects for every
 * devEngines key. Invalid authored shapes are configuration errors regardless
 * of onFail, matching npm's own validation boundary.
 */
export function parseProjectDevEngineEntries(
  value: unknown,
  source: string,
): ProjectDevEngineEntry[] {
  const authored = Array.isArray(value) ? value : [value];
  if (authored.length === 0) return [];
  if (authored.length > MAX_DEV_ENGINE_ALTERNATIVES) {
    throw new Error(`${source} has too many alternatives.`);
  }

  return authored.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${source} must be an object or an array of objects.`);
    }
    for (const property of Object.keys(item)) {
      if (!ALLOWED_PROPERTIES.has(property)) {
        throw new Error(`Unsupported ${source} property "${property}".`);
      }
    }

    const candidate = item as { name?: unknown; version?: unknown; onFail?: unknown };
    if (
      typeof candidate.name !== "string" ||
      !candidate.name ||
      Buffer.byteLength(candidate.name, "utf8") > MAX_DEV_ENGINE_VALUE_BYTES
    ) {
      throw new Error(`${source}.name must be a non-empty string.`);
    }
    if (
      candidate.version !== undefined &&
      (typeof candidate.version !== "string" ||
        !candidate.version ||
        Buffer.byteLength(candidate.version, "utf8") > MAX_DEV_ENGINE_VALUE_BYTES)
    ) {
      throw new Error(`${source}.version must be a non-empty string.`);
    }
    if (
      candidate.onFail !== undefined &&
      (typeof candidate.onFail !== "string" ||
        !ALLOWED_ON_FAIL.has(candidate.onFail as ProjectDevEngineOnFail))
    ) {
      throw new Error(`${source}.onFail must be error, warn, ignore, or download.`);
    }

    return {
      name: candidate.name,
      ...(candidate.version === undefined ? {} : { version: candidate.version }),
      ...(candidate.onFail === undefined
        ? {}
        : { onFail: candidate.onFail as ProjectDevEngineOnFail }),
    };
  });
}

/**
 * npm treats array entries as alternatives and applies the last entry's
 * onFail when none match. Its internal "download" mode currently behaves as
 * an error, so Quillra does the same.
 */
export function projectDevEngineFailureIsBlocking(entries: ProjectDevEngineEntry[]): boolean {
  const onFail = entries.at(-1)?.onFail ?? "error";
  return onFail === "error" || onFail === "download";
}

export function validateProjectDevEngineVersionRange(value: string, source: string): string {
  if (validRange(value) === null) {
    throw new Error(`${source} must use a semantic version range.`);
  }
  return value;
}
