import { Link } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { LogoMark } from "@/components/atoms/LogoMark";
import { authClient } from "@/lib/auth-client";

type Props = {
  showNav?: boolean;
  projectId?: string;
};

export function AppHeader({ showNav, projectId }: Props) {
  return (
    <header className="flex h-12 items-center justify-between border-b border-neutral-200 bg-white px-4">
      <Link to="/dashboard" className="flex items-center gap-2 no-underline">
        <LogoMark className="text-lg" />
        <span className="text-sm font-semibold tracking-tight text-neutral-900">Quillra</span>
      </Link>
      {showNav && projectId && (
        <nav className="flex gap-3 text-sm">
          <Link className="text-neutral-600 no-underline hover:text-neutral-900" to={`/p/${projectId}`}>
            Editor
          </Link>
          <Link
            className="text-neutral-600 no-underline hover:text-neutral-900"
            to={`/p/${projectId}/settings`}
          >
            Team
          </Link>
        </nav>
      )}
      <Button
        variant="ghost"
        type="button"
        className="text-xs"
        onClick={() => authClient.signOut({ fetchOptions: { credentials: "include" } })}
      >
        Sign out
      </Button>
    </header>
  );
}
