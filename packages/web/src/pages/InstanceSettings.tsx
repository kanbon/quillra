/**
 * Tabbed Organization Settings page — the owner-only post-install home
 * for everything the setup wizard touched. The wizard itself (Setup.tsx)
 * is unchanged; this page exposes the same knobs for ongoing rotation.
 *
 * Auth: this page is client-guarded by calling /api/session on mount and
 * rendering a dedicated "Owner access only" empty state for non-owners.
 * The actual security guarantee lives on the server — /api/setup/save is
 * already owner-gated, so even if the client-side guard were bypassed a
 * non-owner could not mutate anything.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Heading } from "@/components/atoms/Heading";
import { LogoMark } from "@/components/atoms/LogoMark";
import { Tabs, type TabItem } from "@/components/molecules/Tabs";
import { ApiKeysTab } from "@/components/organisms/instance-settings/ApiKeysTab";
import { EmailTab } from "@/components/organisms/instance-settings/EmailTab";
import { GeneralTab } from "@/components/organisms/instance-settings/GeneralTab";
import { IntegrationsTab } from "@/components/organisms/instance-settings/IntegrationsTab";
import { TeamTab } from "@/components/organisms/instance-settings/TeamTab";
import type { StatusResponse } from "@/components/organisms/instance-settings/types";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";

type TabId = "general" | "apiKeys" | "email" | "integrations" | "team";

type Session = { user: { instanceRole?: string | null } | null };

export function InstanceSettingsPage() {
  const { t } = useT();
  const nav = useNavigate();
  const [sessionChecked, setSessionChecked] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [active, setActive] = useState<TabId>("general");

  async function refetchStatus() {
    try {
      const s = await apiJson<StatusResponse>("/api/setup/status");
      setStatus(s);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    (async () => {
      try {
        const me = await apiJson<Session>("/api/session");
        const owner = me.user?.instanceRole === "owner";
        setIsOwner(owner);
        if (owner) await refetchStatus();
      } catch {
        setIsOwner(false);
      } finally {
        setSessionChecked(true);
      }
    })();
  }, []);

  const tabs: TabItem[] = [
    {
      id: "general",
      label: t("instanceSettings.tabGeneral"),
      description: t("instanceSettings.generalDescription"),
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
      ),
    },
    {
      id: "apiKeys",
      label: t("instanceSettings.tabApiKeys"),
      description: t("instanceSettings.apiKeysDescription"),
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
        </svg>
      ),
    },
    {
      id: "email",
      label: t("instanceSettings.tabEmail"),
      description: t("instanceSettings.emailDescription"),
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      id: "integrations",
      label: t("instanceSettings.tabIntegrations"),
      description: t("instanceSettings.integrationsDescription"),
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
    },
    {
      id: "team",
      label: t("instanceSettings.tabTeam"),
      description: t("instanceSettings.teamDescription"),
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="flex h-14 shrink-0 items-center border-b border-neutral-200 bg-white px-4">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3">
          <Link to="/dashboard" className="flex items-center gap-2 no-underline">
            <LogoMark size={22} />
          </Link>
          <div className="h-6 w-px bg-neutral-200" />
          <Heading as="h1" className="text-base font-semibold">
            {t("instanceSettings.pageTitle")}
          </Heading>
        </div>
      </header>

      {!sessionChecked ? (
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
        </div>
      ) : !isOwner ? (
        <div className="mx-auto flex min-h-[60vh] max-w-md items-center justify-center px-6">
          <div className="w-full rounded-2xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100 text-neutral-500">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h2 className="mb-2 text-lg font-semibold tracking-tight text-neutral-900">
              {t("instanceSettings.accessDeniedTitle")}
            </h2>
            <p className="mb-6 text-sm text-neutral-500">{t("instanceSettings.accessDeniedBody")}</p>
            <button
              type="button"
              onClick={() => nav("/dashboard")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition-all hover:bg-neutral-800"
            >
              {t("instanceSettings.backToDashboard")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-6xl px-4 py-8 md:grid md:grid-cols-[260px_1fr] md:gap-8">
          <aside className="mb-4 md:mb-0">
            <Tabs
              items={tabs}
              activeId={active}
              onChange={(id) => setActive(id as TabId)}
              ariaLabel={t("instanceSettings.pageTitle")}
            />
          </aside>
          <main className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
            {active === "general" && <GeneralTab status={status} onSaved={refetchStatus} />}
            {active === "apiKeys" && <ApiKeysTab status={status} onSaved={refetchStatus} />}
            {active === "email" && <EmailTab status={status} onSaved={refetchStatus} />}
            {active === "integrations" && <IntegrationsTab status={status} onSaved={refetchStatus} />}
            {active === "team" && <TeamTab />}
          </main>
        </div>
      )}
    </div>
  );
}
