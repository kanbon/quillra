/**
 * Top-of-page chrome for the Editor: the desktop-only ProjectHeader
 * wrapper (phones reclaim this space since their toolbar lives inside
 * the chat panel) and the thin red error banner surfaced when the
 * chat websocket reports an error.
 *
 * Extracted out of packages/web/src/pages/Editor.tsx. Logic and
 * markup were moved verbatim, no behaviour change.
 */

import { ProjectHeader } from "@/components/organisms/ProjectHeader";

type Props = {
  projectId: string;
  projectName: string;
  canPublish: boolean;
  publishing: boolean;
  onPublish: () => void;
  error: string | null;
};

export function EditorChrome({
  projectId,
  projectName,
  canPublish,
  publishing,
  onPublish,
  error,
}: Props) {
  return (
    <>
      {/* Project header is desktop-only on mobile; on phones we reclaim the
          vertical space and drive the UI entirely through the chat +
          in-header preview button. */}
      <div className="hidden md:block">
        <ProjectHeader
          projectId={projectId}
          projectName={projectName}
          canPublish={canPublish}
          publishing={publishing}
          onPublish={onPublish}
        />
      </div>
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800">
          {error}
        </div>
      )}
    </>
  );
}
