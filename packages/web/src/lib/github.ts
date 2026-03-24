export type GithubRepoRow = { fullName: string; defaultBranch: string };

export function parseRepoFullName(full: string): { owner: string; repo: string } | null {
  const parts = full.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

export function repoSlugDisplay(fullName: string): string {
  const p = parseRepoFullName(fullName);
  return p?.repo ?? fullName;
}

export function selectLikeInputClassName(): string {
  return "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900";
}
