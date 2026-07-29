/**
 * Preview lifecycle glue for the Editor page:
 *
 *  - owns previewSrc / previewLabel / previewError state,
 *  - auto-starts the preview once per project on mount by first
 *    painting the (deterministic) preview URL from /preview-meta so
 *    the iframe shows the boot page immediately, then kicking off
 *    the real /preview mutation in the background,
 *  - exposes refreshPreview() which cache-busts the iframe src and
 *    also listens for the global `quillra:refresh-preview` event so
 *    components without direct access to editor state (e.g. the
 *    ChangesModal after a discard) can trigger a reload,
 *  - exposes the ready-made startLabel for the preview-start button.
 *
 * Extracted out of packages/web/src/pages/Editor.tsx. Logic moved
 * verbatim, no behaviour change.
 */

import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

type PreviewMeta = {
  url: string;
  previewLabel: string;
  previewMode: "host" | "path";
  accepted?: boolean;
  previewActive?: boolean;
  previewStarting?: boolean;
};

type ProjectPreviewMeta = PreviewMeta & { projectId: string };

function withCacheBuster(rawUrl: string): string {
  const url = new URL(rawUrl, window.location.href);
  url.searchParams.set("t", String(Date.now()));
  return url.toString();
}

export function useEditorPreview(projectId: string, autoStart = true) {
  const { t } = useT();
  const id = projectId;
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const [previewMode, setPreviewMode] = useState<"host" | "path" | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewStarted = useRef(false);
  const activeProjectId = useRef(id);

  // React Router can keep this hook mounted while only the route parameter
  // changes. Clear every project-owned value before the auto-start effect
  // below runs, otherwise the next project can inherit the previous iframe
  // URL and `previewStarted` guard.
  useEffect(() => {
    activeProjectId.current = id;
    previewStarted.current = false;
    setPreviewSrc(null);
    setPreviewLabel("");
    setPreviewMode(null);
    setPreviewError(null);
  }, [id]);

  const { mutate: startPreviewMutation, isPending: previewStarting } = useMutation({
    mutationFn: async (requestProjectId: string) => {
      const response = await apiJson<PreviewMeta>(`/api/projects/${requestProjectId}/preview`, {
        method: "POST",
      });
      return { ...response, projectId: requestProjectId } satisfies ProjectPreviewMeta;
    },
    onMutate: (requestProjectId) => {
      if (requestProjectId === activeProjectId.current) setPreviewError(null);
    },
    onSuccess: (res) => {
      if (res.projectId !== activeProjectId.current) return;
      // /preview-meta already painted an authenticated boot URL. The start
      // response contains a freshly minted one-time handoff for callers that
      // did not fetch metadata first; replacing an existing URL here would
      // navigate the iframe a second time and reset its visible progress.
      setPreviewSrc((current) => current ?? res.url);
      setPreviewLabel(res.previewLabel);
      setPreviewMode(res.previewMode);
    },
    onError: (error: Error, requestProjectId) => {
      if (requestProjectId === activeProjectId.current) setPreviewError(error.message);
    },
  });
  const startPreview = useCallback(() => startPreviewMutation(id), [id, startPreviewMutation]);

  const { mutate: refreshPreviewMutation, isPending: previewRefreshing } = useMutation({
    mutationFn: async (requestProjectId: string) => {
      const response = await apiJson<PreviewMeta>(
        `/api/projects/${requestProjectId}/preview/refresh`,
        { method: "POST" },
      );
      return { ...response, projectId: requestProjectId } satisfies ProjectPreviewMeta;
    },
    onMutate: (requestProjectId) => {
      if (requestProjectId === activeProjectId.current) setPreviewError(null);
    },
    onSuccess: (res) => {
      if (res.projectId !== activeProjectId.current) return;
      // The refresh endpoint revokes the stale route before acknowledging.
      // Navigating now therefore lands on the authenticated warm-start page,
      // which follows the replacement until the changed site is ready.
      setPreviewSrc(withCacheBuster(res.url));
      setPreviewLabel(res.previewLabel);
      setPreviewMode(res.previewMode);
    },
    onError: (error: Error, requestProjectId) => {
      if (requestProjectId === activeProjectId.current) setPreviewError(error.message);
    },
  });
  const applyLatestChanges = useCallback(
    () => refreshPreviewMutation(id),
    [id, refreshPreviewMutation],
  );

  const refreshPreview = useCallback(() => {
    const requestProjectId = id;
    void apiJson<PreviewMeta>(`/api/projects/${requestProjectId}/preview-meta`)
      .then((meta) => {
        if (requestProjectId !== activeProjectId.current) return;
        setPreviewSrc(withCacheBuster(meta.url));
        setPreviewLabel(meta.previewLabel);
        setPreviewMode(meta.previewMode);
        if (!meta.previewActive && !meta.previewStarting && !previewStarting) startPreview();
      })
      .catch(() => {
        if (requestProjectId !== activeProjectId.current) return;
        setPreviewSrc((value) => {
          if (!value) return null;
          const url = new URL(value, window.location.href);
          url.searchParams.set("t", String(Date.now()));
          return url.toString();
        });
      });
  }, [id, previewStarting, startPreview]);

  // Listen for refresh events fired by components that don't have
  // direct access to Editor state (e.g. ChangesModal after discarding
  // changes). Chat turns and bulk Git operations explicitly reload the
  // iframe when they finish, which works consistently across frameworks.
  useEffect(() => {
    const handler = () => refreshPreview();
    window.addEventListener("quillra:refresh-preview", handler);
    return () => window.removeEventListener("quillra:refresh-preview", handler);
  }, [refreshPreview]);

  // Auto-start preview on mount: render the iframe immediately with the
  // (deterministic) preview URL so the user sees the proxy boot page with no
  // intermediate spinners. The dev server is started in the background.
  useEffect(() => {
    if (!id || !autoStart || previewStarted.current) return;
    previewStarted.current = true;
    void (async () => {
      const requestedProjectId = id;
      let shouldStart = true;
      try {
        const meta = await apiJson<PreviewMeta>(`/api/projects/${id}/preview-meta`);
        if (requestedProjectId !== activeProjectId.current) return;
        setPreviewLabel(meta.previewLabel);
        setPreviewSrc(meta.url);
        setPreviewMode(meta.previewMode);
        shouldStart = !meta.previewActive && !meta.previewStarting;
      } catch {
        /* not critical */
      }
      if (requestedProjectId !== activeProjectId.current) return;
      if (shouldStart) startPreview();
    })();
  }, [autoStart, id, startPreview]);

  const startLabel =
    previewLabel && previewLabel !== "-"
      ? t("preview.startSpecific", { framework: previewLabel })
      : t("preview.startLive");

  return {
    previewSrc,
    previewLabel,
    previewMode,
    previewError,
    startLabel,
    applyLatestChanges,
    refreshPreview,
    startPreview,
    starting: previewStarting || previewRefreshing,
  };
}
