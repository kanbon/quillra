import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import {
  type GithubContentsPermission,
  getInstallationToken,
  isGithubAppConfigured,
} from "./github-app.js";

export type ProjectGithubBindingSnapshot = {
  githubRepoFullName: string;
  githubInstallationId: string | null;
  githubRepositoryId: string | null;
  defaultBranch: string;
  githubBindingGeneration: number;
};

export class ProjectGithubBindingChangedError extends Error {
  constructor() {
    super("The project GitHub repository changed while this request was running. Please retry.");
    this.name = "ProjectGithubBindingChangedError";
  }
}

/**
 * Reject stale requests while holding the project repository lock. The
 * generation is monotonic, so an A -> B -> A rebind cannot pass by restoring
 * the same repository ids and branch.
 */
export async function assertProjectGithubBinding(
  projectId: string,
  expected: Pick<ProjectGithubBindingSnapshot, "githubBindingGeneration"> &
    Partial<Omit<ProjectGithubBindingSnapshot, "githubBindingGeneration">>,
): Promise<void> {
  const [current] = await db
    .select({
      githubRepoFullName: projects.githubRepoFullName,
      githubInstallationId: projects.githubInstallationId,
      githubRepositoryId: projects.githubRepositoryId,
      defaultBranch: projects.defaultBranch,
      githubBindingGeneration: projects.githubBindingGeneration,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  // A GitHub rename changes full_name without changing repository identity.
  // Once immutable installation + repository ids are present, those ids and
  // the monotonic generation are the security boundary; comparing a stale
  // display name would incorrectly reject the first request that canonicalizes
  // it through GitHub.
  const hasImmutableExpectedIdentity =
    expected.githubInstallationId != null && expected.githubRepositoryId != null;
  if (
    !current ||
    current.githubBindingGeneration !== expected.githubBindingGeneration ||
    (!hasImmutableExpectedIdentity &&
      expected.githubRepoFullName !== undefined &&
      current.githubRepoFullName !== expected.githubRepoFullName) ||
    (expected.githubInstallationId !== undefined &&
      current.githubInstallationId !== expected.githubInstallationId) ||
    (expected.githubRepositoryId !== undefined &&
      current.githubRepositoryId !== expected.githubRepositoryId) ||
    (expected.defaultBranch !== undefined && current.defaultBranch !== expected.defaultBranch)
  ) {
    throw new ProjectGithubBindingChangedError();
  }
}

/**
 * Resolve a short-lived token for this project's immutable GitHub binding.
 * Old projects without repository + installation ids fail closed and must be
 * explicitly reconnected by a project admin through their own GitHub access.
 */
export async function resolveProjectGitToken(
  projectId: string,
  contents: GithubContentsPermission,
): Promise<{ token: string; fullName: string }> {
  if (!isGithubAppConfigured()) {
    throw new Error("Quillra GitHub App is not configured.");
  }
  const [project] = await db
    .select({
      fullName: projects.githubRepoFullName,
      installationId: projects.githubInstallationId,
      repositoryId: projects.githubRepositoryId,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error("Project GitHub binding does not exist.");
  if (!project.installationId || !project.repositoryId) {
    throw new Error(
      "This project must be reconnected to GitHub by a project admin before code can be synchronized.",
    );
  }
  let token: string;
  try {
    token = await getInstallationToken(project.installationId, project.repositoryId, contents);
  } catch (error) {
    console.warn(`[workspace] scoped token fetch failed for project ${projectId}:`, error);
    throw new Error(
      "Quillra could not obtain repository-scoped GitHub access. Reconnect the repository or update the GitHub App installation.",
    );
  }

  const response = await fetch("https://api.github.com/installation/repositories?per_page=2", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Quillra-Self-Hosted",
    },
  });
  if (!response.ok) {
    throw new Error(
      "Quillra could not verify the repository bound to this project. Reconnect the repository.",
    );
  }
  const data = (await response.json()) as {
    repositories?: Array<{ id?: number; full_name?: string }>;
  };
  const canonical =
    Array.isArray(data.repositories) && data.repositories.length === 1
      ? data.repositories[0]
      : undefined;
  if (
    !canonical ||
    !Number.isSafeInteger(canonical.id) ||
    String(canonical.id) !== project.repositoryId ||
    !canonical.full_name ||
    !/^[\w.-]+\/[\w.-]+$/.test(canonical.full_name)
  ) {
    throw new Error("GitHub returned an invalid repository binding.");
  }

  if (canonical.full_name !== project.fullName) {
    await db
      .update(projects)
      .set({ githubRepoFullName: canonical.full_name, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
  }
  return { token, fullName: canonical.full_name };
}
