import { useEffect, useState } from "react";
import { apiJson } from "@/lib/api";

export type PreviewStage =
  | "idle"
  | "starting"
  | "installing"
  | "ready"
  | "error"
  | string;

type ChildProcess = {
  running: boolean;
  pid: number | null;
  exitCode: number | null;
  signalCode: string | null;
};

type UpstreamProbe = {
  ok: boolean;
  status?: number;
  contentType?: string;
  error?: string;
};

type LogLine = { t: number; stream: "stdout" | "stderr"; line: string };

export type PreviewStatus = {
  stage: PreviewStage;
  stageMessage: string | null;
  childProcess: ChildProcess;
  upstreamProbe: UpstreamProbe;
  /** Last 20 stderr log lines — enough context for an error overlay
   *  or a chat hand-off prompt without dumping the full log. */
  recentErrors: string[];
};

type RawResponse = {
  preview: { stage: PreviewStage; stageMessage: string | null };
  childProcess: ChildProcess;
  upstreamProbe: UpstreamProbe;
  logs: LogLine[];
};

/**
 * Poll `/api/projects/:id/preview-debug` on a gentle 5s cadence while
 * mounted. Returns null until the first response arrives, then updates
 * in place.
 *
 * Intentionally lightweight — the existing `PreviewDebugModal` polls at
 * 2s with a richer shape; this hook is the always-on background pulse
 * that drives the error overlay in `PreviewPane`.
 */
export function usePreviewStatus(projectId: string | undefined, enabled = true): PreviewStatus | null {
  const [status, setStatus] = useState<PreviewStatus | null>(null);

  useEffect(() => {
    if (!projectId || !enabled) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async () => {
      try {
        const res = await apiJson<RawResponse>(`/api/projects/${projectId}/preview-debug`);
        if (cancelled) return;
        const recentErrors = (res.logs ?? [])
          .filter((l) => l.stream === "stderr")
          .slice(-20)
          .map((l) => l.line);
        setStatus({
          stage: res.preview.stage,
          stageMessage: res.preview.stageMessage,
          childProcess: res.childProcess,
          upstreamProbe: res.upstreamProbe,
          recentErrors,
        });
      } catch {
        /* non-fatal — keep the previous status */
      } finally {
        if (!cancelled) timer = setTimeout(fetchOnce, 5000);
      }
    };

    void fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, enabled]);

  return status;
}

/** True when the preview is in a state the user should see an error
 *  overlay for: the status service reports `error`, OR the dev server
 *  process has exited with a non-zero code. */
export function isPreviewErrored(status: PreviewStatus | null): boolean {
  if (!status) return false;
  if (status.stage === "error") return true;
  const cp = status.childProcess;
  if (!cp.running && cp.exitCode !== null && cp.exitCode !== 0) return true;
  return false;
}
