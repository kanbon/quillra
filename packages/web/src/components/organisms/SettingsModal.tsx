import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "@/components/atoms/Modal";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Language } from "@/i18n/dictionaries";

type Props = {
  open: boolean;
  onClose: () => void;
};

const LANGUAGE_OPTIONS: { code: Language; flag: string; nativeName: string }[] = [
  { code: "en", flag: "🇬🇧", nativeName: "English" },
  { code: "de", flag: "🇩🇪", nativeName: "Deutsch" },
];

/**
 * User-scope settings (language, links to instance-wide admin screens).
 * The gear icon on the dashboard opens this — it has nothing to do with
 * project-level settings.
 */
export function SettingsModal({ open, onClose }: Props) {
  const { t, language, setLanguage } = useT();
  const nav = useNavigate();
  const [isOwner, setIsOwner] = useState(false);

  // Check the current user's instanceRole so we can show the
  // 'Instance settings' shortcut only to owners.
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const me = await apiJson<{ user: { instanceRole?: string | null } | null }>("/api/session");
        setIsOwner(me.user?.instanceRole === "owner");
      } catch {
        setIsOwner(false);
      }
    })();
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} className="max-w-lg">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-neutral-900">{t("settings.title")}</h2>
        </div>
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

      <section>
        <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-neutral-500">
          {t("language.title")}
        </h3>
        <p className="mb-4 text-sm text-neutral-500">{t("language.description")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {LANGUAGE_OPTIONS.map((opt) => {
            const active = language === opt.code;
            return (
              <button
                key={opt.code}
                type="button"
                onClick={() => void setLanguage(opt.code)}
                className={cn(
                  "group flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all",
                  active
                    ? "border-brand bg-brand/5 shadow-sm"
                    : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50",
                )}
              >
                <span className="text-2xl leading-none">{opt.flag}</span>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-medium", active ? "text-brand" : "text-neutral-900")}>
                    {opt.nativeName}
                  </p>
                  <p className="text-[11px] uppercase tracking-wide text-neutral-400">{opt.code}</p>
                </div>
                {active && (
                  <svg className="h-5 w-5 shrink-0 text-brand" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Owner-only shortcut into /admin */}
      {isOwner && (
        <section className="mt-6 border-t border-neutral-100 pt-6">
          <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-neutral-500">
            {t("instanceSettings.pageTitle")}
          </h3>
          <p className="mb-3 text-sm text-neutral-500">
            {t("instanceSettings.modalShortcutSubtitle")}
          </p>
          <button
            type="button"
            onClick={() => {
              onClose();
              nav("/admin");
            }}
            className="group flex w-full items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-left transition-colors hover:border-neutral-300 hover:bg-neutral-50"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-900 text-white">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-neutral-900">
                  {t("instanceSettings.modalShortcutTitle")}
                </p>
                <p className="text-[11px] text-neutral-500">
                  {t("instanceSettings.modalShortcutHint")}
                </p>
              </div>
            </div>
            <svg className="h-4 w-4 text-neutral-400 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </section>
      )}
    </Modal>
  );
}
