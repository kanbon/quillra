/**
 * Editor-side glue for the Astro migration flow:
 *
 *  - derives `isMigratingToAstro` from the project row (source of
 *    truth lives in the DB so this survives reloads),
 *  - auto-sends the kickoff prompt exactly once per project when we
 *    land on a migrating project with no conversations yet (ref guard
 *    so mid-stream refetches of convList don't re-fire the send),
 *  - exposes a `cancelMigration` escape hatch that clears the flag,
 *    rolls the workspace back to origin, and re-fetches project and
 *    conversations so the UI unlocks cleanly.
 *
 * Extracted out of packages/web/src/pages/Editor.tsx. Logic moved
 * verbatim, no behaviour change.
 */

import { apiJson } from "@/lib/api";
import { ASTRO_MIGRATION_KICKOFF_PROMPT } from "@/lib/migration-prompts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

type ProjectLike = {
  migrationTarget: "astro" | null;
} | null
  | undefined;

type ConvListLike = {
  conversations: { id: string }[];
} | undefined;

export function useEditorMigration(params: {
  projectId: string;
  project: ProjectLike;
  convList: ConvListLike;
  send: (prompt: string) => void;
}) {
  const { projectId: id, project, convList, send } = params;
  const qc = useQueryClient();

  // Derived state: true while the project row still has migration_target
  // set. This is the source of truth for locking the UI (disabling the
  // composer, hiding the preview in favour of the MigrationBanner).
  // Survives page reloads because it comes from the DB, not local state.
  const isMigratingToAstro = project?.migrationTarget === "astro";

  // Auto-send the migration kickoff prompt exactly once per project, when we
  // land on a project flagged for migration and there are no conversations
  // yet. A ref guard prevents double-sends if the effect
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
    // Also invalidate conversations, the stuck run may have
    // half-created one, and refetching ensures the migration-kickoff
    // useEffect above doesn't re-fire based on a stale empty list.
    await qc.invalidateQueries({ queryKey: ["conversations", id] });
  }, [id, qc]);

  return { isMigratingToAstro, cancelMigration };
}
