/**
 * Editor page shell. Owns routing, project + conversation queries,
 * the chat/preview split state, and the chat state from useProjectChat.
 * Everything that can be pulled out has been: preview lifecycle,
 * publish lifecycle, migration glue, and paste handling live in
 * their own hooks under components/organisms/editor/.
 */

import type { ChatComposerHandle } from "@/components/organisms/ChatComposer";
import { EditorChatPanel } from "@/components/organisms/editor/EditorChatPanel";
import { EditorChrome } from "@/components/organisms/editor/EditorChrome";
import { EditorMobileSheet } from "@/components/organisms/editor/EditorMobileSheet";
import { EditorPreviewPanel } from "@/components/organisms/editor/EditorPreviewPanel";
import { EditorPublishModal } from "@/components/organisms/editor/EditorPublishModal";
import { useEditorMigration } from "@/components/organisms/editor/useEditorMigration";
import { useEditorPaste } from "@/components/organisms/editor/useEditorPaste";
import { useEditorPreview } from "@/components/organisms/editor/useEditorPreview";
import { useEditorPublish } from "@/components/organisms/editor/useEditorPublish";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useProjectChat } from "@/hooks/useProjectChat";
import { apiJson } from "@/lib/api";
import { clearNewChat } from "@/lib/chat-store";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

type ProjectDetail = {
  id: string;
  name: string;
  role: string;
  /** "astro" while the migration agent is rewriting the project.
   *  null when not migrating. Cleared by the server on done. */
  migrationTarget: "astro" | null;
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
  const me = useCurrentUser();
  const isClient = me.kind === "client";
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const qc = useQueryClient();
  const [split, setSplit] = useState(42);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const initialConvSelected = useRef(false);
  const composerRef = useRef<ChatComposerHandle>(null);

  useEditorPaste(composerRef);

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

  // Project members list, only fetched when the current viewer can see
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

  const {
    previewSrc,
    previewLabel,
    previewError,
    startLabel,
    refreshPreview,
    startPreview,
    starting,
  } = useEditorPreview(id);

  const {
    showPublishModal,
    setShowPublishModal,
    publishStatus,
    publishStatusLoading,
    publishMut,
    openPublishModal,
  } = useEditorPublish(id);

  const handleConversationCreated = useCallback(
    (newId: string) => {
      setConversationId(newId);
      void qc.invalidateQueries({ queryKey: ["conversations", id] });
    },
    [id, qc],
  );

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

  const { isMigratingToAstro, cancelMigration } = useEditorMigration({
    projectId: id,
    project,
    convList,
    send,
  });

  const startNewChat = useCallback(() => {
    if (id) clearNewChat(id);
    setConversationId(null);
    setShowHistory(false);
  }, [id]);

  if (!id) return null;

  const canPublish = project?.role === "admin" || project?.role === "editor";

  return (
    <div className="flex h-screen min-h-0 flex-col bg-white">
      <EditorChrome
        projectId={id}
        projectName={project?.name ?? "…"}
        canPublish={Boolean(canPublish)}
        publishing={publishMut.isPending}
        onPublish={openPublishModal}
        error={error}
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <EditorChatPanel
          projectId={id}
          isClient={isClient}
          me={me}
          split={split}
          composerRef={composerRef}
          lines={lines}
          busy={busy}
          send={send}
          conversationId={conversationId}
          setConversationId={setConversationId}
          showHistory={showHistory}
          setShowHistory={setShowHistory}
          convList={convList}
          convFilterUserId={convFilterUserId}
          setConvFilterUserId={setConvFilterUserId}
          members={membersQ.data?.members}
          isMigratingToAstro={isMigratingToAstro}
          startNewChat={startNewChat}
          openMobilePreview={() => setMobilePreviewOpen(true)}
        />
        <EditorPreviewPanel
          projectId={id}
          isMigratingToAstro={isMigratingToAstro}
          cancelMigration={cancelMigration}
          previewSrc={previewSrc}
          previewLabel={previewLabel}
          previewError={previewError}
          startLabel={startLabel}
          onRefresh={refreshPreview}
          onStartPreview={startPreview}
          starting={starting}
          split={split}
          setSplit={setSplit}
          send={send}
        />
      </div>

      {/* Mobile-only: preview bottom sheet (opened via chat-header button).
          During a migration, the sheet shows the MigrationBanner instead,           no useful preview exists until the agent finishes. */}
      <EditorMobileSheet
        projectId={id}
        open={mobilePreviewOpen}
        onClose={() => setMobilePreviewOpen(false)}
        isMigratingToAstro={isMigratingToAstro}
        cancelMigration={cancelMigration}
        previewSrc={previewSrc}
        previewLabel={previewLabel}
        previewError={previewError}
        startLabel={startLabel}
        onRefresh={refreshPreview}
        onStartPreview={startPreview}
        starting={starting}
        send={send}
      />

      <EditorPublishModal
        open={showPublishModal}
        onClose={() => setShowPublishModal(false)}
        publishMut={publishMut}
        publishStatus={publishStatus}
        publishStatusLoading={publishStatusLoading}
      />
    </div>
  );
}
