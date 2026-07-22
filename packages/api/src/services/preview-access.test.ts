import { describe, expect, it, vi } from "vitest";
import { resolvePreviewAccess } from "./preview-access.js";

function dependencies(projectId = "project-a", member = true) {
  return {
    projectForPort: vi.fn((port: number) => (port === 4_321 ? projectId : undefined)),
    isProjectMember: vi.fn(async () => member),
  };
}

describe("resolvePreviewAccess", () => {
  it("rejects unauthenticated requests before resolving a localhost port", async () => {
    const deps = dependencies();

    await expect(
      resolvePreviewAccess("4321", { userId: null, clientProjectId: null }, deps),
    ).resolves.toEqual({ ok: false, reason: "unauthorized" });
    expect(deps.projectForPort).not.toHaveBeenCalled();
  });

  it.each(["", "0", "65536", "4321.5", "1e3", "-1", "localhost"])(
    "rejects invalid port %j without a lookup",
    async (rawPort) => {
      const deps = dependencies();

      await expect(
        resolvePreviewAccess(rawPort, { userId: "user-a", clientProjectId: null }, deps),
      ).resolves.toEqual({ ok: false, reason: "invalid-port" });
      expect(deps.projectForPort).not.toHaveBeenCalled();
    },
  );

  it("rejects an unregistered port without probing project membership", async () => {
    const deps = dependencies();

    await expect(
      resolvePreviewAccess("4322", { userId: "user-a", clientProjectId: null }, deps),
    ).resolves.toEqual({ ok: false, reason: "not-found" });
    expect(deps.isProjectMember).not.toHaveBeenCalled();
  });

  it("allows a team member for the registered project", async () => {
    const deps = dependencies();

    await expect(
      resolvePreviewAccess("4321", { userId: "user-a", clientProjectId: null }, deps),
    ).resolves.toEqual({ ok: true, port: 4_321, projectId: "project-a" });
    expect(deps.isProjectMember).toHaveBeenCalledWith("user-a", "project-a");
  });

  it("hides a registered project from a non-member", async () => {
    const deps = dependencies("project-a", false);

    await expect(
      resolvePreviewAccess("4321", { userId: "user-a", clientProjectId: null }, deps),
    ).resolves.toEqual({ ok: false, reason: "not-found" });
  });

  it("allows only the project pinned to a client session", async () => {
    const matching = dependencies("project-a");
    const other = dependencies("project-b");

    await expect(
      resolvePreviewAccess("4321", { userId: "client-a", clientProjectId: "project-a" }, matching),
    ).resolves.toEqual({ ok: true, port: 4_321, projectId: "project-a" });
    await expect(
      resolvePreviewAccess("4321", { userId: "client-a", clientProjectId: "project-a" }, other),
    ).resolves.toEqual({ ok: false, reason: "not-found" });
    expect(matching.isProjectMember).not.toHaveBeenCalled();
    expect(other.isProjectMember).not.toHaveBeenCalled();
  });
});
