/**
 * Publish lifecycle glue for the Editor page. Owns the publish
 * mutation, the pre-flight /publish-status fetch state, and the
 * "open" handler that resets the previous run, flips the modal on,
 * and populates publishStatus with a fresh review.
 *
 * Extracted out of packages/web/src/pages/Editor.tsx. Logic moved
 * verbatim, no behaviour change.
 */

import type { PublishStatus } from "@/components/organisms/editor/EditorPublishModal";
import { apiJson } from "@/lib/api";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

export function useEditorPublish(projectId: string) {
  const id = projectId;
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishStatus, setPublishStatus] = useState<PublishStatus | null>(null);
  const [publishStatusLoading, setPublishStatusLoading] = useState(false);

  const publishMut = useMutation({
    mutationFn: () =>
      apiJson<{ ok: boolean; message: string }>(`/api/projects/${id}/publish`, { method: "POST" }),
  });

  const openPublishModal = useCallback(async () => {
    publishMut.reset();
    setPublishStatus(null);
    setPublishStatusLoading(true);
    setShowPublishModal(true);
    try {
      const status = await apiJson<PublishStatus>(`/api/projects/${id}/publish-status?summary=1`);
      setPublishStatus(status);
    } catch {
      setPublishStatus({ dirty: [], unpushed: 0, hasChanges: false });
    } finally {
      setPublishStatusLoading(false);
    }
  }, [id, publishMut]);

  return {
    showPublishModal,
    setShowPublishModal,
    publishStatus,
    publishStatusLoading,
    publishMut,
    openPublishModal,
  };
}
