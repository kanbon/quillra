import { useState } from "react";
import { NavLink, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Heading } from "@/components/atoms/Heading";
import { LogoMark } from "@/components/atoms/LogoMark";
import { SettingsModal } from "@/components/organisms/SettingsModal";
import { useCurrentUser, signOutUnified } from "@/hooks/useCurrentUser";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

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
  canPublish: boolean;
  publishing: boolean;
  onPublish: () => void;
};

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-lg px-3.5 py-2 text-[13px] font-medium no-underline transition-colors",
    isActive
      ? "bg-neutral-900 text-white shadow-sm"
      : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
  );

export function EditorToolbar({
  projectId,
  projectName,
  canPublish,
  publishing,
  onPublish,
}: Props) {
  const { t } = useT();
  const me = useCurrentUser();
  const isClient = me.kind === "client";
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data: framework } = useQuery({
    queryKey: ["project-framework", projectId],
    queryFn: () => apiJson<FrameworkInfo>(`/api/projects/${projectId}/framework`),
    enabled: Boolean(projectId),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <header className="border-b border-neutral-200/90 bg-white/95 backdrop-blur-sm">
      <div className="relative flex items-center gap-x-4 px-4 py-2.5">
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
              <Heading as="h2" className="truncate text-base font-semibold tracking-tight text-neutral-900">
                {projectName}
              </Heading>
              {framework && framework.id !== "unknown" && (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white py-1 pl-1 pr-2.5 text-[11px] font-semibold tracking-tight text-neutral-700 shadow-sm ring-1 ring-neutral-200"
                  title={`${framework.label}${framework.optimizes ? " · " + t("toolbar.autoOptimisesImages") : ""}`}
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
          {canPublish && (
            <button
              type="button"
              disabled={publishing}
              onClick={onPublish}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-[13px] font-semibold text-white shadow-sm transition-all",
                publishing
                  ? "cursor-wait opacity-70"
                  : "hover:bg-brand/90 hover:shadow",
              )}
            >
              {publishing ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  {t("toolbar.publishing")}
                </>
              ) : (
                <>
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  {t("toolbar.publish")}
                </>
              )}
            </button>
          )}
          <div className="h-6 w-px bg-neutral-200" />
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
            title={t("settings.open")}
            aria-label={t("settings.open")}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => signOutUnified(me.kind === "client" ? "client" : "github")}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
            title={t("toolbar.signOut")}
            aria-label={t("toolbar.signOut")}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
