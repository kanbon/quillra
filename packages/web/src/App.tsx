import { Spinner } from "@/components/atoms/Spinner";
import { RequireAuth } from "@/components/templates/RequireAuth";
import { SetupGate } from "@/components/templates/SetupGate";
import { I18nProvider } from "@/i18n/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

const AcceptInvitePage = lazy(() =>
  import("@/pages/AcceptInvite").then((module) => ({ default: module.AcceptInvitePage })),
);
const ClientLoginPage = lazy(() =>
  import("@/pages/ClientLogin").then((module) => ({ default: module.ClientLoginPage })),
);
const DashboardPage = lazy(() =>
  import("@/pages/Dashboard").then((module) => ({ default: module.DashboardPage })),
);
const EditorPage = lazy(() =>
  import("@/pages/Editor").then((module) => ({ default: module.EditorPage })),
);
const ImpressumPage = lazy(() =>
  import("@/pages/Impressum").then((module) => ({ default: module.ImpressumPage })),
);
const InstanceSettingsPage = lazy(() =>
  import("@/pages/InstanceSettings").then((module) => ({ default: module.InstanceSettingsPage })),
);
const LoginPage = lazy(() =>
  import("@/pages/Login").then((module) => ({ default: module.LoginPage })),
);
const ProjectSettingsPage = lazy(() =>
  import("@/pages/ProjectSettings").then((module) => ({ default: module.ProjectSettingsPage })),
);
const SetupPage = lazy(() =>
  import("@/pages/Setup").then((module) => ({ default: module.SetupPage })),
);

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <BrowserRouter>
          <SetupGate>
            <Suspense
              fallback={
                <div className="flex min-h-screen items-center justify-center bg-white">
                  <Spinner className="size-6" />
                </div>
              }
            >
              <Routes>
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/impressum" element={<ImpressumPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/accept-invite" element={<AcceptInvitePage />} />
                <Route path="/c/:projectId" element={<ClientLoginPage />} />
                <Route
                  path="/dashboard"
                  element={
                    <RequireAuth>
                      <DashboardPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/p/:projectId"
                  element={
                    <RequireAuth>
                      <EditorPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/p/:projectId/settings"
                  element={
                    <RequireAuth>
                      <ProjectSettingsPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <RequireAuth>
                      <InstanceSettingsPage />
                    </RequireAuth>
                  }
                />
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </Suspense>
          </SetupGate>
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}
