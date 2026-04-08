import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Heading } from "@/components/atoms/Heading";
import { AppHeader } from "@/components/organisms/AppHeader";
import { ConnectProjectModal } from "@/components/organisms/ConnectProjectModal";
import { ProjectCard } from "@/components/organisms/ProjectCard";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type ProjectRow = {
  id: string;
  name: string;
  githubRepoFullName: string;
  role: string;
  updatedAt: number;
};

function ProjectCardSkeleton({ index }: { index: number }) {
  return (
    <div
      className="flex flex-col rounded-2xl border border-neutral-200/80 bg-white p-5"
      style={{ animation: `pulse 1.6s ease-in-out ${index * 0.08}s infinite` }}
    >
      <div className="mb-3 h-5 w-2/3 rounded bg-neutral-200" />
      <div className="h-3 w-1/2 rounded bg-neutral-100" />
      <div className="mt-6 flex items-center justify-between">
        <div className="h-3 w-12 rounded bg-neutral-100" />
        <div className="h-3 w-20 rounded bg-neutral-100" />
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { t } = useT();
  const [search, setSearch] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiJson<{ projects: ProjectRow[] }>("/api/projects"),
  });

  const projects = data?.projects ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.githubRepoFullName.toLowerCase().includes(q),
    );
  }, [projects, search]);

  const empty = !isLoading && projects.length === 0;

  return (
    <div className="min-h-screen bg-neutral-50">
      <AppHeader />

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {/* Page heading */}
        <div className="mb-6 flex flex-col gap-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-brand">
            {t("dashboard.selfHosted")}
          </p>
          <Heading as="h1" className="text-[28px] font-semibold tracking-tight text-neutral-900">
            {t("dashboard.sitesHeading")}
          </Heading>
          <p className="text-sm text-neutral-500">{t("dashboard.sitesSubheading")}</p>
        </div>

        {/* Toolbar: search + new */}
        {!empty && (
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative max-w-sm flex-1">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sites…"
                className="block h-10 w-full rounded-xl border border-neutral-200 bg-white pl-10 pr-3 text-sm shadow-sm transition-colors placeholder:text-neutral-400 focus:border-neutral-300 focus:outline-none focus:ring-0"
              />
            </div>
            <button
              type="button"
              onClick={() => setConnectOpen(true)}
              className="inline-flex h-10 items-center gap-1.5 self-start rounded-xl bg-brand px-4 text-[13px] font-semibold text-white shadow-sm transition-all hover:bg-brand/90 hover:shadow sm:self-auto"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New site
            </button>
          </div>
        )}

        {/* Loading state — skeleton grid */}
        {isLoading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <ProjectCardSkeleton key={i} index={i} />
            ))}
          </div>
        )}

        {/* Empty state */}
        {empty && (
          <div className="mx-auto mt-4 max-w-xl rounded-3xl border border-neutral-200/80 bg-white p-10 text-center shadow-sm">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10 text-brand">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <Heading as="h2" className="mb-2 text-xl font-semibold tracking-tight">
              {t("dashboard.connectFirst")}
            </Heading>
            <p className="mb-7 text-sm leading-relaxed text-neutral-500">
              {t("dashboard.connectFirstDescription")}
            </p>
            <button
              type="button"
              onClick={() => setConnectOpen(true)}
              className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-brand px-6 text-[14px] font-semibold text-white shadow-sm transition-all hover:bg-brand/90 hover:shadow"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              {t("connectForm.connect")}
            </button>
          </div>
        )}

        {/* Projects grid */}
        {!isLoading && !empty && (
          <>
            {filtered.length === 0 ? (
              <div className="mt-2 rounded-2xl border border-dashed border-neutral-200 bg-white px-6 py-10 text-center text-sm text-neutral-400">
                No sites match "<span className="font-medium text-neutral-600">{search}</span>"
              </div>
            ) : (
              <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3")}>
                {filtered.map((p) => (
                  <ProjectCard
                    key={p.id}
                    id={p.id}
                    name={p.name}
                    repo={p.githubRepoFullName}
                    role={p.role}
                    updatedAt={p.updatedAt}
                  />
                ))}
              </div>
            )}
          </>
        )}

        <p className="mt-12 text-center">
          <Link to="/accept-invite" className="text-sm text-neutral-500 underline-offset-4 hover:text-neutral-800 hover:underline">
            {t("dashboard.haveInvite")}
          </Link>
        </p>
      </main>

      <ConnectProjectModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onCreated={() => {
          void refetch();
        }}
      />
    </div>
  );
}
