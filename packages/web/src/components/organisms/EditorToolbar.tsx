import { NavLink, Link } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { LogoMark } from "@/components/atoms/LogoMark";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";

type Props = {
  projectId: string;
  projectName: string;
  canPublish: boolean;
  publishing: boolean;
  onPublish: () => void;
};

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-lg px-3.5 py-2 text-[13px] font-medium no-underline transition-colors",
    isActive
      ? "bg-neutral-900 text-white shadow-sm"
      : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
  );

export function EditorToolbar({
  projectId,
  projectName,
  canPublish,
  publishing,
  onPublish,
}: Props) {
  return (
    <header className="border-b border-neutral-200/90 bg-white/95 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Link
            to="/dashboard"
            className="flex shrink-0 items-center gap-2 rounded-lg no-underline hover:bg-neutral-50"
            title="All sites"
          >
            <LogoMark size={22} />
          </Link>
          <div className="hidden h-8 w-px bg-neutral-200 sm:block" />
          <div className="min-w-0 flex-1">
            <Link
              to="/dashboard"
              className="mb-0.5 block text-[11px] font-medium uppercase tracking-wider text-neutral-400 no-underline hover:text-brand"
            >
              All sites
            </Link>
            <Heading as="h2" className="truncate text-base font-semibold tracking-tight text-neutral-900">
              {projectName}
            </Heading>
          </div>
        </div>

        <nav
          className="flex w-full items-center gap-1 rounded-xl bg-neutral-100/90 p-1 sm:w-auto"
          aria-label="Project"
        >
          <NavLink to={`/p/${projectId}`} end className={tabClass}>
            Editor
          </NavLink>
          <NavLink to={`/p/${projectId}/settings`} className={tabClass}>
            Project
          </NavLink>
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canPublish && (
            <Button
              type="button"
              className="shrink-0 rounded-lg bg-brand text-white hover:bg-brand/90"
              disabled={publishing}
              onClick={onPublish}
            >
              {publishing ? "Publishing…" : "Publish"}
            </Button>
          )}
          <Button
            variant="ghost"
            type="button"
            className="shrink-0 rounded-lg text-xs text-neutral-500"
            onClick={() => authClient.signOut({ fetchOptions: { credentials: "include" } })}
          >
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
