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
  previewActive?: boolean;
};

export function useEditorPreview(projectId: string, autoStart = true) {
  const { t } = useT();
  const id = projectId;
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const [previewMode, setPreviewMode] = useState<"host" | "path" | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewStarted = useRef(false);

  const { mutate: startPreview, isPending: previewStarting } = useMutation({
    mutationFn: async () => {
      return apiJson<PreviewMeta>(`/api/projects/${id}/preview`, {
        method: "POST",
      });
    },
    onMutate: () => setPreviewError(null),
    onSuccess: (res) => {
      setPreviewSrc(res.url);
      setPreviewLabel(res.previewLabel);
      setPreviewMode(res.previewMode);
    },
    onError: (e: Error) => setPreviewError(e.message),
  });

  const refreshPreview = useCallback(() => {
    void apiJson<PreviewMeta>(`/api/projects/${id}/preview-meta`)
      .then((meta) => {
        const url = new URL(meta.url, window.location.href);
        url.searchParams.set("t", String(Date.now()));
        setPreviewSrc(url.toString());
        setPreviewLabel(meta.previewLabel);
        setPreviewMode(meta.previewMode);
        if (!meta.previewActive && !previewStarting) startPreview();
      })
      .catch(() => {
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
      try {
        const meta = await apiJson<PreviewMeta>(`/api/projects/${id}/preview-meta`);
        setPreviewLabel(meta.previewLabel);
        setPreviewSrc(meta.url);
        setPreviewMode(meta.previewMode);
      } catch {
        /* not critical */
      }
      startPreview();
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
    refreshPreview,
    startPreview,
    starting: previewStarting,
  };
}
