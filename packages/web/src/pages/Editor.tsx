import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/atoms/Button";
import { Modal } from "@/components/atoms/Modal";
import { Spinner } from "@/components/atoms/Spinner";
import { ChatComposer, type ChatComposerHandle } from "@/components/organisms/ChatComposer";
import { ChatTranscript } from "@/components/organisms/ChatTranscript";
import { EditorToolbar } from "@/components/organisms/EditorToolbar";
import { PreviewPane } from "@/components/organisms/PreviewPane";
import { apiJson } from "@/lib/api";
import { useProjectChat } from "@/hooks/useProjectChat";
import { clearNewChat } from "@/lib/chat-store";

type ProjectDetail = {
  id: string;
  name: string;
  role: string;
};

type PublishStatus = {
  dirty: string[];
  unpushed: number;
  hasChanges: boolean;
  summary?: string;
};

type Conversation = {
  id: string;
  title: string | null;
  updatedAt: number;
};

export function EditorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const qc = useQueryClient();
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const [split, setSplit] = useState(42);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishStatus, setPublishStatus] = useState<PublishStatus | null>(null);
  const [publishStatusLoading, setPublishStatusLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const previewStarted = useRef(false);
  const initialConvSelected = useRef(false);
  const composerRef = useRef<ChatComposerHandle>(null);
  const chatDragDepth = useRef(0);
  const [chatDragging, setChatDragging] = useState(false);

  // Window-level paste handler so images can be pasted from anywhere on the editor
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't hijack paste when typing in inputs that aren't the composer
      if (target && target.tagName === "INPUT") return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItems = items.filter((i) => i.type.startsWith("image/"));
      if (imageItems.length === 0) return;
      e.preventDefault();
      const files = imageItems.map((i) => i.getAsFile()).filter((f): f is File => !!f);
      composerRef.current?.addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const { data: project } = useQuery({
    queryKey: ["project", id],
    queryFn: () => apiJson<ProjectDetail>(`/api/projects/${id}`),
    enabled: Boolean(id),
  });

  const { data: convList } = useQuery({
    queryKey: ["conversations", id],
    queryFn: () => apiJson<{ conversations: Conversation[] }>(`/api/projects/${id}/conversations`),
    enabled: Boolean(id),
  });

  // Auto-select the most recent conversation on initial load only
  useEffect(() => {
    if (convList?.conversations?.length && !initialConvSelected.current) {
      initialConvSelected.current = true;
      setConversationId(convList.conversations[0].id);
    }
  }, [convList]);

  const previewMut = useMutation({
    mutationFn: async () => {
      return apiJson<{ url: string; previewLabel: string }>(`/api/projects/${id}/preview`, { method: "POST" });
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

  const handleConversationCreated = useCallback((newId: string) => {
    setConversationId(newId);
    void qc.invalidateQueries({ queryKey: ["conversations", id] });
  }, [id, qc]);

  const { lines, busy, error, send } = useProjectChat(id || undefined, conversationId, refreshPreview, handleConversationCreated);

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
        const res = await apiJson<{ url: string; previewLabel: string }>(`/api/projects/${id}/preview`, {
          method: "POST",
        });
        setPreviewSrc(res.url);
        setPreviewLabel(res.previewLabel);
      } catch { /* user can start manually */ }
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

  const startNewChat = useCallback(() => {
    if (id) clearNewChat(id);
    setConversationId(null);
    setShowHistory(false);
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
        onPublish={openPublishModal}
      />
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800">{error}</div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section
          className="relative flex min-h-0 flex-col border-b border-neutral-200 md:border-b-0 md:border-r"
          style={{ flexBasis: `${split}%`, maxWidth: "100%" }}
          onDragEnter={(e) => {
            if (!Array.from(e.dataTransfer.types).includes("Files")) return;
            e.preventDefault();
            chatDragDepth.current += 1;
            setChatDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            chatDragDepth.current -= 1;
            if (chatDragDepth.current <= 0) {
              chatDragDepth.current = 0;
              setChatDragging(false);
            }
          }}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            chatDragDepth.current = 0;
            setChatDragging(false);
            composerRef.current?.addFiles(e.dataTransfer.files);
          }}
        >
          {chatDragging && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-brand/5 backdrop-blur-sm">
              <p className="rounded-full bg-white px-4 py-2 text-sm font-medium text-brand shadow-lg">
                Drop images to attach
              </p>
            </div>
          )}
          {/* Chat header with history toggle + new chat */}
          <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50/80 px-3 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700"
                onClick={() => setShowHistory((s) => !s)}
                title="Chat history"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              <div>
                <p className="text-xs font-medium text-neutral-700">Assistant</p>
              </div>
            </div>
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-700"
              onClick={startNewChat}
              title="New chat"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New
            </button>
          </div>

          {/* History sidebar (overlay) */}
          {showHistory && (
            <div className="border-b border-neutral-200 bg-white">
              <div className="max-h-48 overflow-y-auto">
                {convList?.conversations?.length ? (
                  convList.conversations.map((conv) => (
                    <button
                      key={conv.id}
                      type="button"
                      className={`flex w-full items-center gap-2 border-b border-neutral-100 px-3 py-2.5 text-left text-xs transition-colors hover:bg-neutral-50 ${conv.id === conversationId ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-600"}`}
                      onClick={() => {
                        setConversationId(conv.id);
                        setShowHistory(false);
                      }}
                    >
                      <svg className="h-3 w-3 shrink-0 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                      </svg>
                      <span className="min-w-0 truncate">{conv.title || "Untitled"}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-neutral-400">
                        {new Date(conv.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="px-3 py-4 text-center text-xs text-neutral-400">No conversations yet</p>
                )}
              </div>
            </div>
          )}

          <ChatTranscript lines={lines} busy={busy} onNewChat={startNewChat} />
          <ChatComposer ref={composerRef} projectId={id} onSend={send} disabled={busy} />
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
        <h3 className="mb-1 text-lg font-semibold text-neutral-900">Go live</h3>

        {publishStatusLoading && (
          <div className="flex flex-col items-center py-6">
            <Spinner className="mb-3 size-5" />
            <p className="text-sm text-neutral-500">Reviewing your changes…</p>
          </div>
        )}

        {publishMut.isIdle && publishStatus && !publishStatusLoading && (
          <>
            {publishStatus.hasChanges ? (
              <>
                {publishStatus.summary ? (
                  <div className="mb-4 mt-2 text-sm leading-relaxed text-neutral-600 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:mb-0.5 [&_p]:mb-1 [&_p:last-child]:mb-0">
                    <ReactMarkdown>{publishStatus.summary}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="mb-4 mt-1 text-sm text-neutral-500">
                    Your recent edits are ready to go live.
                  </p>
                )}
                <Button
                  type="button"
                  className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
                  onClick={() => publishMut.mutate()}
                >
                  Publish now
                </Button>
              </>
            ) : (
              <>
                <p className="mb-6 mt-2 text-sm text-neutral-500">
                  Your site is up to date — nothing new to publish.
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
          <div className="flex flex-col items-center py-8">
            <Spinner className="mb-4 size-6" />
            <p className="text-sm font-medium text-neutral-700">Publishing your changes…</p>
            <p className="mt-1 text-xs text-neutral-400">Your site will update in a few moments.</p>
          </div>
        )}

        {publishMut.isSuccess && (
          <>
            <div className="mb-4 mt-3 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
              <span className="text-green-600">&#10003;</span>
              <p className="text-sm text-green-700">Your changes are live! It may take a minute for the update to appear on your site.</p>
            </div>
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
              Something went wrong while publishing. Please try again.
            </p>
            <Button
              type="button"
              className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
              onClick={() => publishMut.mutate()}
            >
              Try again
            </Button>
          </>
        )}
      </Modal>
    </div>
  );
}
