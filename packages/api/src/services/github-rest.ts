/**
 * GitHub discovery client.
 *
 * These calls run with the signed-in Quillra user's GitHub App user token,
 * never with an installation token that can see repositories belonging to
 * other Quillra users. Clone/push uses a separate repository-scoped
 * installation token in workspace.ts.
 */
import {
  type GithubUserRepository,
  getGithubRepositoryForUserByFullName,
  githubJsonForUserRepository,
  listGithubRepositoriesForUser,
} from "./github-user-connection.js";

export type GithubRepoListItem = GithubUserRepository;

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
  for (let page = 1; page <= 50; page++) {
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

export async function getRepoMeta(
  userId: string,
  repository: GithubUserRepository,
): Promise<{ defaultBranch: string }> {
  const data = await githubJsonForUserRepository<{ default_branch: string }>(
    userId,
    repository,
    repositoryApiPath(repository),
  );
  return { defaultBranch: data.default_branch };
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
  let rootFiles: string[] = [];
  try {
    const tree = await githubJsonForUserRepository<Array<{ name: string; type: string }>>(
      userId,
      repository,
      repositoryApiPath(repository, `/contents?ref=${encodeURIComponent(ref)}`),
    );
    rootFiles = tree.map((entry) => entry.name);
  } catch {
    // Empty repositories and missing branches are represented as no manifest.
  }

  let packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null = null;
  if (rootFiles.includes("package.json")) {
    try {
      const file = await githubJsonForUserRepository<{ content: string; encoding: string }>(
        userId,
        repository,
        repositoryApiPath(repository, `/contents/package.json?ref=${encodeURIComponent(ref)}`),
      );
      const raw =
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64").toString("utf8")
          : file.content;
      packageJson = JSON.parse(raw);
    } catch {
      // Malformed or inaccessible package.json; the detector can use root files.
    }
  }

  return { packageJson, rootFiles };
}
