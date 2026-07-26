import { ApiError } from "./api";

export type GithubRepoRow = {
  repositoryId: string;
  installationId: string;
  fullName: string;
  defaultBranch: string;
};

export type GitHubConnection = {
  connected: boolean;
  githubLogin?: string;
  installUrl?: string | null;
};

export function isGitHubConnectionRequired(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && error.status === 409 && error.code === "github_connection_required"
  );
}

export function githubConnectUrl(error?: unknown): string {
  const returnTo =
    typeof window === "undefined"
      ? "/"
      : `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (
    isGitHubConnectionRequired(error) &&
    typeof error.payload.connectUrl === "string" &&
    error.payload.connectUrl.startsWith("/") &&
    !error.payload.connectUrl.startsWith("//")
  ) {
    const connectUrl = new URL(error.payload.connectUrl, "https://quillra.invalid");
    if (
      connectUrl.origin === "https://quillra.invalid" &&
      connectUrl.pathname === "/api/github/connect/start"
    ) {
      connectUrl.searchParams.set("returnTo", returnTo);
      return `${connectUrl.pathname}${connectUrl.search}${connectUrl.hash}`;
    }
  }

  return `/api/github/connect/start?returnTo=${encodeURIComponent(returnTo)}`;
}

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
