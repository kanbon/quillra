/**
 * Thin REST client for GitHub calls that the server makes on behalf of
 * the user (listing repos to connect, resolving the default branch of a
 * repo, fetching a repo's package.json to detect the framework, etc.).
 *
 * Authentication is always via a GitHub App installation token. There
 * is no personal-access-token fallback, if the App isn't configured
 * or isn't installed on the target repo, calls throw a clear error and
 * the UI surfaces "install the Quillra GitHub App on this repo".
 */
import {
  getInstallationTokenForRepo,
  isGithubAppConfigured,
  listRepositoriesAcrossInstallations,
} from "./github-app.js";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

/**
 * Resolve an installation token for a specific repo. Throws with a
 * user-facing message when the App isn't installed on that repo, which
 * lets the route handler surface the "go install the App" prompt.
 */
async function tokenForRepo(owner: string, repo: string): Promise<string> {
  if (!isGithubAppConfigured()) {
    throw new Error(
      "Quillra GitHub App is not configured. Finish the setup wizard's GitHub App step.",
    );
  }
  const token = await getInstallationTokenForRepo(owner, repo);
  if (!token) {
    throw new Error(
      `Quillra GitHub App is not installed on ${owner}/${repo}. Open Organization Settings → Integrations and install it on this repository.`,
    );
  }
  return token;
}

export type GithubRepoListItem = {
  fullName: string;
  defaultBranch: string;
};

/**
 * Every repo the Quillra GitHub App has been granted access to, across
 * all installations. This is exactly the set of repos the owner can
 * create a Quillra project for, the App-install step is where they
 * opt in repo by repo.
 */
export async function listAccessibleRepos(): Promise<GithubRepoListItem[]> {
  if (!isGithubAppConfigured()) {
    throw new Error(
      "Quillra GitHub App is not configured. Finish the setup wizard's GitHub App step.",
    );
  }
  const repos = await listRepositoriesAcrossInstallations();
  return repos.map(({ fullName, defaultBranch }) => ({ fullName, defaultBranch }));
}

async function ghJsonAsRepo<T>(owner: string, repo: string, path: string): Promise<T> {
  const token = await tokenForRepo(owner, repo);
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function listBranches(owner: string, repo: string): Promise<string[]> {
  const names: string[] = [];
  let page = 1;
  for (;;) {
    const batch = await ghJsonAsRepo<{ name: string }[]>(
      owner,
      repo,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`,
    );
    if (batch.length === 0) break;
    for (const b of batch) names.push(b.name);
    if (batch.length < 100) break;
    page++;
    if (page > 50) break;
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return names;
}

export async function getRepoMeta(owner: string, repo: string): Promise<{ defaultBranch: string }> {
  const data = await ghJsonAsRepo<{ default_branch: string }>(
    owner,
    repo,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
  return { defaultBranch: data.default_branch };
}

/**
 * Fetch package.json (parsed) + the list of file names at the root of a
 * repo on a specific branch, without cloning. Used by the connect modal
 * to identify the framework before the user submits.
 */
export async function fetchRepoManifest(
  owner: string,
  repo: string,
  ref: string,
): Promise<{
  packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null;
  rootFiles: string[];
}> {
  // 1) List root files
  let rootFiles: string[] = [];
  try {
    const tree = await ghJsonAsRepo<{ name: string; type: string }[]>(
      owner,
      repo,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?ref=${encodeURIComponent(ref)}`,
    );
    rootFiles = tree.map((t) => t.name);
  } catch {
    /* repo may be empty or branch missing */
  }

  // 2) Try to fetch package.json (gracefully nullable)
  let packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null = null;
  if (rootFiles.includes("package.json")) {
    try {
      const file = await ghJsonAsRepo<{ content: string; encoding: string }>(
        owner,
        repo,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/package.json?ref=${encodeURIComponent(ref)}`,
      );
      const raw =
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64").toString("utf8")
          : file.content;
      packageJson = JSON.parse(raw);
    } catch {
      /* malformed package.json, leave null, detector falls back to root files */
    }
  }

  return { packageJson, rootFiles };
}
