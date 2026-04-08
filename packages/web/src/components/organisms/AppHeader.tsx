import { useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { LogoMark } from "@/components/atoms/LogoMark";
import { SettingsModal } from "@/components/organisms/SettingsModal";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Props = {
  showNav?: boolean;
  projectId?: string;
};

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-lg px-3 py-1.5 text-[13px] font-medium no-underline transition-colors",
    isActive
      ? "bg-neutral-900 text-white"
      : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
  );

export function AppHeader({ showNav, projectId }: Props) {
  const { t } = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="flex h-12 items-center justify-between border-b border-neutral-200/90 bg-white px-4">
      <Link to="/dashboard" className="flex items-center gap-2 no-underline hover:opacity-90">
        <LogoMark size={22} />
        <span className="font-brand text-lg font-bold text-neutral-900">{t("login.appName")}</span>
      </Link>
      {showNav && projectId && (
        <nav className="flex items-center gap-1 rounded-xl bg-neutral-100/90 p-1" aria-label={t("toolbar.project")}>
          <NavLink to={`/p/${projectId}`} end className={tabClass}>
            {t("toolbar.editor")}
          </NavLink>
          <NavLink to={`/p/${projectId}/settings`} className={tabClass}>
            {t("toolbar.project")}
          </NavLink>
        </nav>
      )}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          title={t("settings.open")}
          aria-label={t("settings.open")}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <Button
          variant="ghost"
          type="button"
          className="text-xs text-neutral-500"
          onClick={() => authClient.signOut({ fetchOptions: { credentials: "include" } })}
        >
          {t("toolbar.signOut")}
        </Button>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
