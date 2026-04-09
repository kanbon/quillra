import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { LogoMark } from "@/components/atoms/LogoMark";
import { SettingsModal } from "@/components/organisms/SettingsModal";
import { authClient } from "@/lib/auth-client";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";

/**
 * Global header used on dashboard + instance-settings routes. Inside a
 * specific project we render {@link ProjectHeader} instead — it owns the
 * Editor/Project tab pair with absolute-centered positioning so switching
 * routes doesn't shift the tabs.
 */
export function AppHeader() {
  const { t } = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isOwner, setIsOwner] = useState(false);

  // One-time session fetch to decide whether to show the Organization
  // shortcut. Same pattern as SettingsModal — no persistent subscription.
  useEffect(() => {
    (async () => {
      try {
        const me = await apiJson<{ user: { instanceRole?: string | null } | null }>("/api/session");
        setIsOwner(me.user?.instanceRole === "owner");
      } catch {
        setIsOwner(false);
      }
    })();
  }, []);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200/90 bg-white px-4">
      <Link to="/dashboard" className="flex items-center gap-2 no-underline hover:opacity-90">
        <LogoMark size={22} />
        <span className="font-brand text-lg font-bold text-neutral-900">{t("login.appName")}</span>
      </Link>
      <div className="flex items-center gap-1">
        {isOwner && (
          <Link
            to="/admin"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 text-[12px] font-semibold text-neutral-700 no-underline shadow-sm transition-colors hover:bg-neutral-50"
            title={t("instanceSettings.headerButtonTooltip")}
          >
            <svg className="h-4 w-4 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            {t("instanceSettings.headerButton")}
          </Link>
        )}
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
