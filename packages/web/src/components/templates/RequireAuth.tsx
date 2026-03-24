import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Spinner } from "@/components/atoms/Spinner";
import { authClient } from "@/lib/auth-client";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (!data?.user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
