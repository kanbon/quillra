import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
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

export function EditorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const [split, setSplit] = useState(42);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

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
    onSuccess: (res) => {
      setPublishMessage(res.message);
    },
    onError: (e: Error) => {
      setPublishMessage(e.message);
    },
  });

  const refreshPreview = useCallback(() => {
    setPreviewSrc((u) => (u ? `${u.split("?")[0]}?t=${Date.now()}` : null));
  }, []);

  const { lines, busy, error, send } = useProjectChat(id || undefined, refreshPreview);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const meta = await apiJson<{ url: string; previewLabel: string }>(
          `/api/projects/${id}/preview-meta`,
        );
        setPreviewLabel(meta.previewLabel);
      } catch {
        /* ignore */
      }
    })();
  }, [id]);

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
        onPublish={() => {
          setPublishMessage(null);
          publishMut.mutate();
        }}
      />
      {publishMessage && (
        <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-center text-xs text-neutral-700">
          {publishMessage}
        </div>
      )}
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
    </div>
  );
}
