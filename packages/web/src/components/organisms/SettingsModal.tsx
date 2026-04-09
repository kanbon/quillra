/**
 * User menu modal — the sole settings entry point in the dashboard
 * header. Collapses everything that used to live in the header (gear
 * icon, Organisation pill, standalone "Abmelden" button) into one card:
 *
 *   1. User info card (avatar, name, email, role pill)
 *   2. Language selector
 *   3. Organization settings shortcut (owner-only)
 *   4. Sign out
 *
 * There is intentionally no "Personal settings" tab — language is the
 * only per-user preference today, so a tab would feel overbuilt.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "@/components/atoms/Modal";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { signOutUnified, useCurrentUser } from "@/hooks/useCurrentUser";
import type { Language } from "@/i18n/dictionaries";

type Props = {
  open: boolean;
  onClose: () => void;
};

const LANGUAGE_OPTIONS: { code: Language; flag: string; nativeName: string }[] = [
  { code: "en", flag: "🇬🇧", nativeName: "English" },
  { code: "de", flag: "🇩🇪", nativeName: "Deutsch" },
];

type SessionInfo = {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  instanceRole?: string | null;
};

export function SettingsModal({ open, onClose }: Props) {
  const { t, language, setLanguage } = useT();
  const nav = useNavigate();
  const me = useCurrentUser();
  const [info, setInfo] = useState<SessionInfo | null>(null);

  // Always refetch /api/session when the modal opens so we have the
  // freshest instanceRole + name/image — authClient's cached user may
  // be stale for team-session accounts that didn't go through Better Auth.
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const r = await apiJson<{ user: SessionInfo | null }>("/api/session");
        setInfo(r.user);
      } catch {
        setInfo(null);
      }
    })();
  }, [open]);

  const isOwner = info?.instanceRole === "owner";
  const name = info?.name ?? (me.kind === "github" ? me.user.name : me.kind === "team" ? me.user.name : null) ?? null;
  const email = info?.email ?? (me.kind === "github" ? me.user.email : me.kind === "team" ? me.user.email : null) ?? null;
  const image = info?.image ?? (me.kind === "github" ? me.user.image : me.kind === "team" ? me.user.image : null) ?? null;
  const monogram =
    (name?.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("") ||
      email?.[0] ||
      "?").toUpperCase();

  const kindLabel =
    me.kind === "github"
      ? t("settings.accountGithub")
      : me.kind === "team"
        ? t("settings.accountEmail")
        : null;

  return (
    <Modal open={open} onClose={onClose} className="max-w-md">
      <div className="mb-4 flex items-start justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">{t("settings.title")}</h2>
        <button
          type="button"
          onClick={onClose}
          className="-mr-2 -mt-1 flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          aria-label={t("common.close")}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* User info card */}
      <div className="mb-5 flex items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50/60 p-3">
        {image ? (
          <img src={image} alt="" className="h-11 w-11 shrink-0 rounded-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-neutral-200 to-neutral-300 text-sm font-semibold text-neutral-700">
            {monogram}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-neutral-900">{name || email || "…"}</p>
          {email && name && <p className="truncate text-[12px] text-neutral-500">{email}</p>}
          <div className="mt-1 flex items-center gap-1.5">
            {isOwner && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                {t("instanceSettings.instanceOwnerBadge")}
              </span>
            )}
            {kindLabel && (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600">
                {kindLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Language */}
      <section className="mb-5">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          {t("language.title")}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {LANGUAGE_OPTIONS.map((opt) => {
            const active = language === opt.code;
            return (
              <button
                key={opt.code}
                type="button"
                onClick={() => void setLanguage(opt.code)}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition-all",
                  active
                    ? "border-brand bg-brand/5 shadow-sm"
                    : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50",
                )}
              >
                <span className="text-xl leading-none">{opt.flag}</span>
                <span className={cn("flex-1 text-sm font-medium", active ? "text-brand" : "text-neutral-900")}>
                  {opt.nativeName}
                </span>
                {active && (
                  <svg className="h-4 w-4 shrink-0 text-brand" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Owner-only: shortcut to /admin */}
      {isOwner && (
        <section className="mb-5">
          <button
            type="button"
            onClick={() => {
              onClose();
              nav("/admin");
            }}
            className="group flex w-full items-center gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-3 text-left transition-colors hover:border-neutral-300 hover:bg-neutral-50"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-white">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-neutral-900">{t("instanceSettings.pageTitle")}</p>
              <p className="truncate text-[11px] text-neutral-500">
                {t("instanceSettings.modalShortcutSubtitle")}
              </p>
            </div>
            <svg className="h-4 w-4 text-neutral-400 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </section>
      )}

      {/* Sign out */}
      <button
        type="button"
        onClick={() =>
          signOutUnified(
            me.kind === "client" ? "client" : me.kind === "team" ? "team" : "github",
          )
        }
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-[13px] font-medium text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
      >
        <svg className="h-4 w-4 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        </svg>
        {t("toolbar.signOut")}
      </button>
    </Modal>
  );
}
