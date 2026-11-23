import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, Outlet, RouterProvider, createBrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api';
import { AuthProvider, RequireAuth } from './auth';
import { AppShell } from './components/AppShell';
import {
  AcceptInvitePage,
  ForgotPasswordPage,
  LoginPage,
  ResetPasswordPage,
  SignupPage,
  VerifyEmailPage,
} from './pages/auth';
import { MembersPage, OrgSettingsPage } from './pages/settings';
import { SurveyListPage } from './pages/SurveyList';
import { BuilderPage } from './pages/survey/builder/Builder';
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
              { path: 'settings', element: <SurveySettingsPage /> },
            ],
          },
          { path: '/settings/members', element: <MembersPage /> },
          { path: '/settings/org', element: <OrgSettingsPage /> },
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
