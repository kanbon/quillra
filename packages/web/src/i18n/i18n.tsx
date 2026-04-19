/**
 * Tiny in-house i18n. No runtime deps.
 *
 * Usage:
 *   const { t, language, setLanguage } = useT();
 *   t("toolbar.publish")
 *   t("dashboard.updated", { date: "2025-04-08" })
 *
 * Translation keys are dot-paths into the dictionaries (en/de).
 *
 * The active language is loaded from the user's saved preference (via
 * /api/session) on mount, falls back to the browser language, then to "en".
 * Changing it via setLanguage() persists to the server (best-effort) and
 * updates the in-memory language so all subscribed components re-render.
 */
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type Language, dictionaries, en } from "./dictionaries";

const LS_KEY = "quillra:language";

type Vars = Record<string, string | number>;

type I18nContextValue = {
  language: Language;
  setLanguage: (lang: Language) => Promise<void>;
  t: (key: string, vars?: Vars) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function getNestedString(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const v = vars[name];
    return v === undefined || v === null ? `{${name}}` : String(v);
  });
}

function detectInitialLanguage(): Language {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(LS_KEY);
  if (stored === "en" || stored === "de") return stored;
  const nav = navigator.language?.toLowerCase() ?? "en";
  if (nav.startsWith("de")) return "de";
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => detectInitialLanguage());

  // Load the user's saved preference once after mount (overrides local detection)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/session", { credentials: "include" });
        if (!r.ok) return;
        const data = (await r.json()) as { user?: { language?: string | null } | null };
        const lang = data.user?.language;
        if (!cancelled && (lang === "en" || lang === "de")) {
          setLanguageState(lang);
          try {
            window.localStorage.setItem(LS_KEY, lang);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLanguage = useCallback(async (lang: Language) => {
    setLanguageState(lang);
    try {
      window.localStorage.setItem(LS_KEY, lang);
    } catch {
      /* ignore */
    }
    // Persist on the server (best-effort — UI already updated)
    try {
      await fetch("/api/session/language", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: lang }),
      });
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Vars): string => {
      const path = key.split(".");
      const dict = dictionaries[language] ?? en;
      const found = getNestedString(dict, path) ?? getNestedString(en, path);
      if (found === undefined) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn(`[i18n] Missing key: ${key}`);
        }
        return key;
      }
      return interpolate(found, vars);
    },
    [language],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within <I18nProvider>");
  return ctx;
}
