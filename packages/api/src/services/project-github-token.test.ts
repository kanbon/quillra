import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const githubMocks = vi.hoisted(() => ({
  configured: vi.fn(() => true),
  token: vi.fn(async () => "scoped-token"),
}));

vi.mock("./github-app.js", () => ({
  isGithubAppConfigured: githubMocks.configured,
  getInstallationToken: githubMocks.token,
}));

const originalDatabaseUrl = process.env.DATABASE_URL;
let tempDirectory: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-project-github-token-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  githubMocks.configured.mockReturnValue(true);
  githubMocks.token.mockReset();
  githubMocks.token.mockResolvedValue("scoped-token");
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.resetModules();
  vi.restoreAllMocks();
  if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, "DATABASE_URL");
  else process.env.DATABASE_URL = originalDatabaseUrl;
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function loadProject(project: {
  id: string;
  fullName: string;
  installationId?: string;
  repositoryId?: string;
}) {
  vi.resetModules();
  const [{ rawSqlite }, service] = await Promise.all([
    import("../db/index.js"),
    import("./project-github-token.js"),
  ]);
  openDatabase = rawSqlite;
  rawSqlite
    .prepare(
      `INSERT INTO projects
        (id, name, github_repo_full_name, github_installation_id, github_repository_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      project.id,
      project.id,
      project.fullName,
      project.installationId ?? null,
      project.repositoryId ?? null,
    );
  return service;
}

describe("project GitHub token binding", () => {
  it("mints a token for the exact stored installation and repository ids", async () => {
    const service = await loadProject({
      id: "project-1",
      fullName: "customer/old-name",
      installationId: "100",
      repositoryId: "200",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          total_count: 1,
          repositories: [{ id: 200, full_name: "customer/canonical-site" }],
        }),
      ),
    );

    await expect(service.resolveProjectGitToken("project-1", "write")).resolves.toEqual({
      token: "scoped-token",
      fullName: "customer/canonical-site",
    });
    expect(githubMocks.token).toHaveBeenCalledWith("100", "200", "write");
    expect(
      openDatabase
        ?.prepare("SELECT github_repo_full_name FROM projects WHERE id = ?")
        .get("project-1"),
    ).toEqual({ github_repo_full_name: "customer/canonical-site" });
  });

  it("accepts a canonical rename but rejects changed ids or binding generation", async () => {
    const service = await loadProject({
      id: "renamed-project",
      fullName: "customer/old-name",
      installationId: "100",
      repositoryId: "200",
    });
    const requestBinding = {
      githubRepoFullName: "customer/old-name",
      githubInstallationId: "100",
      githubRepositoryId: "200",
      defaultBranch: "main",
      githubBindingGeneration: 1,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          total_count: 1,
          repositories: [{ id: 200, full_name: "customer/canonical-site" }],
        }),
      ),
    );

    await service.resolveProjectGitToken("renamed-project", "read");
    await expect(
      service.assertProjectGithubBinding("renamed-project", requestBinding),
    ).resolves.toBeUndefined();

    openDatabase
      ?.prepare("UPDATE projects SET github_repository_id = ? WHERE id = ?")
      .run("201", "renamed-project");
    await expect(
      service.assertProjectGithubBinding("renamed-project", requestBinding),
    ).rejects.toBeInstanceOf(service.ProjectGithubBindingChangedError);

    openDatabase
      ?.prepare(
        `UPDATE projects
         SET github_repository_id = ?, github_installation_id = ?
         WHERE id = ?`,
      )
      .run("200", "101", "renamed-project");
    await expect(
      service.assertProjectGithubBinding("renamed-project", requestBinding),
    ).rejects.toBeInstanceOf(service.ProjectGithubBindingChangedError);

    openDatabase
      ?.prepare(
        `UPDATE projects
         SET github_installation_id = ?, github_binding_generation = ?
         WHERE id = ?`,
      )
      .run("100", 2, "renamed-project");
    await expect(
      service.assertProjectGithubBinding("renamed-project", requestBinding),
    ).rejects.toBeInstanceOf(service.ProjectGithubBindingChangedError);
  });

  it("fails closed for legacy or missing project bindings", async () => {
    const service = await loadProject({
      id: "legacy-project",
      fullName: "customer/legacy",
    });

    await expect(service.resolveProjectGitToken("legacy-project", "read")).rejects.toThrow(
      /reconnected/,
    );
    await expect(service.resolveProjectGitToken("missing-project", "read")).rejects.toThrow(
      /does not exist/,
    );
    expect(githubMocks.token).not.toHaveBeenCalled();
  });
});
