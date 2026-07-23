import path from "node:path";

export const RAILWAY_DATA_MOUNT_PATH = "/app/packages/api/data";

type RuntimeEnvironment = Record<string, string | undefined>;
type BootLogger = Pick<Console, "info">;

function isRailwayDeployment(environment: RuntimeEnvironment): boolean {
  return Boolean(
    environment.RAILWAY_DEPLOYMENT_ID?.trim() || environment.RAILWAY_REPLICA_ID?.trim(),
  );
}

function parsePublicOrigin(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`[railway] ${label} must be an absolute HTTP(S) origin`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(`[railway] ${label} must be an HTTP(S) origin without credentials or a path`);
  }
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(`[railway] ${label} must use HTTPS for a public deployment`);
  }
  return url.origin;
}

function parseRailwayDomain(raw: string): string {
  const domain = raw.trim().toLowerCase();
  if (domain.length === 0 || domain.length > 253 || domain.endsWith(".")) {
    throw new Error("[railway] RAILWAY_PUBLIC_DOMAIN is not a valid hostname");
  }
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new Error("[railway] RAILWAY_PUBLIC_DOMAIN is not a valid hostname");
  }
  return domain;
}

function mergeTrustedOrigin(environment: RuntimeEnvironment, publicOrigin: string): void {
  const origins = new Set<string>([publicOrigin]);
  for (const value of environment.TRUSTED_ORIGINS?.split(",") ?? []) {
    const trimmed = value.trim();
    if (trimmed) origins.add(parsePublicOrigin(trimmed, "TRUSTED_ORIGINS"));
  }
  environment.TRUSTED_ORIGINS = [...origins].join(",");
}

function resolveDatabasePath(environment: RuntimeEnvironment, cwd: string): string {
  const raw = environment.DATABASE_URL?.trim() || "file:./data/cms.sqlite";
  const filePath = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
  return path.resolve(cwd, filePath);
}

function resolveWorkspacePath(environment: RuntimeEnvironment, cwd: string): string {
  return path.resolve(environment.WORKSPACE_DIR?.trim() || path.join(cwd, "data", "workspaces"));
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function validatePersistentPaths(environment: RuntimeEnvironment, cwd: string): void {
  const rawMountPath = environment.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (!rawMountPath) {
    throw new Error(
      `[railway] persistent storage is required; attach one Railway Volume at ${RAILWAY_DATA_MOUNT_PATH}`,
    );
  }

  const mountPath = path.resolve(rawMountPath);
  if (mountPath !== RAILWAY_DATA_MOUNT_PATH) {
    throw new Error(
      `[railway] volume is mounted at ${mountPath}; change its mount path to ${RAILWAY_DATA_MOUNT_PATH}`,
    );
  }

  const databasePath = resolveDatabasePath(environment, cwd);
  if (databasePath === mountPath || !isInside(mountPath, databasePath)) {
    throw new Error(
      `[railway] DATABASE_URL resolves outside the persistent volume: ${databasePath}`,
    );
  }

  const workspacePath = resolveWorkspacePath(environment, cwd);
  if (!isInside(mountPath, workspacePath)) {
    throw new Error(
      `[railway] WORKSPACE_DIR resolves outside the persistent volume: ${workspacePath}`,
    );
  }
}

/**
 * Fill Railway-specific defaults before auth and storage modules capture env
 * values. Invalid or ephemeral production configuration fails before Quillra
 * can create an owner, credentials, or workspaces in the wrong place.
 */
export function configureRailwayRuntime(
  environment: RuntimeEnvironment = process.env,
  cwd = process.cwd(),
  logger: BootLogger = console,
): void {
  if (!isRailwayDeployment(environment)) return;

  let publicOrigin: string;
  const explicitOrigin = environment.BETTER_AUTH_URL?.trim();
  if (explicitOrigin) {
    publicOrigin = parsePublicOrigin(explicitOrigin, "BETTER_AUTH_URL");
    environment.BETTER_AUTH_URL = publicOrigin;
  } else {
    const rawDomain = environment.RAILWAY_PUBLIC_DOMAIN?.trim();
    if (!rawDomain) {
      throw new Error(
        "[railway] public networking is required; generate a Railway domain or set BETTER_AUTH_URL",
      );
    }
    publicOrigin = `https://${parseRailwayDomain(rawDomain)}`;
    environment.BETTER_AUTH_URL = publicOrigin;
    logger.info(`[railway] inferred BETTER_AUTH_URL=${publicOrigin}`);
  }

  mergeTrustedOrigin(environment, publicOrigin);
  validatePersistentPaths(environment, cwd);
}

configureRailwayRuntime();
