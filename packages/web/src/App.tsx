import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { I18nProvider } from "@/i18n/i18n";
import { RequireAuth } from "@/components/templates/RequireAuth";
import { AcceptInvitePage } from "@/pages/AcceptInvite";
import { ClientLoginPage } from "@/pages/ClientLogin";
import { DashboardPage } from "@/pages/Dashboard";
import { EditorPage } from "@/pages/Editor";
import { LoginPage } from "@/pages/Login";
import { InstanceSettingsPage } from "@/pages/InstanceSettings";
import { ProjectSettingsPage } from "@/pages/ProjectSettings";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider>
      <BrowserRouter>
        <Routes>
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
      </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}
