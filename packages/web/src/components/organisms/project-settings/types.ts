/**
 * Shared types and pure helpers for the Project Settings page
 * (ProjectSettings.tsx). Extracted so each section organism can
 * import only what it needs without dragging the whole page file
 * along with it.
 */

import { parseRepoFullName } from "@/lib/github";
import { z } from "zod";

export type DetectStatus =
  | "idle"
  | "loading"
  | { kind: "ok"; label: string }
  | { kind: "none" }
  | { kind: "error" };

export const projectSchema = z.object({
  name: z.string().min(1).max(200),
  githubRepoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  defaultBranch: z.string().min(1).max(255),
  previewDevCommand: z.string().max(2000).optional(),
});

export type ProjectForm = z.infer<typeof projectSchema>;

export type Member = {
  id: string;
  userId: string;
  role: string;
  email: string;
  name: string;
  image: string | null;
  createdAt: number;
};

export type PendingInvite = {
  id: string;
  email: string;
  role: string;
  expiresAt: number;
};

export function inferDisplayNameMode(name: string, repoFull: string): "repo" | "full" | "custom" {
  const p = parseRepoFullName(repoFull);
  if (!p) return "custom";
  if (name === p.repo) return "repo";
  if (name === `${p.owner} / ${p.repo}`) return "full";
  return "custom";
}

export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "·"
  );
}

export function roleBadgeColor(
  role: string,
  t: (k: string) => string,
): { bg: string; text: string; label: string } {
  switch (role) {
    case "admin":
      return { bg: "bg-red-100", text: "text-red-700", label: t("projectSettings.roleAdmin") };
    case "editor":
      return {
        bg: "bg-blue-100",
        text: "text-blue-700",
        label: t("projectSettings.roleCollaborator"),
      };
    case "client":
      return {
        bg: "bg-purple-100",
        text: "text-purple-700",
        label: t("projectSettings.roleClient"),
      };
    default:
      return { bg: "bg-neutral-100", text: "text-neutral-700", label: role };
  }
}
