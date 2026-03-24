import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Modal } from "@/components/atoms/Modal";
import { Spinner } from "@/components/atoms/Spinner";
import { ChatComposer } from "@/components/organisms/ChatComposer";
import { ChatTranscript } from "@/components/organisms/ChatTranscript";
import { EditorToolbar } from "@/components/organisms/EditorToolbar";
import { PreviewPane } from "@/components/organisms/PreviewPane";
import { apiJson } from "@/lib/api";
import { useProjectChat } from "@/hooks/useProjectChat";

type ProjectDetail = {
  id: string;
  name: string;
  role: string;
};

type PublishStatus = {
  dirty: string[];
  unpushed: number;
  hasChanges: boolean;
};

export function EditorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const [split, setSplit] = useState(42);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishStatus, setPublishStatus] = useState<PublishStatus | null>(null);
  const [publishStatusLoading, setPublishStatusLoading] = useState(false);
  const previewStarted = useRef(false);

  const { data: project } = useQuery({
    queryKey: ["project", id],
    queryFn: () => apiJson<ProjectDetail>(`/api/projects/${id}`),
    enabled: Boolean(id),
  });

  const previewMut = useMutation({
    mutationFn: async () => {
      const res = await apiJson<{ url: string; previewLabel: string }>(`/api/projects/${id}/preview`, {
        method: "POST",
      });
      return res;
    },
    onMutate: () => setPreviewError(null),
    onSuccess: (res) => {
      setPreviewSrc(res.url);
      setPreviewLabel(res.previewLabel);
    },
    onError: (e: Error) => setPreviewError(e.message),
  });

  const publishMut = useMutation({
    mutationFn: () =>
      apiJson<{ ok: boolean; message: string }>(`/api/projects/${id}/publish`, { method: "POST" }),
  });

  const refreshPreview = useCallback(() => {
    setPreviewSrc((u) => (u ? `${u.split("?")[0]}?t=${Date.now()}` : null));
  }, []);

  const { lines, busy, error, send } = useProjectChat(id || undefined, refreshPreview);

  // Auto-start preview on mount
  useEffect(() => {
    if (!id || previewStarted.current) return;
    previewStarted.current = true;
    void (async () => {
      try {
        const meta = await apiJson<{ url: string; previewLabel: string }>(
          `/api/projects/${id}/preview-meta`,
        );
        setPreviewLabel(meta.previewLabel);
        // Auto-start the preview
        const res = await apiJson<{ url: string; previewLabel: string }>(`/api/projects/${id}/preview`, {
          method: "POST",
        });
        setPreviewSrc(res.url);
        setPreviewLabel(res.previewLabel);
      } catch {
        /* ignore — user can start manually */
      }
    })();
  }, [id]);

  const openPublishModal = useCallback(async () => {
    publishMut.reset();
    setPublishStatus(null);
    setPublishStatusLoading(true);
    setShowPublishModal(true);
    try {
      const status = await apiJson<PublishStatus>(`/api/projects/${id}/publish-status`);
      setPublishStatus(status);
    } catch {
      setPublishStatus({ dirty: [], unpushed: 0, hasChanges: false });
    } finally {
      setPublishStatusLoading(false);
    }
  }, [id, publishMut]);

  if (!id) return null;

  const canPublish = project?.role === "admin" || project?.role === "editor";
  const startLabel =
    previewLabel && previewLabel !== "—" ? `Start ${previewLabel} preview` : "Start live preview";

  return (
    <div className="flex h-screen min-h-0 flex-col bg-white">
      <EditorToolbar
        projectId={id}
        projectName={project?.name ?? "…"}
        canPublish={Boolean(canPublish)}
        publishing={publishMut.isPending}
        onPublish={openPublishModal}
      />
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800">{error}</div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section
          className="flex min-h-0 flex-col border-b border-neutral-200 md:border-b-0 md:border-r"
          style={{ flexBasis: `${split}%`, maxWidth: "100%" }}
        >
          <div className="border-b border-neutral-200 bg-neutral-50/80 px-3 py-2">
            <p className="text-xs font-medium text-neutral-700">Assistant</p>
            <p className="text-[11px] text-neutral-500">Describe edits; commits are made in the repo.</p>
          </div>
          <ChatTranscript lines={lines} busy={busy} />
          <ChatComposer onSend={send} disabled={busy} />
        </section>
        <div
          className="hidden w-1 shrink-0 cursor-col-resize bg-neutral-200 hover:bg-neutral-400 md:block"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const start = split;
            const wrap = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width;
            const onMove = (ev: MouseEvent) => {
              const dx = ev.clientX - startX;
              const next = Math.min(72, Math.max(28, start + (dx / wrap) * 100));
              setSplit(next);
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          role="separator"
          aria-orientation="vertical"
        />
        <section className="min-h-[40vh] min-w-0 flex-1 md:min-h-0">
          <PreviewPane
            src={previewSrc}
            onRefresh={refreshPreview}
            onStartPreview={() => previewMut.mutate()}
            starting={previewMut.isPending}
            engineLabel={previewLabel || undefined}
            startLabel={startLabel}
            errorMessage={previewError}
          />
        </section>
      </div>

      <Modal open={showPublishModal} onClose={() => !publishMut.isPending && setShowPublishModal(false)}>
        <h3 className="mb-1 text-lg font-semibold text-neutral-900">Publish changes</h3>

        {publishStatusLoading && (
          <div className="flex flex-col items-center py-6">
            <Spinner className="mb-3 size-5" />
            <p className="text-sm text-neutral-500">Checking for changes…</p>
          </div>
        )}

        {publishMut.isIdle && publishStatus && !publishStatusLoading && (
          <>
            {publishStatus.hasChanges ? (
              <>
                <div className="mb-4 mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                  {publishStatus.dirty.length > 0 && (
                    <div className="mb-2">
                      <p className="mb-1 text-xs font-medium text-neutral-500">Uncommitted changes</p>
                      <ul className="space-y-0.5">
                        {publishStatus.dirty.slice(0, 8).map((f) => (
                          <li key={f} className="truncate font-mono text-xs text-neutral-700">{f}</li>
                        ))}
                        {publishStatus.dirty.length > 8 && (
                          <li className="text-xs text-neutral-400">+{publishStatus.dirty.length - 8} more</li>
                        )}
                      </ul>
                    </div>
                  )}
                  {publishStatus.unpushed > 0 && (
                    <p className="text-xs text-neutral-600">
                      {publishStatus.unpushed} unpushed commit{publishStatus.unpushed !== 1 ? "s" : ""}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
                  onClick={() => publishMut.mutate()}
                >
                  Publish to GitHub
                </Button>
              </>
            ) : (
              <>
                <p className="mb-6 mt-2 text-sm text-neutral-500">
                  Everything is up to date — no changes to publish.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full rounded-xl py-3 text-[15px]"
                  onClick={() => setShowPublishModal(false)}
                >
                  Close
                </Button>
              </>
            )}
          </>
        )}

        {publishMut.isPending && (
          <div className="flex flex-col items-center py-6">
            <Spinner className="mb-3 size-6" />
            <p className="text-sm text-neutral-500">Publishing…</p>
          </div>
        )}

        {publishMut.isSuccess && (
          <>
            <p className="mb-6 mt-2 text-sm text-neutral-600">{publishMut.data?.message}</p>
            <Button
              type="button"
              className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
              onClick={() => setShowPublishModal(false)}
            >
              Done
            </Button>
          </>
        )}

        {publishMut.isError && (
          <>
            <p className="mb-6 mt-2 text-sm text-red-600">
              {publishMut.error instanceof Error ? publishMut.error.message : "Publish failed"}
            </p>
            <Button
              type="button"
              className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
              onClick={() => publishMut.mutate()}
            >
              Retry
            </Button>
          </>
        )}
      </Modal>
    </div>
  );
}
