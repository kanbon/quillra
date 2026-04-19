import { signOutUnified, useCurrentUser } from "@/hooks/useCurrentUser";
import type { Language } from "@/i18n/dictionaries";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
/**
 * Vercel-style account menu anchored to the user's avatar in the app
 * header. Replaces the old gear-icon + SettingsModal combo: one click
 * on the avatar drops a menu with everything a signed-in user actually
 * reaches for — language switch, organisation settings shortcut, sign
 * out — without forcing them through a modal dialog.
 *
 * Used by both the dashboard-level AppHeader and the in-editor
 * ProjectHeader so the entry point is in the same place no matter
 * where the user is.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

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

export function AvatarDropdown() {
  const { t, language, setLanguage } = useT();
  const nav = useNavigate();
  const me = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Refetch on open so the instanceRole badge stays fresh for team users
  // that didn't go through Better Auth.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiJson<{ user: SessionInfo | null }>("/api/session");
        if (!cancelled) setInfo(r.user);
      } catch {
        /* ignore — the cached useCurrentUser() data is good enough */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Click-outside + Escape to dismiss. Kept on document so the menu
  // closes even when the user clicks into a portal/modal behind it.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const w = wrapperRef.current;
      if (!w) return;
      if (e.target instanceof Node && !w.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isOwner = info?.instanceRole === "owner";
  const name =
    info?.name ??
    (me.kind === "github" ? me.user.name : me.kind === "team" ? me.user.name : null) ??
    null;
  const email =
    info?.email ??
    (me.kind === "github" ? me.user.email : me.kind === "team" ? me.user.email : null) ??
    null;
  const image =
    info?.image ??
    (me.kind === "github" ? me.user.image : me.kind === "team" ? me.user.image : null) ??
    null;
  const monogram = useMemo(
    () =>
      (
        name
          ?.split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0])
          .join("") ||
        email?.[0] ||
        "?"
      ).toUpperCase(),
    [name, email],
  );

  const kindLabel =
    me.kind === "github"
      ? t("settings.accountGithub")
      : me.kind === "team"
        ? t("settings.accountEmail")
        : null;

  const close = useCallback(() => setOpen(false), []);

  const goToOrgSettings = () => {
    close();
    nav("/admin");
  };

  const signOut = () => {
    close();
    void signOutUnified(me.kind === "client" ? "client" : me.kind === "team" ? "team" : "github");
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 items-center gap-2 rounded-full border pr-3 pl-1 transition-colors",
          open
            ? "border-neutral-300 bg-neutral-100"
            : "border-transparent hover:border-neutral-200 hover:bg-neutral-50",
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("settings.open")}
      >
        {image ? (
          <img
            src={image}
            alt=""
            className="h-7 w-7 shrink-0 rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-neutral-200 to-neutral-300 text-[11px] font-semibold text-neutral-700">
            {monogram}
          </span>
        )}
        <span className="hidden max-w-[140px] truncate text-[13px] font-medium text-neutral-700 sm:inline">
          {name || email || "…"}
        </span>
        <svg
          className={cn(
            "hidden h-3 w-3 shrink-0 text-neutral-400 transition-transform sm:block",
            open && "rotate-180",
          )}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5l3 3 3-3" />
        </svg>
      </button>

      {open && (
        <>
          {/* Mobile backdrop. On small screens we render the menu as a
              bottom-anchored sheet and dim the rest of the page so it
              feels like a first-class surface instead of a dropdown
              accidentally hanging off the header. */}
          <div className="fixed inset-0 z-40 bg-black/20 sm:hidden" onClick={close} aria-hidden />
          <div
            role="menu"
            aria-label={t("settings.title")}
            className={cn(
              "z-50 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl",
              // Mobile: fixed bottom sheet — declared FIRST so the
              // sm:* overrides that follow win at desktop breakpoints.
              "fixed inset-x-3 bottom-3",
              // Desktop: anchor under the avatar, right-aligned. The
              // explicit sm:inset-auto cancels the mobile inset-x-3 /
              // bottom-3 above, otherwise the panel stays fixed to the
              // viewport edges and overflows to the right.
              "sm:absolute sm:inset-auto sm:right-0 sm:top-[calc(100%+6px)]",
              "sm:w-[300px] sm:max-w-[calc(100vw-1rem)]",
              "animate-[fadeIn_0.12s_ease-out]",
            )}
          >
            {/* User card */}
            <div className="flex items-center gap-3 border-b border-neutral-100 bg-neutral-50/60 p-3">
              {image ? (
                <img
                  src={image}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-neutral-200 to-neutral-300 text-[13px] font-semibold text-neutral-700">
                  {monogram}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-neutral-900">
                  {name || email || "…"}
                </p>
                {email && name && <p className="truncate text-[11px] text-neutral-500">{email}</p>}
                <div className="mt-0.5 flex items-center gap-1">
                  {isOwner && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-amber-700">
                      {t("instanceSettings.instanceOwnerBadge")}
                    </span>
                  )}
                  {kindLabel && (
                    <span className="rounded-full bg-neutral-100 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wide text-neutral-600">
                      {kindLabel}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Language — inline toggle, the single most-used personal setting */}
            <div className="border-b border-neutral-100 p-2">
              <p className="mb-1.5 px-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                {t("language.title")}
              </p>
              <div className="grid grid-cols-2 gap-1">
                {LANGUAGE_OPTIONS.map((opt) => {
                  const active = language === opt.code;
                  return (
                    <button
                      key={opt.code}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => void setLanguage(opt.code)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors",
                        active ? "bg-brand/10 text-brand" : "text-neutral-700 hover:bg-neutral-100",
                      )}
                    >
                      <span className="text-sm leading-none">{opt.flag}</span>
                      <span className="flex-1 truncate text-left">{opt.nativeName}</span>
                      {active && (
                        <svg
                          className="h-3 w-3 shrink-0"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2.5}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Action rows */}
            <div className="p-1.5">
              {isOwner && (
                <MenuRow
                  icon={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                      />
                    </svg>
                  }
                  label={t("instanceSettings.pageTitle")}
                  onClick={goToOrgSettings}
                />
              )}
              <MenuRow
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                    />
                  </svg>
                }
                label={t("toolbar.signOut")}
                onClick={signOut}
                tone="danger"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MenuRow({
  icon,
  label,
  onClick,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors",
        tone === "danger"
          ? "text-neutral-700 hover:bg-red-50 hover:text-red-700"
          : "text-neutral-800 hover:bg-neutral-100",
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center",
          tone === "danger" ? "text-neutral-400" : "text-neutral-400",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <svg
        className="h-3.5 w-3.5 shrink-0 text-neutral-300"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}
