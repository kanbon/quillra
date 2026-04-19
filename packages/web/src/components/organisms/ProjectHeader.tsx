import { Heading } from "@/components/atoms/Heading";
import { LogoMark } from "@/components/atoms/LogoMark";
import { PresenceAvatars } from "@/components/molecules/PresenceAvatars";
import { AvatarDropdown } from "@/components/organisms/AvatarDropdown";
import { ChangesModal } from "@/components/organisms/ChangesModal";
import { VersionHistoryModal } from "@/components/organisms/VersionHistoryModal";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useProjectPresence } from "@/hooks/useProjectPresence";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useQuery } from "@tanstack/react-query";
/**
 * Single source of truth for the top bar when the user is inside a specific
 * project. Used by BOTH the Editor and Project Settings routes so the tab
 * positions + overall header chrome stay pixel-identical when switching
 * between them — no layout shift.
 *
 * The Editor/Project NavLink pair lives inside an absolute-centered wrapper
 * so left and right content can change width (e.g. the Publish button only
 * rendering on the editor route) without moving the tabs.
 */
import { useState } from "react";
import { Link, NavLink } from "react-router-dom";

type PublishStatusLite = {
  dirty: string[];
  unpushed: number;
  hasChanges: boolean;
};

type FrameworkInfo = {
  id: string;
  label: string;
  iconSlug: string;
  color: string;
  assetsDir: string;
  optimizes: boolean;
};

type Props = {
  projectId: string;
  projectName: string;
  /** Editor-only: show the publish button. ProjectSettings omits this. */
  canPublish?: boolean;
  publishing?: boolean;
  onPublish?: () => void;
};

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-lg px-3.5 py-2 text-[13px] font-medium no-underline transition-colors",
    isActive
      ? "bg-neutral-900 text-white shadow-sm"
      : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
  );

export function ProjectHeader({
  projectId,
  projectName,
  canPublish,
  publishing,
  onPublish,
}: Props) {
  const { t } = useT();
  const me = useCurrentUser();
  const isClient = me.kind === "client";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const showPublish = Boolean(canPublish && onPublish);
  // Clients beat presence too (so the team can see them viewing), but they
  // don't get to see who else is here. Only team members read the roster.
  const presence = useProjectPresence(projectId);
  const othersVisible = isClient ? [] : presence;

  const { data: framework } = useQuery({
    queryKey: ["project-framework", projectId],
    queryFn: () => apiJson<FrameworkInfo>(`/api/projects/${projectId}/framework`),
    enabled: Boolean(projectId),
    staleTime: 5 * 60 * 1000,
  });

  // Light-weight polling of publish-status so the "N changes" pill can
  // show the current dirty count without hammering the AI-summary path.
  // Only enabled for users who can actually publish — clients never see
  // this indicator.
  const { data: publishStatus } = useQuery({
    queryKey: ["publish-status", projectId],
    queryFn: () => apiJson<PublishStatusLite>(`/api/projects/${projectId}/publish-status`),
    enabled: Boolean(projectId) && showPublish,
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
  const pendingCount = publishStatus ? publishStatus.dirty.length + publishStatus.unpushed : 0;
  const hasChanges = Boolean(publishStatus?.hasChanges);

  return (
    <header className="h-14 shrink-0 border-b border-neutral-200/90 bg-white/95 backdrop-blur-sm">
      <div className="relative flex h-full items-center gap-x-4 px-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {isClient ? (
            <div className="flex shrink-0 items-center gap-2">
              <LogoMark size={22} />
            </div>
          ) : (
            <Link
              to="/dashboard"
              className="flex shrink-0 items-center gap-2 rounded-lg no-underline hover:bg-neutral-50"
              title={t("toolbar.allSites")}
            >
              <LogoMark size={22} />
            </Link>
          )}
          <div className="hidden h-8 w-px bg-neutral-200 sm:block" />
          <div className="min-w-0 flex-1">
            {!isClient && (
              <Link
                to="/dashboard"
                className="mb-0.5 block text-[11px] font-medium uppercase tracking-wider text-neutral-400 no-underline hover:text-brand"
              >
                {t("toolbar.allSites")}
              </Link>
            )}
            <div className="flex items-center gap-2">
              <Heading
                as="h2"
                className="truncate text-base font-semibold tracking-tight text-neutral-900"
              >
                {projectName}
              </Heading>
              {framework && framework.id !== "unknown" && (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white py-1 pl-1 pr-2.5 text-[11px] font-semibold tracking-tight text-neutral-700 shadow-sm ring-1 ring-neutral-200"
                  title={`${framework.label}${framework.optimizes ? ` · ${t("toolbar.autoOptimisesImages")}` : ""}`}
                >
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded-full"
                    style={{ backgroundColor: framework.color }}
                  >
                    <img
                      src={`https://cdn.simpleicons.org/${framework.iconSlug}/ffffff`}
                      alt=""
                      width={11}
                      height={11}
                    />
                  </span>
                  {framework.label}
                </span>
              )}
            </div>
          </div>
        </div>

        {!isClient && (
          <nav
            className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 md:block"
            aria-label={t("toolbar.project")}
          >
            <div className="pointer-events-auto flex items-center gap-1 rounded-xl bg-neutral-100/90 p-1">
              <NavLink to={`/p/${projectId}`} end className={tabClass}>
                {t("toolbar.editor")}
              </NavLink>
              <NavLink to={`/p/${projectId}/settings`} className={tabClass}>
                {t("toolbar.project")}
              </NavLink>
            </div>
          </nav>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {othersVisible.length > 0 && (
            <>
              <PresenceAvatars users={othersVisible} />
              <div className="h-6 w-px bg-neutral-200" />
            </>
          )}
          {!isClient && (
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
              title={t("versionHistory.open")}
              aria-label={t("versionHistory.open")}
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
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </button>
          )}
          {showPublish && hasChanges && (
            <button
              type="button"
              onClick={() => setChangesOpen(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 text-[12px] font-semibold text-amber-800 transition-colors hover:bg-amber-100"
              title={t("changes.openTooltip")}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 animate-pulse" />
              {pendingCount} {pendingCount === 1 ? t("changes.single") : t("changes.plural")}
            </button>
          )}
          {showPublish && (
            <button
              type="button"
              disabled={publishing}
              onClick={onPublish}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-[13px] font-semibold text-white shadow-sm transition-all",
                publishing ? "cursor-wait opacity-70" : "hover:bg-brand/90 hover:shadow",
              )}
            >
              {publishing ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  {t("toolbar.publishing")}
                </>
              ) : (
                <>
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  {t("toolbar.publish")}
                </>
              )}
            </button>
          )}
          <div className="h-6 w-px bg-neutral-200" />
          {/* Vercel-style account menu: avatar + name, click to reach
              language, org settings, and sign-out without leaving the
              editor. Replaces the bare sign-out icon this used to show. */}
          <AvatarDropdown />
        </div>
      </div>
      <VersionHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        projectId={projectId}
      />
      <ChangesModal
        open={changesOpen}
        onClose={() => setChangesOpen(false)}
        projectId={projectId}
      />
    </header>
  );
}
