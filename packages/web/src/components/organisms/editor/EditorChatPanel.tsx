/**
 * Left-hand chat surface of the Editor page: the resizable section
 * that hosts the chat toolbar (history toggle + new chat button, plus
 * mobile-only back/preview/sign-out shortcuts), the optional history
 * sidebar, and the ChatTranscript + ChatComposer pair.
 *
 * Owns the file-drag-over highlight state locally, everything else
 * (conversation selection, member filter, etc) is driven by props
 * so Editor.tsx stays the single source of truth for chat state.
 *
 * Extracted out of packages/web/src/pages/Editor.tsx. Logic and
 * markup were moved verbatim, no behaviour change.
 */

import { ChatComposer, type ChatComposerHandle } from "@/components/organisms/ChatComposer";
import { ChatTranscript } from "@/components/organisms/ChatTranscript";
import { signOutUnified } from "@/hooks/useCurrentUser";
import { useT } from "@/i18n/i18n";
import { pickAskOther } from "@/lib/chat-store";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";

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

type Member = { id: string; userId: string; name: string; email: string; role: string };

type CurrentUser = { kind: "client" | "team" | "github" | string };

type ChatLines = Parameters<typeof ChatTranscript>[0]["lines"];

type Props = {
  projectId: string;
  isClient: boolean;
  me: CurrentUser;
  split: number;
  composerRef: React.RefObject<ChatComposerHandle | null>;

  // Chat state
  lines: ChatLines;
  busy: boolean;
  send: (prompt: string) => void;
  conversationId: string | null;
  setConversationId: (id: string | null) => void;

  // History panel state
  showHistory: boolean;
  setShowHistory: React.Dispatch<React.SetStateAction<boolean>>;
  convList: ConversationsResponse | undefined;
  convFilterUserId: string | null;
  setConvFilterUserId: (id: string | null) => void;
  members: Member[] | undefined;

  // Composer lock while the migration agent is running
  isMigratingToAstro: boolean;

  // Callbacks for shared actions owned by Editor.tsx
  startNewChat: () => void;
  openMobilePreview: () => void;
};

export function EditorChatPanel({
  projectId: id,
  isClient,
  me,
  split,
  composerRef,
  lines,
  busy,
  send,
  conversationId,
  setConversationId,
  showHistory,
  setShowHistory,
  convList,
  convFilterUserId,
  setConvFilterUserId,
  members,
  isMigratingToAstro,
  startNewChat,
  openMobilePreview,
}: Props) {
  const { t } = useT();
  const chatDragDepth = useRef(0);
  const [chatDragging, setChatDragging] = useState(false);

  return (
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
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
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
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
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
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            <span className="hidden sm:inline">{t("chat.new")}</span>
          </button>
          {/* Mobile-only: open preview bottom sheet */}
          <button
            type="button"
            className="flex items-center gap-1 rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white shadow-sm transition-colors hover:bg-neutral-800 md:hidden"
            onClick={openMobilePreview}
            title={t("preview.mobileOpenAria")}
            aria-label={t("preview.mobileOpenAria")}
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
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
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* History sidebar (overlay) */}
      {showHistory && (
        <div className="border-b border-neutral-200 bg-white">
          {/* Admin/editor/translator user filter, clients never see this */}
          {convList?.canSeeAll && (
            <div className="flex items-center gap-2 border-b border-neutral-100 bg-neutral-50/50 px-3 py-2">
              <svg
                className="h-3 w-3 shrink-0 text-neutral-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                />
              </svg>
              <select
                value={convFilterUserId ?? ""}
                onChange={(e) => setConvFilterUserId(e.target.value || null)}
                className="h-7 flex-1 rounded-md border border-neutral-200 bg-white px-2 text-xs text-neutral-700 focus:border-neutral-900 focus:outline-none focus:ring-0"
              >
                <option value="">{t("chat.allMembers")}</option>
                {members?.map((m) => (
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
                    <svg
                      className="mt-1 h-3 w-3 shrink-0 text-neutral-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                      />
                    </svg>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        {conv.title || t("chat.untitled")}
                      </span>
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
              <p className="px-3 py-4 text-center text-xs text-neutral-400">
                {t("chat.noConversations")}
              </p>
            )}
          </div>
        </div>
      )}

      <ChatTranscript
        lines={lines}
        busy={busy}
        onSend={send}
        onAskOther={(askId) => {
          pickAskOther(id, conversationId, askId);
          composerRef.current?.focus();
        }}
      />
      <ChatComposer
        ref={composerRef}
        projectId={id}
        onSend={send}
        disabled={busy || isMigratingToAstro}
      />
    </section>
  );
}
