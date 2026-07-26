import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubRepositoryInspectionError, fetchRepoManifest, listBranches } from "./github-rest.js";
import {
  githubJsonForUserRepository,
  githubTextForUserRepository,
} from "./github-user-connection.js";

vi.mock("./github-user-connection.js", () => ({
  getGithubRepositoryForUserByFullName: vi.fn(),
  githubJsonForUserRepository: vi.fn(),
  githubTextForUserRepository: vi.fn(),
  listGithubRepositoriesForUser: vi.fn(),
}));

const repository = {
  repositoryId: "101",
  installationId: "11",
  fullName: "alice/site",
  defaultBranch: "main",
};

describe("GitHub repository manifest inspection", () => {
  beforeEach(() => {
    vi.mocked(githubJsonForUserRepository).mockReset();
    vi.mocked(githubTextForUserRepository).mockReset();
  });

  it("reads package.json through GitHub's raw contents response", async () => {
    vi.mocked(githubJsonForUserRepository).mockResolvedValue([
      { name: "package.json", type: "file" },
      { name: "vite.config.ts", type: "file" },
    ]);
    vi.mocked(githubTextForUserRepository).mockResolvedValue(
      JSON.stringify({ devDependencies: { vite: "^7.0.0" } }),
    );

    await expect(fetchRepoManifest("user-1", repository, "main")).resolves.toEqual({
      packageJson: { devDependencies: { vite: "^7.0.0" } },
      rootFiles: ["package.json", "vite.config.ts"],
    });
    expect(githubTextForUserRepository).toHaveBeenCalledWith(
      "user-1",
      repository,
      "/repos/alice/site/contents/package.json?ref=main",
      1024 * 1024,
    );
  });

  it("keeps a repository without package.json as a valid unsupported manifest", async () => {
    vi.mocked(githubJsonForUserRepository).mockResolvedValue([{ name: "README.md", type: "file" }]);

    await expect(fetchRepoManifest("user-1", repository, "main")).resolves.toEqual({
      packageJson: null,
      rootFiles: ["README.md"],
    });
    expect(githubTextForUserRepository).not.toHaveBeenCalled();
  });

  it("propagates GitHub contents failures instead of reporting an unsupported framework", async () => {
    const providerFailure = new Error("provider unavailable");
    vi.mocked(githubJsonForUserRepository).mockRejectedValue(providerFailure);

    await expect(fetchRepoManifest("user-1", repository, "main")).rejects.toBe(providerFailure);
  });

  it("reports malformed package.json as an inspection failure", async () => {
    vi.mocked(githubJsonForUserRepository).mockResolvedValue([
      { name: "package.json", type: "file" },
    ]);
    vi.mocked(githubTextForUserRepository).mockResolvedValue("{");

    await expect(fetchRepoManifest("user-1", repository, "main")).rejects.toBeInstanceOf(
      GithubRepositoryInspectionError,
    );
  });

  it("continues branch pagination beyond the first page", async () => {
    vi.mocked(githubJsonForUserRepository)
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, index) => ({ name: `branch-${index + 1}` })),
      )
      .mockResolvedValueOnce([{ name: "page-two" }]);

    const branches = await listBranches("user-1", repository);

    expect(branches).toContain("page-two");
    expect(githubJsonForUserRepository).toHaveBeenCalledTimes(2);
  });
});
