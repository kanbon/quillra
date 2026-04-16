import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/atoms/Button";
import { Modal } from "@/components/atoms/Modal";
import { Spinner } from "@/components/atoms/Spinner";
import { ChatComposer, type ChatComposerHandle } from "@/components/organisms/ChatComposer";
import { ChatTranscript } from "@/components/organisms/ChatTranscript";
import { MigrationBanner } from "@/components/organisms/MigrationBanner";
import { ProjectHeader } from "@/components/organisms/ProjectHeader";
import { PreviewPane } from "@/components/organisms/PreviewPane";
import { apiJson } from "@/lib/api";
import { useProjectChat } from "@/hooks/useProjectChat";
import { useCurrentUser, signOutUnified } from "@/hooks/useCurrentUser";
import { clearNewChat } from "@/lib/chat-store";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";
import { ASTRO_MIGRATION_KICKOFF_PROMPT } from "@/lib/migration-prompts";
import { MobilePreviewSheet } from "@/components/organisms/MobilePreviewSheet";

type ProjectDetail = {
  id: string;
  name: string;
  role: string;
  /** "astro" while the migration agent is rewriting the project.
   *  null when not migrating. Cleared by the server on done. */
  migrationTarget: "astro" | null;
};

type PublishStatus = {
  dirty: string[];
  unpushed: number;
  hasChanges: boolean;
  summary?: string;
};

type ConvAuthor = { id: string; name: string; email: string; image: string | null };
type Conversation = {
  id: string;
  title: string | null;
  updatedAt: number;
  createdByUserId: string | null;
  author: ConvAuthor | null;
};
type ConversationsResponse = {
  viewerRole: string;
  canSeeAll: boolean;
  conversations: Conversation[];
};

