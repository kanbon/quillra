/**
 * Checks whether the project's workspace is in sync with origin on editor
 * load. Returns state for the sync modal plus actions to resolve it.
 *
 * Flow:
 *   1. mount -> GET /sync-status
 *   2. in_sync or ahead_only -> nothing to do
 *   3. behind -> silently fast-forward, show a subtle toast
 *   4. behind_with_local_changes -> surface the modal so the user picks
 *
 * All writes funnel through the three POST endpoints in routes/projects/
 * sync.ts. Errors surface as a plain string the modal renders inline.
 */

import { apiJson } from "@/lib/api";
import { useCallback, useEffect, useState } from "react";

type LocalFileChange = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
};

type RemoteCommit = {
  sha: string;
  shortSha: string;
  author: string;
  message: string;
  when: number;
};

export type SyncStatus =
  | { state: "in_sync" }
  | { state: "ahead_only"; localAhead: number }
  | { state: "behind"; remoteAhead: number; remoteCommits: RemoteCommit[] }
  | {
      state: "behind_with_local_changes";
      remoteAhead: number;
      remoteCommits: RemoteCommit[];
      localChanges: LocalFileChange[];
    };

export type MergeOutcome =
  | { state: "merged_clean"; commitSha: string }
  | { state: "fast_forwarded" }
  | { state: "conflicts_resolved"; commitSha: string; resolvedFiles: string[] }
  | { state: "conflicts_unresolved"; conflictedFiles: string[]; message: string };

export type SyncPhase = "idle" | "checking" | "needs_choice" | "working" | "ok" | "failed";

export type SyncController = {
  phase: SyncPhase;
  status: SyncStatus | null;
  mergeResult: MergeOutcome | null;
  toast: string | null;
  error: string | null;
  acceptMerge: () => Promise<void>;
  acceptDiscard: () => Promise<void>;
  dismiss: () => void;
  recheck: () => Promise<void>;
};

export function useEditorSync(projectId: string): SyncController {
  const [phase, setPhase] = useState<SyncPhase>("idle");
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [mergeResult, setMergeResult] = useState<MergeOutcome | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recheck = useCallback(async () => {
    if (!projectId) return;
    setPhase("checking");
    setError(null);
    try {
      const s = await apiJson<SyncStatus>(`/api/projects/${projectId}/sync-status`);
      setStatus(s);
      if (s.state === "in_sync" || s.state === "ahead_only") {
        setPhase("ok");
        return;
      }
      if (s.state === "behind") {
        // Auto fast-forward: safe because there's nothing local to lose.
        setPhase("working");
        const result = await apiJson<{ pulled: number }>(
          `/api/projects/${projectId}/sync/fast-forward`,
          { method: "POST" },
        );
        setToast(
          result.pulled === 1
            ? "Pulled 1 new change from your team."
            : `Pulled ${result.pulled} new changes from your team.`,
        );
        setPhase("ok");
        return;
      }
      // behind_with_local_changes -> surface the modal.
      setPhase("needs_choice");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync check failed");
      setPhase("failed");
    }
  }, [projectId]);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const acceptMerge = useCallback(async () => {
    setPhase("working");
    setError(null);
    try {
      const result = await apiJson<MergeOutcome>(`/api/projects/${projectId}/sync/merge`, {
        method: "POST",
      });
      setMergeResult(result);
      if (result.state === "conflicts_unresolved") {
        setPhase("failed");
        setError(
          result.message || "We couldn't combine your changes with the team's. An admin can help.",
        );
        return;
      }
      if (result.state === "conflicts_resolved") {
        setToast(
          `Combined your changes with ${result.resolvedFiles.length} tricky file${
            result.resolvedFiles.length === 1 ? "" : "s"
          }. All set.`,
        );
      } else {
        setToast("Your changes now match your team's latest.");
      }
      setPhase("ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed");
      setPhase("failed");
    }
  }, [projectId]);

  const acceptDiscard = useCallback(async () => {
    setPhase("working");
    setError(null);
    try {
      await apiJson(`/api/projects/${projectId}/sync/discard`, { method: "POST" });
      setToast("Threw away your changes and pulled the latest.");
      setPhase("ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discard failed");
      setPhase("failed");
    }
  }, [projectId]);

  const dismiss = useCallback(() => {
    setPhase("ok");
    setError(null);
  }, []);

  return {
    phase,
    status,
    mergeResult,
    toast,
    error,
    acceptMerge,
    acceptDiscard,
    dismiss,
    recheck,
  };
}
