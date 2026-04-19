/**
 * Right-hand preview surface of the Editor page: the col-resize
 * divider that drives the chat/preview split, the full-screen
 * resize overlay that blocks the iframe while dragging, and the
 * desktop-only preview pane.
 *
 * While the project is being migrated to Astro, the PreviewPane is
 * swapped for the MigrationBanner (no sensible preview exists while
 * the agent is rewriting the project).
 *
 * Extracted out of packages/web/src/pages/Editor.tsx. Logic and
 * markup were moved verbatim, no behaviour change.
 */

import { MigrationBanner } from "@/components/organisms/MigrationBanner";
import { PreviewPane } from "@/components/organisms/PreviewPane";
import { cn } from "@/lib/cn";
import { buildPreviewDebugPrompt } from "@/lib/preview-debug-prompt";
import type { PreviewStatus } from "@/lib/use-preview-status";
import { useState } from "react";

type Props = {
  projectId: string;
  isMigratingToAstro: boolean;
  cancelMigration: () => Promise<void>;

  previewSrc: string | null;
  previewLabel: string;
  previewError: string | null;
  startLabel: string;

  onRefresh: () => void;
  onStartPreview: () => void;
  starting: boolean;

  split: number;
  setSplit: (v: number) => void;

  send: (prompt: string) => void;
};

export function EditorPreviewPanel({
  projectId: id,
  isMigratingToAstro,
  cancelMigration,
  previewSrc,
  previewLabel,
  previewError,
  startLabel,
  onRefresh,
  onStartPreview,
  starting,
  split,
  setSplit,
  send,
}: Props) {
  const [dragging, setDragging] = useState(false);

  return (
    <>
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
            try {
              target.releasePointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
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
          While migrating to Astro: replaced by the MigrationBanner,             no preview makes sense while the project is being rewritten. */}
      <section className="hidden min-w-0 flex-1 md:block">
        {isMigratingToAstro ? (
          <MigrationBanner onCancel={cancelMigration} />
        ) : (
          <PreviewPane
            projectId={id}
            src={previewSrc}
            onRefresh={onRefresh}
            onStartPreview={onStartPreview}
            starting={starting}
            engineLabel={previewLabel || undefined}
            startLabel={startLabel}
            errorMessage={previewError}
            onDebugWithChat={(status: PreviewStatus) => {
              send(buildPreviewDebugPrompt(status));
            }}
          />
        )}
      </section>
    </>
  );
}
