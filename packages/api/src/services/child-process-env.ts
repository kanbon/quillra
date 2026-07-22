/**
 * Build the deliberately small environment inherited by commands that run
 * inside customer workspaces. Quillra's API process contains credentials for
 * auth, email, GitHub, and encryption; forwarding the complete process.env to
 * package scripts or an agent shell would expose the control plane to project
 * code.
 */
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "XDG_CACHE_HOME",
  "COREPACK_HOME",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "PNPM_HOME",
  "CI",
  // Windows process-launch essentials. Keep both common casings because
  // process.env is case-insensitive there but plain test objects are not.
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

export function createSafeChildEnv(
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

/**
 * The Claude Agent SDK merges `options.env` over its own `process.env`.
 * A sparse allowlist would therefore leave every omitted control-plane secret
 * inherited. Explicitly shadow inherited keys with `undefined`, then add the
 * same allowlist used by direct child processes.
 */
export function createSafeSdkEnv(
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const cleared = Object.fromEntries(Object.keys(source).map((key) => [key, undefined]));
  return { ...cleared, ...createSafeChildEnv(overrides, source) };
}
