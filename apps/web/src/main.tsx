import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, Outlet, RouterProvider, createBrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api';
import { AuthProvider, RequireAuth } from './auth';
import { AppShell, SettingsLayout } from './components/AppShell';
import {
  AcceptInvitePage,
  ForgotPasswordPage,
  LoginPage,
  ResetPasswordPage,
  SignupPage,
  VerifyEmailPage,
} from './pages/auth';
import { MembersPage, OrgSettingsPage } from './pages/settings';
import { ThemesPage } from './pages/themes';
import { ContactsPage } from './pages/contacts';
import { SurveyListPage } from './pages/SurveyList';
import { ApprovalsPage } from './pages/approvals';
import { AuditLogPage } from './pages/audit';
import { IntegrationsPage } from './pages/integrations';
import { NotificationPreferencesPage, NotificationsPage } from './pages/notifications';
import { ApiPage } from './pages/platform';
import { TeamsPage } from './pages/teams';
import { BuilderPage } from './pages/survey/builder/Builder';
import { CommentsPage } from './pages/survey/Comments';
import { DistributePage } from './pages/survey/Distribute';
import { ResponseDetailPage, ResponsesPage } from './pages/survey/Responses';
import { ResultsPage } from './pages/survey/Results';
import { SurveySettingsPage } from './pages/survey/Settings';
import { SurveyLayout } from './pages/survey/SurveyLayout';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function Root() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/verify-email', element: <VerifyEmailPage /> },
      { path: '/invite/:token', element: <AcceptInvitePage /> },
      {
        element: (
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <Navigate to="/surveys" replace /> },
          { path: '/surveys', element: <SurveyListPage /> },
          {
            path: '/surveys/:id',
            element: <SurveyLayout />,
            children: [
              { index: true, element: <Navigate to="results" replace /> },
              { path: 'edit', element: <BuilderPage /> },
              { path: 'distribute', element: <DistributePage /> },
              { path: 'results', element: <ResultsPage /> },
              { path: 'responses', element: <ResponsesPage /> },
              { path: 'responses/:responseId', element: <ResponseDetailPage /> },
              { path: 'comments', element: <CommentsPage /> },
              { path: 'settings', element: <SurveySettingsPage /> },
            ],
          },
          { path: '/approvals', element: <ApprovalsPage /> },
          { path: '/notifications', element: <NotificationsPage /> },
          {
            path: '/settings',
            element: <SettingsLayout />,
            children: [
              { index: true, element: <Navigate to="/settings/members" replace /> },
              { path: 'members', element: <MembersPage /> },
              { path: 'teams', element: <TeamsPage /> },
              { path: 'org', element: <OrgSettingsPage /> },
              { path: 'themes', element: <ThemesPage /> },
              { path: 'api', element: <ApiPage /> },
              { path: 'integrations', element: <IntegrationsPage /> },
              { path: 'audit', element: <AuditLogPage /> },
              { path: 'notifications', element: <NotificationPreferencesPage /> },
            ],
          },
          { path: '/contacts', element: <ContactsPage /> },
          { path: '*', element: <p className="text-sm text-muted">Page not found.</p> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
