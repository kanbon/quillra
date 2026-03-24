import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Heading } from "@/components/atoms/Heading";
import { AppHeader } from "@/components/organisms/AppHeader";
import { ConnectProjectForm } from "@/components/organisms/ConnectProjectForm";
import { ProjectCard } from "@/components/organisms/ProjectCard";
import { apiJson } from "@/lib/api";

type ProjectRow = {
  id: string;
  name: string;
  githubRepoFullName: string;
  role: string;
  updatedAt: number;
};

export function DashboardPage() {
  const nav = useNavigate();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiJson<{ projects: ProjectRow[] }>("/api/projects"),
  });

  useEffect(() => {
    const list = data?.projects;
    if (!list || isLoading) return;
    if (list.length === 1) {
      nav(`/p/${list[0].id}`, { replace: true });
    }
  }, [data?.projects, isLoading, nav]);

  if (isLoading || data?.projects.length === 1) {
    return (
      <div className="min-h-screen bg-white">
        <AppHeader />
        <div className="flex justify-center p-12 text-sm text-neutral-500">Loading…</div>
      </div>
    );
  }

  const projects = data?.projects ?? [];
  const empty = projects.length === 0;

  return (
    <div className="min-h-screen bg-neutral-50">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-4 py-10">
        {empty ? (
          <div className="mx-auto max-w-xl rounded-2xl border border-neutral-200/80 bg-white p-8 shadow-sm">
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-brand">Self-hosted</p>
            <Heading as="h1" className="mb-2 text-2xl font-semibold tracking-tight">
              Connect your first site
            </Heading>
            <p className="mb-8 text-sm leading-relaxed text-neutral-600">
              Point Quillra at a GitHub repository you control. After you sign in, the server clones it,
              runs a dev preview when you ask, and can push commits so your existing host (Pages, Vercel,
              Netlify, your VPS) deploys from Git—no multi-tenant SaaS layer required.
            </p>
            <ConnectProjectForm
              onCreated={() => {
                void refetch();
              }}
            />
          </div>
        ) : (
          <>
            <div className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <Heading as="h1" className="text-2xl font-semibold tracking-tight">
                  Sites
                </Heading>
                <p className="text-sm text-neutral-600">Open a project to chat, preview, and publish.</p>
              </div>
            </div>

            <div className="mb-10 grid gap-4 sm:grid-cols-2">
              {projects.map((p) => (
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

            <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
              <Heading as="h2" className="mb-1 text-lg font-semibold">
                Connect another repository
              </Heading>
              <p className="mb-4 text-sm text-neutral-600">
                Same instance—each repo is a separate project with its own team access.
              </p>
              <ConnectProjectForm
                onCreated={() => {
                  void refetch();
                }}
              />
            </div>
          </>
        )}

        <p className="mt-10 text-center">
          <Link to="/accept-invite" className="text-sm text-neutral-600 underline-offset-4 hover:underline">
            Have an invite link?
          </Link>
        </p>
      </main>
    </div>
  );
}
