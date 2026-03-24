import { Link } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { LogoMark } from "@/components/atoms/LogoMark";
import { authClient } from "@/lib/auth-client";

type Props = {
  projectId: string;
  projectName: string;
  canPublish: boolean;
  publishing: boolean;
  onPublish: () => void;
};

export function EditorToolbar({
  projectId,
  projectName,
  canPublish,
  publishing,
  onPublish,
}: Props) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 bg-white px-3 py-2">
      <Link
        to="/dashboard"
        className="text-xs text-neutral-500 no-underline hover:text-neutral-900"
      >
        ← Projects
      </Link>
      <div className="hidden h-4 w-px bg-neutral-200 sm:block" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <LogoMark />
        <Heading as="h2" className="truncate text-base font-semibold">
          {projectName}
        </Heading>
      </div>
      <nav className="flex items-center gap-2 text-xs">
        <Link
          className="rounded-md px-2 py-1 text-neutral-600 no-underline hover:bg-neutral-100"
          to={`/p/${projectId}`}
        >
          Editor
        </Link>
        <Link
          className="rounded-md px-2 py-1 text-neutral-600 no-underline hover:bg-neutral-100"
          to={`/p/${projectId}/settings`}
        >
          Team
        </Link>
      </nav>
      {canPublish && (
        <Button
          type="button"
          className="shrink-0 border border-brand bg-white text-brand hover:bg-red-50"
          variant="outline"
          disabled={publishing}
          onClick={onPublish}
        >
          {publishing ? "Publishing…" : "Publish to GitHub"}
        </Button>
      )}
      <Button
        variant="ghost"
        type="button"
        className="shrink-0 text-xs text-neutral-500"
        onClick={() => authClient.signOut({ fetchOptions: { credentials: "include" } })}
      >
        Sign out
      </Button>
    </header>
  );
}
