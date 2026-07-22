import { Button } from "@/components/atoms/Button";
import { LogoMark } from "@/components/atoms/LogoMark";
import { Spinner } from "@/components/atoms/Spinner";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useT } from "@/i18n/i18n";
import type { ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";

/**
 * Gate for every protected route in the app. Three session types are
 * valid, and historically this component only knew about two of them
 * which produced an infinite redirect loop for the third:
 *
 *  1. Better Auth session, the GitHub OAuth owner flow.
 *  2. Team session, email-code login for admins / editors / owners
 *     who don't use GitHub. Lives in its own cookie, validated by the
 *     server middleware, surfaces through GET /api/session.
 *  3. Client session, branded email-code login scoped to one project.
 *
 * GET /api/session identifies all three kinds and includes the client
 * project scope, so the gate has one source of truth and one request.
 */

export function RequireAuth({ children }: { children: ReactNode }) {
  const params = useParams<{ projectId?: string }>();
  const me = useCurrentUser();

  if (me.kind === "loading") {
    return <AuthLoading />;
  }

  if (me.kind === "error") {
    return <AuthError retrying={me.retrying} onRetry={me.retry} />;
  }

  if (me.kind === "none") {
    return <Navigate to="/login" replace />;
  }

  // Client on the wrong project's URL, bounce them back to their own.
  if (me.kind === "client" && params.projectId && params.projectId !== me.projectId) {
    return <Navigate to={`/p/${me.projectId}`} replace />;
  }

  return <>{children}</>;
}

function AuthError({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const { t } = useT();
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-5 py-10">
      <section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 text-center shadow-sm sm:p-10">
        <LogoMark className="mx-auto mb-6 size-11" />
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-neutral-950">
          {t("auth.sessionErrorTitle")}
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-pretty text-sm leading-6 text-neutral-600">
          {t("auth.sessionErrorDescription")}
        </p>
        <Button className="mt-7 min-w-36 gap-2" disabled={retrying} onClick={onRetry}>
          {retrying ? <Spinner className="size-4" /> : null}
          {retrying ? t("auth.retrying") : t("common.tryAgain")}
        </Button>
      </section>
    </main>
  );
}

function AuthLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      <Spinner className="size-6" />
    </div>
  );
}
