/**
 * Mobile-only bottom sheet variant of the preview, opened via the
 * chat-header preview button. During an Astro migration the sheet
 * shows the MigrationBanner instead since no useful preview exists
 * until the agent finishes. Debug-with-chat closes the sheet on
 * phones so the composer is visible when the prompt lands.
 *
 * Extracted out of packages/web/src/pages/Editor.tsx. Logic and
 * markup were moved verbatim, no behaviour change.
 */

import { MigrationBanner } from "@/components/organisms/MigrationBanner";
import { MobilePreviewSheet } from "@/components/organisms/MobilePreviewSheet";
import { PreviewPane } from "@/components/organisms/PreviewPane";
import { buildPreviewDebugPrompt } from "@/lib/preview-debug-prompt";
import type { PreviewStatus } from "@/lib/use-preview-status";

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;

  isMigratingToAstro: boolean;
  cancelMigration: () => Promise<void>;

  previewSrc: string | null;
  previewLabel: string;
  previewError: string | null;
  startLabel: string;

  onRefresh: () => void;
  onStartPreview: () => void;
  starting: boolean;

  send: (prompt: string) => void;
};

export function EditorMobileSheet({
  projectId: id,
  open,
  onClose,
  isMigratingToAstro,
  cancelMigration,
  previewSrc,
  previewLabel,
  previewError,
  startLabel,
  onRefresh,
  onStartPreview,
  starting,
  send,
}: Props) {
  return (
    <MobilePreviewSheet open={open} onClose={onClose}>
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
          compact
          onDebugWithChat={(status: PreviewStatus) => {
            send(buildPreviewDebugPrompt(status));
            onClose();
          }}
        />
      )}
    </MobilePreviewSheet>
  );
}