export function EditorPage() {
  const { t } = useT();
  const me = useCurrentUser();
  const isClient = me.kind === "client";
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const qc = useQueryClient();
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const [split, setSplit] = useState(42);
  const [dragging, setDragging] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishStatus, setPublishStatus] = useState<PublishStatus | null>(null);
  const [publishStatusLoading, setPublishStatusLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const previewStarted = useRef(false);
  const initialConvSelected = useRef(false);
  const composerRef = useRef<ChatComposerHandle>(null);
  const chatDragDepth = useRef(0);
  const [chatDragging, setChatDragging] = useState(false);

  // Window-level paste handler so files can be pasted from anywhere on the editor
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't hijack paste when typing in inputs that aren't the composer
      if (target && target.tagName === "INPUT") return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const fileItems = items.filter(
        (i) => i.kind === "file" && (i.type.startsWith("image/") || i.type.startsWith("text/")),
      );
      if (fileItems.length === 0) return;
      e.preventDefault();
      const files = fileItems.map((i) => i.getAsFile()).filter((f): f is File => !!f);
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

  const [convFilterUserId, setConvFilterUserId] = useState<string | null>(null);
  const { data: convList } = useQuery({
    queryKey: ["conversations", id, convFilterUserId],
    queryFn: () =>
      apiJson<ConversationsResponse>(
        convFilterUserId
          ? `/api/projects/${id}/conversations?userId=${encodeURIComponent(convFilterUserId)}`
          : `/api/projects/${id}/conversations`,
      ),
    enabled: Boolean(id),
  });

  // Project members list — only fetched when the current viewer can see
  // other people's chats, so clients don't waste a request on a list
  // they can't use anyway.
  const membersQ = useQuery({
    queryKey: ["members", id],
    enabled: Boolean(id) && Boolean(convList?.canSeeAll),
    queryFn: () =>
      apiJson<{
        members: {
          id: string;
          userId: string;
          name: string;
          email: string;
          role: string;
        }[];
      }>(`/api/team/projects/${id}/members`),
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

  // Listen for refresh events fired by components that don't have
  // direct access to Editor state (e.g. ChangesModal after discarding
  // changes). The dev server's file watcher should pick up most file
  // edits automatically, but a hard reset can change a lot of files
  // at once and some frameworks batch-drop HMR updates under that
  // load — reloading the iframe is the belt-and-suspenders fix.
  useEffect(() => {
    const handler = () => refreshPreview();
    window.addEventListener("quillra:refresh-preview", handler);
    return () => window.removeEventListener("quillra:refresh-preview", handler);
  }, [refreshPreview]);

  const handleConversationCreated = useCallback((newId: string) => {
    setConversationId(newId);
    void qc.invalidateQueries({ queryKey: ["conversations", id] });
  }, [id, qc]);

  // When the server finishes a migration run, it clears the project's
  // migration_target and sends us a `migration_complete` WS frame.
  // That triggers this callback which just refetches the project so
  // the Editor's migrationTarget-gated UI lock drops.
  const handleMigrationComplete = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["project", id] });
  }, [id, qc]);

  const { lines, busy, error, send } = useProjectChat(
    id || undefined,
    conversationId,
    refreshPreview,
    handleConversationCreated,
    handleMigrationComplete,
  );

  // Derived state: true while the project row still has migration_target
  // set. This is the source of truth for locking the UI (disabling the
  // composer, hiding the preview in favour of the MigrationBanner).
  // Survives page reloads because it comes from the DB — not local state.
  const isMigratingToAstro = project?.migrationTarget === "astro";

  // Auto-send the migration kickoff prompt exactly once per project —
  // when we land on a project flagged for migration and there are no
  // conversations yet. A ref guard prevents double-sends if the effect
  // re-runs from `convList` refetching mid-stream. The guard resets
  // per component mount; across mounts `conversations.length > 0` as
  // soon as the first send lands, so the condition fails forever.
  const migrationKickoffSent = useRef(false);
  useEffect(() => {
    if (!id || !isMigratingToAstro) return;
    if (!convList) return;
    if (convList.conversations.length > 0) return;
    if (migrationKickoffSent.current) return;
    migrationKickoffSent.current = true;
    send(ASTRO_MIGRATION_KICKOFF_PROMPT);
  }, [id, isMigratingToAstro, convList, send]);

  // Escape hatch for stuck migrations. Clears migration_target on the
  // project and rolls the workspace back to origin, then refetches the
  // project so the Editor unlocks.
  const cancelMigration = useCallback(async () => {
    if (!id) return;
    await apiJson(`/api/projects/${id}/cancel-migration`, { method: "POST" });
    await qc.invalidateQueries({ queryKey: ["project", id] });
    // Also invalidate conversations — the stuck run may have
    // half-created one, and refetching ensures the migration-kickoff
    // useEffect above doesn't re-fire based on a stale empty list.
    await qc.invalidateQueries({ queryKey: ["conversations", id] });
  }, [id, qc]);

  // Auto-start preview on mount: render the iframe immediately with the
  // (deterministic) preview URL so the user sees the proxy boot page —
  // no intermediate spinners. The dev server is started in the background.
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
      } catch { /* not critical */ }
      previewMut.mutate();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  const startNewChat = useCallback(() => {
    if (id) clearNewChat(id);
    setConversationId(null);
    setShowHistory(false);
  }, [id]);

  if (!id) return null;

  const canPublish = project?.role === "admin" || project?.role === "editor";
  const startLabel =
    previewLabel && previewLabel !== "—"
      ? t("preview.startSpecific", { framework: previewLabel })
      : t("preview.startLive");

  return (
    <div className="flex h-screen min-h-0 flex-col bg-white">
      {/* Project header is desktop-only on mobile; on phones we reclaim the
          vertical space and drive the UI entirely through the chat +
          in-header preview button. */}
      <div className="hidden md:block">
        <ProjectHeader
          projectId={id}
          projectName={project?.name ?? "…"}
          canPublish={Boolean(canPublish)}
          publishing={publishMut.isPending}
          onPublish={openPublishModal}
        />
      </div>
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800">{error}</div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section
          className="relative flex min-h-0 w-full flex-1 flex-col md:w-auto md:max-w-full md:flex-none md:border-r md:border-neutral-200 md:[flex-basis:var(--chat-split)]"
          style={{ "--chat-split": `${split}%` } as React.CSSProperties}
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
                {t("composer.dropImages")}
              </p>
            </div>
          )}
          {/* Chat header with history toggle + new chat.
              On mobile the toolbar is hidden, so we also surface:
              preview, back-to-dashboard (non-clients), and sign-out. */}
          <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50/80 px-3 py-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {!isClient && (
                <Link
                  to="/dashboard"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 no-underline transition-colors hover:bg-neutral-200 hover:text-neutral-700 md:hidden"
                  title={t("toolbar.allSites")}
                  aria-label={t("toolbar.allSites")}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </Link>
              )}
              <button
                type="button"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700"
                onClick={() => setShowHistory((s) => !s)}
                title={t("chat.history")}
                aria-label={t("chat.history")}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              <p className="truncate text-xs font-medium text-neutral-700">{t("chat.assistant")}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-700"
                onClick={startNewChat}
                title={t("chat.newChat")}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span className="hidden sm:inline">{t("chat.new")}</span>
              </button>
              {/* Mobile-only: open preview bottom sheet */}
              <button
                type="button"
                className="flex items-center gap-1 rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white shadow-sm transition-colors hover:bg-neutral-800 md:hidden"
                onClick={() => setMobilePreviewOpen(true)}
                title={t("preview.mobileOpenAria")}
                aria-label={t("preview.mobileOpenAria")}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {t("preview.mobileOpen")}
              </button>
              {/* Mobile-only: sign out */}
              <button
                type="button"
                onClick={() =>
                  signOutUnified(
                    me.kind === "client" ? "client" : me.kind === "team" ? "team" : "github",
                  )
                }
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 md:hidden"
                title={t("toolbar.signOut")}
                aria-label={t("toolbar.signOut")}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          </div>

          {/* History sidebar (overlay) */}
          {showHistory && (
            <div className="border-b border-neutral-200 bg-white">
              {/* Admin/editor/translator user filter — clients never see this */}
              {convList?.canSeeAll && (
                <div className="flex items-center gap-2 border-b border-neutral-100 bg-neutral-50/50 px-3 py-2">
                  <svg className="h-3 w-3 shrink-0 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                  </svg>
                  <select
                    value={convFilterUserId ?? ""}
                    onChange={(e) => setConvFilterUserId(e.target.value || null)}
                    className="h-7 flex-1 rounded-md border border-neutral-200 bg-white px-2 text-xs text-neutral-700 focus:border-neutral-900 focus:outline-none focus:ring-0"
                  >
                    <option value="">{t("chat.allMembers")}</option>
                    {membersQ.data?.members.map((m) => (
                      <option key={m.id} value={m.userId}>
                        {m.name || m.email} · {m.role}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="max-h-64 overflow-y-auto">
                {convList?.conversations?.length ? (
                  convList.conversations.map((conv) => (
                    <button
                      key={conv.id}
                      type="button"
                      className={`flex w-full items-start gap-2.5 border-b border-neutral-100 px-3 py-2.5 text-left text-xs transition-colors hover:bg-neutral-50 ${conv.id === conversationId ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-600"}`}
                      onClick={() => {
                        setConversationId(conv.id);
                        setShowHistory(false);
                      }}
                    >
                      {/* Author avatar (admin view only) */}
                      {convList?.canSeeAll && conv.author ? (
                        conv.author.image ? (
                          <img
                            src={conv.author.image}
                            alt=""
                            className="mt-0.5 h-5 w-5 shrink-0 rounded-full object-cover"
                          />
                        ) : (
                          <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-neutral-200 to-neutral-300 text-[8px] font-semibold text-neutral-600">
                            {(conv.author.name?.[0] ?? conv.author.email[0] ?? "?").toUpperCase()}
                          </div>
                        )
                      ) : (
                        <svg className="mt-1 h-3 w-3 shrink-0 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">{conv.title || t("chat.untitled")}</span>
                          <span className="shrink-0 text-[10px] text-neutral-400">
                            {new Date(conv.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                        {convList?.canSeeAll && conv.author && (
                          <p className="mt-0.5 truncate text-[10px] text-neutral-400">
                            {conv.author.name || conv.author.email}
                          </p>
                        )}
                      </div>
                    </button>
                  ))
                ) : (
                  <p className="px-3 py-4 text-center text-xs text-neutral-400">{t("chat.noConversations")}</p>
                )}
              </div>
            </div>
          )}

          <ChatTranscript lines={lines} busy={busy} />
          <ChatComposer
            ref={composerRef}
            projectId={id}
            onSend={send}
            disabled={busy || isMigratingToAstro}
          />
        </section>
        <div
          className={cn(
            "hidden w-1.5 shrink-0 cursor-col-resize bg-neutral-200 transition-colors md:block",
            dragging ? "bg-brand" : "hover:bg-neutral-400",
          )}
          onPointerDown={(e) => {
            e.preventDefault();
            const target = e.currentTarget;
            target.setPointerCapture(e.pointerId);
            const startX = e.clientX;
            const start = split;
            const wrap = (target.parentElement as HTMLElement).getBoundingClientRect().width;
            setDragging(true);
            const onMove = (ev: PointerEvent) => {
              const dx = ev.clientX - startX;
              const next = Math.min(72, Math.max(28, start + (dx / wrap) * 100));
              setSplit(next);
            };
            const onUp = (ev: PointerEvent) => {
              try { target.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
              target.removeEventListener("pointermove", onMove);
              target.removeEventListener("pointerup", onUp);
              target.removeEventListener("pointercancel", onUp);
              setDragging(false);
            };
            target.addEventListener("pointermove", onMove);
            target.addEventListener("pointerup", onUp);
            target.addEventListener("pointercancel", onUp);
          }}
          role="separator"
          aria-orientation="vertical"
        />
        {/* Block iframe + selection while dragging so the cursor doesn't get eaten */}
        {dragging && (
          <div
            className="fixed inset-0 z-[999] cursor-col-resize"
            style={{ userSelect: "none" }}
            aria-hidden
          />
        )}
        {/* Desktop: inline preview pane.
            Mobile: hidden here and rendered inside the bottom sheet below.
            While migrating to Astro: replaced by the MigrationBanner —
            no preview makes sense while the project is being rewritten. */}
        <section className="hidden min-w-0 flex-1 md:block">
          {isMigratingToAstro ? (
            <MigrationBanner onCancel={cancelMigration} />
          ) : (
            <PreviewPane
              projectId={id}
              src={previewSrc}
              onRefresh={refreshPreview}
              onStartPreview={() => previewMut.mutate()}
              starting={previewMut.isPending}
              engineLabel={previewLabel || undefined}
              startLabel={startLabel}
              errorMessage={previewError}
            />
          )}
        </section>
      </div>

      {/* Mobile-only: preview bottom sheet (opened via chat-header button).
          During a migration, the sheet shows the MigrationBanner instead —
          no useful preview exists until the agent finishes. */}
      <MobilePreviewSheet open={mobilePreviewOpen} onClose={() => setMobilePreviewOpen(false)}>
        {isMigratingToAstro ? (
          <MigrationBanner onCancel={cancelMigration} />
        ) : (
          <PreviewPane
            projectId={id}
            src={previewSrc}
            onRefresh={refreshPreview}
            onStartPreview={() => previewMut.mutate()}
            starting={previewMut.isPending}
            engineLabel={previewLabel || undefined}
            startLabel={startLabel}
            errorMessage={previewError}
            compact
          />
        )}
      </MobilePreviewSheet>

      <Modal open={showPublishModal} onClose={() => !publishMut.isPending && setShowPublishModal(false)}>
        <h3 className="mb-1 text-lg font-semibold text-neutral-900">{t("publish.modalTitle")}</h3>

        {publishStatusLoading && (
          <div className="flex flex-col items-center py-6">
            <Spinner className="mb-3 size-5" />
            <p className="text-sm text-neutral-500">{t("publish.reviewing")}</p>
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
                    {t("publish.readyDescription")}
                  </p>
                )}
                <Button
                  type="button"
                  className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
                  onClick={() => publishMut.mutate()}
                >
                  {t("publish.publishNow")}
                </Button>
              </>
            ) : (
              <>
                <p className="mb-6 mt-2 text-sm text-neutral-500">
                  {t("publish.upToDate")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full rounded-xl py-3 text-[15px]"
                  onClick={() => setShowPublishModal(false)}
                >
                  {t("common.close")}
                </Button>
              </>
            )}
          </>
        )}

        {publishMut.isPending && (
          <div className="flex flex-col items-center py-8">
            <Spinner className="mb-4 size-6" />
            <p className="text-sm font-medium text-neutral-700">{t("publish.publishingHeading")}</p>
            <p className="mt-1 text-xs text-neutral-400">{t("publish.publishingSubtext")}</p>
          </div>
        )}

        {publishMut.isSuccess && (
          <>
            <div className="mb-4 mt-3 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
              <span className="text-green-600">&#10003;</span>
              <p className="text-sm text-green-700">{t("publish.success")}</p>
            </div>
            <Button
              type="button"
              className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
              onClick={() => setShowPublishModal(false)}
            >
              {t("common.done")}
            </Button>
          </>
        )}

        {publishMut.isError && (
          <>
            <p className="mb-6 mt-2 text-sm text-red-600">
              {t("publish.error")}
            </p>
            <Button
              type="button"
              className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
              onClick={() => publishMut.mutate()}
            >
              {t("common.tryAgain")}
            </Button>
          </>
        )}
      </Modal>
    </div>
  );
}
