import { Link, NavLink } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { LogoMark } from "@/components/atoms/LogoMark";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";

type Props = {
  showNav?: boolean;
  projectId?: string;
};

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-lg px-3 py-1.5 text-[13px] font-medium no-underline transition-colors",
    isActive
      ? "bg-neutral-900 text-white"
      : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
  );

export function AppHeader({ showNav, projectId }: Props) {
  return (
    <header className="flex h-12 items-center justify-between border-b border-neutral-200/90 bg-white px-4">
      <Link to="/dashboard" className="flex items-center gap-2 no-underline hover:opacity-90">
        <LogoMark size={22} />
        <span className="font-brand text-lg font-bold text-neutral-900">Quillra</span>
      </Link>
      {showNav && projectId && (
        <nav className="flex items-center gap-1 rounded-xl bg-neutral-100/90 p-1" aria-label="Project">
          <NavLink to={`/p/${projectId}`} end className={tabClass}>
            Editor
          </NavLink>
          <NavLink to={`/p/${projectId}/settings`} className={tabClass}>
            Project
          </NavLink>
        </nav>
      )}
      <Button
        variant="ghost"
        type="button"
        className="text-xs text-neutral-500"
        onClick={() => authClient.signOut({ fetchOptions: { credentials: "include" } })}
      >
        Sign out
      </Button>
    </header>
  );
}
