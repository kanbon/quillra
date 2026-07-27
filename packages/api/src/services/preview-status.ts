/**
 * Tracks the lifecycle of a project's dev preview so the iframe fallback
 * page can show what's happening (cloning, installing, starting…) instead
 * of a generic "Bad gateway" or vague spinner.
 */
import { previewUpstreamUrl } from "./preview-upstream.js";

export type PreviewStage = "idle" | "cloning" | "installing" | "starting" | "ready" | "error";

export type PreviewStatus = {
  stage: PreviewStage;
  message?: string;
  updatedAt: number;
};

const statusByProject = new Map<string, PreviewStatus>();
const portToProject = new Map<number, string>();
const portByProject = new Map<string, number>();
const activeProjects = new Set<string>();

export function setPreviewStatus(projectId: string, stage: PreviewStage, message?: string) {
  statusByProject.set(projectId, { stage, message, updatedAt: Date.now() });
}

export function getPreviewStatus(projectId: string): PreviewStatus {
  return statusByProject.get(projectId) ?? { stage: "idle", updatedAt: Date.now() };
}

export function registerPreviewPort(port: number, projectId: string) {
  const owner = portToProject.get(port);
  if (owner && owner !== projectId) return false;

  const previousPort = portByProject.get(projectId);
  if (previousPort !== undefined && previousPort !== port) {
    portToProject.delete(previousPort);
    activeProjects.delete(projectId);
  }
  portToProject.set(port, projectId);
  portByProject.set(projectId, port);
  return true;
}

export function getProjectByPort(port: number): string | undefined {
  return portToProject.get(port);
}

/** Mark a reservation proxyable only after its dev server has started. */
export function markPreviewPortActive(projectId: string, port: number): boolean {
  if (portByProject.get(projectId) !== port || portToProject.get(port) !== projectId) return false;
  activeProjects.add(projectId);
  return true;
}

/**
 * Stop proxying project traffic while retaining the reserved project/port
 * association used by the authenticated boot page. This lets the browser read
 * a terminal lifecycle error without leaving any route to project code open.
 */
export function deactivatePreviewPort(projectId: string, expectedPort?: number): void {
  const port = portByProject.get(projectId);
  if (expectedPort !== undefined && port !== expectedPort) return;
  activeProjects.delete(projectId);
}

export function getActiveProjectByPort(port: number): string | undefined {
  const projectId = portToProject.get(port);
  return projectId && activeProjects.has(projectId) ? projectId : undefined;
}

export function isPreviewPortActive(projectId: string, port: number): boolean {
  return activeProjects.has(projectId) && portByProject.get(projectId) === port;
}

/**
 * An active local reservation is not enough: E2B routing is deliberately
 * revoked before every reconnect/isolation proof. Without an upstream, the UI
 * must restart the preview instead of waiting forever on a stale PID.
 */
export function isPreviewRoutable(projectId: string, port: number): boolean {
  return isPreviewPortActive(projectId, port) && previewUpstreamUrl(projectId, port, "/") !== null;
}

export function getPortByProject(projectId: string): number | undefined {
  return portByProject.get(projectId);
}

export function unregisterPreviewPort(projectId: string, expectedPort?: number): void {
  const port = portByProject.get(projectId);
  if (expectedPort !== undefined && port !== expectedPort) return;
  if (port !== undefined && portToProject.get(port) === projectId) {
    portToProject.delete(port);
  }
  activeProjects.delete(projectId);
  portByProject.delete(projectId);
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

/** Capability resolution must happen before calling this loopback probe. */
export async function readPreviewStatus(projectId: string, port: number) {
  const status = getPreviewStatus(projectId);
  // Readiness is published only after the authenticated E2B route answered a
  // real probe. While that exact route remains registered, the boot document
  // can use the tracked result immediately instead of paying another provider
  // round trip on every warm iframe load.
  if (status.stage === "ready" && isPreviewRoutable(projectId, port)) {
    return { stage: "ready" as const, label: "Ready", detail: "Loading your site…" };
  }

  if (isPreviewPortActive(projectId, port)) {
    const upstream = previewUpstreamUrl(projectId, port, "/");
    try {
      if (!upstream) throw new Error("Preview upstream is unavailable");
      const probe = await fetch(upstream.url, {
        headers: upstream.headers,
        signal: AbortSignal.timeout(1_500),
        redirect: "manual",
      });
      if (probe.status > 0) {
        return { stage: "ready" as const, label: "Ready", detail: "Loading your site…" };
      }
    } catch {
      /* not reachable yet, fall through to the tracked lifecycle */
    }
  }

  const description = describeStage(status.stage);
  return {
    stage: status.stage,
    label: description.label,
    detail: status.message ?? description.detail,
  };
}
