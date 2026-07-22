import { getProjectByPort } from "./preview-status.js";

export type PreviewIdentity = {
  userId: string | null;
  clientProjectId: string | null;
};

export type PreviewAccessResult =
  | { ok: true; port: number; projectId: string }
  | { ok: false; reason: "unauthorized" | "invalid-port" | "not-found" };

type PreviewAccessDependencies = {
  projectForPort: (port: number) => string | undefined;
  isProjectMember: (userId: string, projectId: string) => Promise<boolean>;
};

const defaultDependencies: PreviewAccessDependencies = {
  projectForPort: getProjectByPort,
  isProjectMember: async (userId, projectId) => {
    const { memberForProject } = await import("../routes/projects/shared.js");
    return Boolean(await memberForProject(userId, projectId));
  },
};

/**
 * Resolve a preview port only after authenticating and authorizing its caller.
 * Unknown and forbidden ports intentionally share the same result so this
 * endpoint cannot be used to enumerate running projects.
 */
export async function resolvePreviewAccess(
  rawPort: string,
  identity: PreviewIdentity,
  dependencies: PreviewAccessDependencies = defaultDependencies,
): Promise<PreviewAccessResult> {
  if (!identity.userId) return { ok: false, reason: "unauthorized" };

  if (!/^\d{1,5}$/.test(rawPort)) return { ok: false, reason: "invalid-port" };
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, reason: "invalid-port" };
  }

  const projectId = dependencies.projectForPort(port);
  if (!projectId) return { ok: false, reason: "not-found" };

  if (identity.clientProjectId !== null) {
    return identity.clientProjectId === projectId
      ? { ok: true, port, projectId }
      : { ok: false, reason: "not-found" };
  }

  const isMember = await dependencies.isProjectMember(identity.userId, projectId);
  return isMember ? { ok: true, port, projectId } : { ok: false, reason: "not-found" };
}
