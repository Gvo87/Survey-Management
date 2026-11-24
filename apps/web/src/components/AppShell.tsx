import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { NotificationInbox } from '@survey/contracts';
import { get } from '../api';
import { useAuth } from '../auth';
import { Alert, Button, cx } from './ui';

const ROLE_LABEL = { org_admin: 'Admin', creator: 'Creator', analyst: 'Analyst' } as const;

/** Bell with the unread count (Phase 3A). Polls every 30 seconds. */
function NotificationBell({ orgId }: { orgId: string }) {
  const inbox = useQuery({
    queryKey: ['notifications', 'count', orgId],
    queryFn: () => get<NotificationInbox>('/notifications?limit=1'),
    refetchInterval: 30_000,
  });
  const unread = inbox.data?.unread ?? 0;
  return (
    <NavLink
      to="/notifications"
      className="relative rounded-md p-2 text-muted hover:bg-gray-100 hover:text-ink"
      aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M10 3a4.5 4.5 0 0 0-4.5 4.5c0 3.5-1.5 5-1.5 5h12s-1.5-1.5-1.5-5A4.5 4.5 0 0 0 10 3Z" />
        <path d="M8.5 15.5a1.5 1.5 0 0 0 3 0" />
      </svg>
      {unread ? (
        <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-700 px-1 text-center text-[10px] font-semibold leading-4 text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </NavLink>
  );
}

export function AppShell() {
  const { me, logout, switchOrg } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  if (!me) return null;
  const org = me.activeOrg;
  const link = ({ isActive }: { isActive: boolean }) =>
    cx(
      'rounded-md px-3 py-2 text-sm font-medium',
      isActive ? 'bg-brand-50 text-brand-700' : 'text-muted hover:text-ink',
    );

  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2"
      >
        Skip to content
      </a>
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <NavLink to="/surveys" className="flex items-center gap-2 font-semibold text-ink">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm text-white"
              aria-hidden="true"
            >
              S
            </span>
            Survey Management
          </NavLink>
          <nav aria-label="Main" className="ml-4 flex gap-1">
            <NavLink to="/surveys" className={link}>
              Surveys
            </NavLink>
            {org && org.role !== 'analyst' ? (
              <NavLink to="/contacts" className={link}>
                Contacts
              </NavLink>
            ) : null}
            {org ? (
              <NavLink to="/approvals" className={link}>
                Approvals
              </NavLink>
            ) : null}
            <NavLink to="/settings" className={link}>
              Settings
            </NavLink>
            {me.user.isSuperAdmin ? (
              <NavLink to="/admin" className={link}>
                Platform
              </NavLink>
            ) : null}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {org ? <NotificationBell orgId={org.id} /> : null}
            {me.memberships.length > 1 ? (
              <label className="flex items-center gap-2 text-sm">
                <span className="sr-only">Organization</span>
                <select
                  className="rounded-md border border-line bg-white px-2 py-1.5 text-sm"
                  value={org?.id ?? ''}
                  onChange={async (e) => {
                    await switchOrg(e.target.value);
                    navigate('/surveys');
                  }}
                >
                  {me.memberships.map((m) => (
                    <option key={m.orgId} value={m.orgId}>
                      {m.orgName}
                    </option>
                  ))}
                </select>
              </label>
            ) : org ? (
              <span className="text-sm font-medium">{org.name}</span>
            ) : null}
            <span className="hidden text-sm text-muted sm:inline">
              {me.user.name}
              {org ? ` · ${ROLE_LABEL[org.role]}` : ''}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void logout().then(() => navigate('/login'))}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      {!me.user.emailVerified ? (
        <div className="mx-auto w-full max-w-7xl px-4 pt-4">
          <Alert tone="warning">Confirm your email address: we sent a link to {me.user.email}.</Alert>
        </div>
      ) : null}
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {org || (me.user.isSuperAdmin && location.pathname === '/admin') ? (
          <Outlet />
        ) : (
          <Alert tone="info">You're not a member of any organization yet. Ask an admin to invite you.</Alert>
        )}
      </main>
    </div>
  );
}

/** Settings pages share a side navigation (Phase 3A). Admin-only pages are hidden from others. */
export function SettingsLayout() {
  const { me } = useAuth();
  const isAdmin = me?.activeOrg?.role === 'org_admin';
  const link = ({ isActive }: { isActive: boolean }) =>
    cx(
      'block rounded-md px-3 py-1.5 text-sm',
      isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-muted hover:bg-gray-100 hover:text-ink',
    );
  const section = 'mb-1 mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-muted first:mt-0';
  return (
    <div className="grid gap-6 md:grid-cols-[200px_1fr]">
      <nav aria-label="Settings">
        <p className={section}>You</p>
        <NavLink to="/settings/notifications" className={link}>
          Notifications
        </NavLink>
        <p className={section}>Organization</p>
        <NavLink to="/settings/members" className={link}>
          Members
        </NavLink>
        <NavLink to="/settings/teams" className={link}>
          Teams
        </NavLink>
        {isAdmin ? (
          <>
            <NavLink to="/settings/org" className={link}>
              General and approvals
            </NavLink>
            <NavLink to="/settings/themes" className={link}>
              Themes
            </NavLink>
            <NavLink to="/settings/api" className={link}>
              API and webhooks
            </NavLink>
            <NavLink to="/settings/integrations" className={link}>
              Integrations
            </NavLink>
            <NavLink to="/settings/audit" className={link}>
              Audit log
            </NavLink>
            <NavLink to="/settings/sso" className={link}>
              Single sign-on
            </NavLink>
            <NavLink to="/settings/usage" className={link}>
              Usage
            </NavLink>
            <NavLink to="/settings/privacy" className={link}>
              Privacy requests
            </NavLink>
          </>
        ) : null}
      </nav>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
