/**
 * Tracks the lifecycle of a project's dev preview so the iframe fallback
 * page can show what's happening (cloning, installing, starting…) instead
 * of a generic "Bad gateway" or vague spinner.
 */

export type PreviewStage = "idle" | "cloning" | "installing" | "starting" | "ready" | "error";

export type PreviewStatus = {
  stage: PreviewStage;
  message?: string;
  updatedAt: number;
};

const statusByProject = new Map<string, PreviewStatus>();
const portToProject = new Map<number, string>();

export function setPreviewStatus(projectId: string, stage: PreviewStage, message?: string) {
  statusByProject.set(projectId, { stage, message, updatedAt: Date.now() });
}

export function getPreviewStatus(projectId: string): PreviewStatus {
  return statusByProject.get(projectId) ?? { stage: "idle", updatedAt: Date.now() };
}

export function registerPreviewPort(port: number, projectId: string) {
  portToProject.set(port, projectId);
}

export function getProjectByPort(port: number): string | undefined {
  return portToProject.get(port);
}

/** Friendly label for each stage, used by the fallback page */
export function describeStage(stage: PreviewStage): { label: string; detail: string } {
  switch (stage) {
    case "cloning":
      return { label: "Fetching your site", detail: "Cloning the repository from GitHub…" };
    case "installing":
      return {
        label: "Installing packages",
        detail: "This is a one-time setup. It can take a couple of minutes.",
      };
    case "starting":
      return { label: "Starting the preview", detail: "Waking up the dev server…" };
    case "ready":
      return { label: "Ready", detail: "Your site is loading." };
    case "error":
      return { label: "Something went wrong", detail: "Check the console or try again." };
    default:
      return { label: "Preparing", detail: "Getting things ready…" };
  }
}
