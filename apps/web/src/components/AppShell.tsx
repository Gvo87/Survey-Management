import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth';
import { Alert, Button, cx } from './ui';

const ROLE_LABEL = { org_admin: 'Admin', creator: 'Creator', analyst: 'Analyst' } as const;

export function AppShell() {
  const { me, logout, switchOrg } = useAuth();
  const navigate = useNavigate();
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
            <NavLink to="/settings/members" className={link}>
              Members
            </NavLink>
            {org?.role === 'org_admin' ? (
              <NavLink to="/settings/org" className={link}>
                Organization
              </NavLink>
            ) : null}
          </nav>
          <div className="ml-auto flex items-center gap-3">
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
        {org ? (
          <Outlet />
        ) : (
          <Alert tone="info">You're not a member of any organization yet. Ask an admin to invite you.</Alert>
        )}
      </main>
    </div>
  );
}
