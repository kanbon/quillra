import { useState } from "react";
import { NavLink, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Heading } from "@/components/atoms/Heading";
import { LogoMark } from "@/components/atoms/LogoMark";
import { SettingsModal } from "@/components/organisms/SettingsModal";
import { authClient } from "@/lib/auth-client";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type FrameworkInfo = { id: string; label: string; assetsDir: string; optimizes: boolean };

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
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data: framework } = useQuery({
    queryKey: ["project-framework", projectId],
    queryFn: () => apiJson<FrameworkInfo>(`/api/projects/${projectId}/framework`),
    enabled: Boolean(projectId),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <header className="border-b border-neutral-200/90 bg-white/95 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Link
            to="/dashboard"
            className="flex shrink-0 items-center gap-2 rounded-lg no-underline hover:bg-neutral-50"
            title={t("toolbar.allSites")}
          >
            <LogoMark size={22} />
          </Link>
          <div className="hidden h-8 w-px bg-neutral-200 sm:block" />
          <div className="min-w-0 flex-1">
            <Link
              to="/dashboard"
              className="mb-0.5 block text-[11px] font-medium uppercase tracking-wider text-neutral-400 no-underline hover:text-brand"
            >
              {t("toolbar.allSites")}
            </Link>
            <div className="flex items-center gap-2">
              <Heading as="h2" className="truncate text-base font-semibold tracking-tight text-neutral-900">
                {projectName}
              </Heading>
              {framework && framework.id !== "unknown" && (
                <span
                  className="shrink-0 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600"
                  title={`${framework.label}${framework.optimizes ? " · " + t("toolbar.autoOptimisesImages") : ""}`}
                >
                  {framework.label}
                </span>
              )}
            </div>
          </div>
        </div>

        <nav
          className="flex w-full items-center gap-1 rounded-xl bg-neutral-100/90 p-1 sm:w-auto"
          aria-label={t("toolbar.project")}
        >
          <NavLink to={`/p/${projectId}`} end className={tabClass}>
            {t("toolbar.editor")}
          </NavLink>
          <NavLink to={`/p/${projectId}/settings`} className={tabClass}>
            {t("toolbar.project")}
          </NavLink>
        </nav>

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
            onClick={() => authClient.signOut({ fetchOptions: { credentials: "include" } })}
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
