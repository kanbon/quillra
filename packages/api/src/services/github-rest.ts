import { getInstanceSetting } from "./instance-settings.js";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

function requireToken(): string {
  const token = getInstanceSetting("GITHUB_TOKEN");
  if (!token) {
    throw new Error("GitHub isn't configured yet — finish the setup wizard.");
  }
  return token;
}

async function ghJson<T>(path: string): Promise<T> {
  const token = requireToken();
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

export type GithubRepoListItem = {
  fullName: string;
  defaultBranch: string;
};

/** Repositories the configured token can access (user repos + org, paginated). */
export async function listAccessibleRepos(): Promise<GithubRepoListItem[]> {
  const out: GithubRepoListItem[] = [];
  let url: string | null = `${API}/user/repos?per_page=100&sort=full_name&affiliation=owner,collaborator,organization_member`;

  for (let page = 0; page < 20 && url; page++) {
    const token = requireToken();
    const pageRes: Response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
    if (!pageRes.ok) {
      const text = await pageRes.text();
      throw new Error(`GitHub API ${pageRes.status}: ${text.slice(0, 200)}`);
    }
    const batch = (await pageRes.json()) as {
      full_name: string;
      default_branch: string;
    }[];
    for (const r of batch) {
      out.push({ fullName: r.full_name, defaultBranch: r.default_branch });
    }
    const linkHeader: string | null = pageRes.headers.get("link");
    url = null;
    if (linkHeader) {
      const nextPart: string | undefined = linkHeader.split(",").find((part: string) => part.includes('rel="next"'));
      if (nextPart) {
        const hrefMatch: RegExpMatchArray | null = nextPart.match(/<([^>]+)>/);
        if (hrefMatch) url = hrefMatch[1];
      }
    }
  }
  out.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return out;
}

export async function listBranches(owner: string, repo: string): Promise<string[]> {
  const names: string[] = [];
  let page = 1;
  for (;;) {
    const batch = await ghJson<{ name: string }[]>(
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

export async function getRepoMeta(
  owner: string,
  repo: string,
): Promise<{ defaultBranch: string }> {
  const data = await ghJson<{ default_branch: string }>(
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
  packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null;
  rootFiles: string[];
}> {
  // 1) List root files
  let rootFiles: string[] = [];
  try {
    const tree = await ghJson<{ name: string; type: string }[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?ref=${encodeURIComponent(ref)}`,
    );
    rootFiles = tree.map((t) => t.name);
  } catch {
    /* repo may be empty or branch missing */
  }

  // 2) Try to fetch package.json (gracefully nullable)
  let packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
  if (rootFiles.includes("package.json")) {
    try {
      const file = await ghJson<{ content: string; encoding: string }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/package.json?ref=${encodeURIComponent(ref)}`,
      );
      const raw = file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
      packageJson = JSON.parse(raw);
    } catch {
      /* malformed package.json — leave null, detector falls back to root files */
    }
  }

  return { packageJson, rootFiles };
}
