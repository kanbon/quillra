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

export function useEditorPreview(projectId: string) {
  const { t } = useT();
  const id = projectId;
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewStarted = useRef(false);

  const previewMut = useMutation({
    mutationFn: async () => {
      return apiJson<{ url: string; previewLabel: string }>(`/api/projects/${id}/preview`, {
        method: "POST",
      });
    },
    onMutate: () => setPreviewError(null),
    onSuccess: (res) => {
      setPreviewSrc(res.url);
      setPreviewLabel(res.previewLabel);
    },
    onError: (e: Error) => setPreviewError(e.message),
  });

  const refreshPreview = useCallback(() => {
    setPreviewSrc((u) => (u ? `${u.split("?")[0]}?t=${Date.now()}` : null));
  }, []);

  // Listen for refresh events fired by components that don't have
  // direct access to Editor state (e.g. ChangesModal after discarding
  // changes). The dev server's file watcher should pick up most file
  // edits automatically, but a hard reset can change a lot of files
  // at once and some frameworks batch-drop HMR updates under that
  // load, reloading the iframe is the belt-and-suspenders fix.
  useEffect(() => {
    const handler = () => refreshPreview();
    window.addEventListener("quillra:refresh-preview", handler);
    return () => window.removeEventListener("quillra:refresh-preview", handler);
  }, [refreshPreview]);

  // Auto-start preview on mount: render the iframe immediately with the
  // (deterministic) preview URL so the user sees the proxy boot page with no
  // intermediate spinners. The dev server is started in the background.
  useEffect(() => {
    if (!id || previewStarted.current) return;
    previewStarted.current = true;
    void (async () => {
      try {
        const meta = await apiJson<{ url: string; previewLabel: string }>(
          `/api/projects/${id}/preview-meta`,
        );
        setPreviewLabel(meta.previewLabel);
        setPreviewSrc(meta.url);
      } catch {
        /* not critical */
      }
      previewMut.mutate();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const startLabel =
    previewLabel && previewLabel !== "-"
      ? t("preview.startSpecific", { framework: previewLabel })
      : t("preview.startLive");

  return {
    previewSrc,
    previewLabel,
    previewError,
    startLabel,
    refreshPreview,
    startPreview: () => previewMut.mutate(),
    starting: previewMut.isPending,
  };
}
