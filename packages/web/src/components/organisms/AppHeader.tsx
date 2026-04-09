import { useState } from "react";
import { Link } from "react-router-dom";
import { LogoMark } from "@/components/atoms/LogoMark";
import { SettingsModal } from "@/components/organisms/SettingsModal";
import { useT } from "@/i18n/i18n";

/**
 * Global header used on dashboard + instance-settings routes. Inside a
 * specific project we render {@link ProjectHeader} instead.
 *
 * Single settings entry point: one gear icon on the right that opens the
 * SettingsModal. The modal contains the user info card, language
 * selector, (owner-only) Organization settings shortcut, and sign-out.
 * Everything that used to live inline in the header — separate
 * Organisation pill, standalone "Abmelden" button — has been moved
 * inside the modal to stop cluttering the bar with duplicated entry
 * points.
 */
export function AppHeader() {
  const { t } = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200/90 bg-white px-4">
      <Link to="/dashboard" className="flex items-center gap-2 no-underline hover:opacity-90">
        <LogoMark size={22} />
        <span className="font-brand text-lg font-bold text-neutral-900">{t("login.appName")}</span>
      </Link>
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
        title={t("settings.open")}
        aria-label={t("settings.open")}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
