const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

function requireToken(): string {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error("Set GITHUB_TOKEN on the server to list GitHub repositories and branches.");
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
