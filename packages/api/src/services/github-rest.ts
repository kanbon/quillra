/**
 * GitHub discovery client.
 *
 * These calls run with the signed-in Quillra user's GitHub App user token,
 * never with an installation token that can see repositories belonging to
 * other Quillra users. Clone/push uses a separate repository-scoped
 * installation token in workspace.ts.
 */
import {
  GithubProviderError,
  GithubResponseTooLargeError,
  type GithubUserRepository,
  getGithubRepositoryForUserByFullName,
  githubJsonForUserRepository,
  githubTextForUserRepository,
  listGithubRepositoriesForUser,
} from "./github-user-connection.js";

export type GithubRepoListItem = GithubUserRepository;
const MAX_GITHUB_PAGES = 50;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export async function listAccessibleRepos(userId: string): Promise<GithubRepoListItem[]> {
  return listGithubRepositoriesForUser(userId);
}

export async function resolveAccessibleRepo(
  userId: string,
  owner: string,
  repo: string,
): Promise<GithubUserRepository> {
  return getGithubRepositoryForUserByFullName(userId, `${owner}/${repo}`);
}

function repositoryApiPath(repository: GithubUserRepository, suffix = ""): string {
  const [owner, repo] = repository.fullName.split("/");
  if (!owner || !repo) throw new Error("GitHub returned an invalid repository name.");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

export async function listBranches(
  userId: string,
  repository: GithubUserRepository,
): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; ; page++) {
    if (page > MAX_GITHUB_PAGES) {
      throw new GithubProviderError(null, {
        message: "GitHub returned too many branch pages to inspect safely.",
      });
    }
    const batch = await githubJsonForUserRepository<Array<{ name: string }>>(
      userId,
      repository,
      repositoryApiPath(repository, `/branches?per_page=100&page=${page}`),
    );
    names.push(...batch.map((branch) => branch.name));
    if (batch.length < 100) break;
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return names;
}

export class GithubRepositoryInspectionError extends Error {
  readonly code = "github_repository_inspection_failed";

  constructor(message: string) {
    super(message);
    this.name = "GithubRepositoryInspectionError";
  }
}

/**
 * Fetch package.json (parsed) + root file names without cloning. The user/App
 * intersection is rechecked by GitHub for both requests.
 */
export async function fetchRepoManifest(
  userId: string,
  repository: GithubUserRepository,
  ref: string,
): Promise<{
  packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null;
  rootFiles: string[];
}> {
  const tree = await githubJsonForUserRepository<Array<{ name: string; type: string }>>(
    userId,
    repository,
    repositoryApiPath(repository, `/contents?ref=${encodeURIComponent(ref)}`),
  );
  if (!Array.isArray(tree)) {
    throw new GithubRepositoryInspectionError(
      "GitHub returned an unexpected repository contents response.",
    );
  }
  const rootFiles = tree.map((entry) => entry.name);

  let packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null = null;
  if (rootFiles.includes("package.json")) {
    let raw: string;
    try {
      raw = await githubTextForUserRepository(
        userId,
        repository,
        repositoryApiPath(repository, `/contents/package.json?ref=${encodeURIComponent(ref)}`),
        MAX_PACKAGE_JSON_BYTES,
      );
    } catch (error) {
      if (error instanceof GithubResponseTooLargeError) {
        throw new GithubRepositoryInspectionError(
          "The repository package.json is too large for Quillra to inspect safely.",
        );
      }
      throw error;
    }
    try {
      packageJson = JSON.parse(raw);
    } catch {
      throw new GithubRepositoryInspectionError(
        "The repository package.json is not valid JSON, so Quillra could not inspect it.",
      );
    }
  }

  return { packageJson, rootFiles };
}
