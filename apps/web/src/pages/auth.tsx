import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import type { InvitationPreview, Me, SsoDiscoverResult } from '@survey/contracts';
import { ApiError, errorMessage, get, post } from '../api';
import { useAuth } from '../auth';
import { Alert, Button, TextField } from '../components/ui';

function AuthLayout({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 font-semibold">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-white"
            aria-hidden="true"
          >
            S
          </span>
          Survey Management
        </div>
        <div className="rounded-xl border border-line bg-white p-6 shadow-sm">
          <h1 className="mb-5 text-xl font-semibold">{title}</h1>
          {children}
        </div>
        {footer ? <p className="mt-4 text-center text-sm text-muted">{footer}</p> : null}
      </div>
    </main>
  );
}

/** Shared form state: submitting flag, top-level error, field errors. */
function useForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.problem?.errors?.length) setFields(e.fieldErrors());
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, fields, run };
}

const safeNext = (next: string | null) =>
  next && next.startsWith('/') && !next.startsWith('//') ? next : '/surveys';

/** Phase 3B: why an SSO sign-in came back to the login page. */
const SSO_ERRORS: Record<string, string> = {
  expired: 'That sign-in took too long or was already used. Try again.',
  domain_not_verified: "Your email address isn't in a domain your organization verified for single sign-on. Ask your admin.",
  email_not_verified: 'Your identity provider says your email address isn’t verified.',
  no_email: "Your identity provider didn't send an email address. Ask your IT team.",
  unknown_connection: 'That single sign-on connection is no longer available.',
  account_disabled: 'This account is disabled.',
  idp_denied: 'Sign-in was cancelled at your identity provider.',
};

/** Start a single sign-on login (a full-page navigation through the API to the identity provider). */
const startSso = (loginUrl: string, next: string) => window.location.assign(`${loginUrl}?returnTo=${encodeURIComponent(next)}`);

export function LoginPage() {
  const { me, setMe } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const form = useForm();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sso, setSso] = useState<SsoDiscoverResult | null>(null);
  const [ssoMode, setSsoMode] = useState(false);
  if (me) return <Navigate to={safeNext(params.get('next'))} replace />;
  const next = safeNext(params.get('next'));
  const ssoError = params.get('sso_error');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void form.run(async () => {
      if (ssoMode) {
        const found = await post<SsoDiscoverResult>('/auth/sso/discover', { email });
        setSso(found);
        if (found.connections.length === 1) startSso(found.connections[0]!.loginUrl, next);
        else if (found.connections.length === 0) throw new Error("Single sign-on isn't set up for that email's domain. Sign in with your password.");
        return;
      }
      try {
        setMe(await post<Me>('/auth/login', { email, password }));
        navigate(next, { replace: true });
      } catch (error) {
        // Enforced SSO: offer the organization's sign-in instead.
        if (error instanceof ApiError && error.code === 'sso_required') {
          setSsoMode(true);
          setSso({ enforced: true, connections: (error.problem?.connections as SsoDiscoverResult['connections']) ?? [] });
        }
        throw error;
      }
    });
  };
  return (
    <AuthLayout
      title="Log in"
      footer={
        <>
          New here?{' '}
          <Link className="font-medium text-brand-600" to="/signup">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {ssoError && !form.error ? <Alert tone="error">{SSO_ERRORS[ssoError] ?? "Single sign-on didn't work. Try again or ask your admin."}</Alert> : null}
        {form.error ? <Alert tone="error">{form.error}</Alert> : null}
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {ssoMode ? null : (
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
        {ssoMode && sso && sso.connections.length > 1 ? (
          <div className="flex flex-col gap-2">
            {sso.connections.map((c) => (
              <Button key={c.id} onClick={() => startSso(c.loginUrl, next)}>
                Continue with {c.name}
              </Button>
            ))}
          </div>
        ) : null}
        <Button type="submit" variant="primary" busy={form.busy}>
          {ssoMode ? 'Continue with single sign-on' : 'Log in'}
        </Button>
        <Button variant="ghost" onClick={() => setSsoMode((m) => !m)}>
          {ssoMode ? 'Use a password instead' : 'Sign in with SSO'}
        </Button>
        {ssoMode ? null : (
          <Link to="/forgot-password" className="text-center text-sm text-brand-600">
            Forgot your password?
          </Link>
        )}
      </form>
    </AuthLayout>
  );
}

export function SignupPage() {
  const { me, setMe } = useAuth();
  const navigate = useNavigate();
  const form = useForm();
  const [values, setValues] = useState({ name: '', email: '', password: '', orgName: '' });
  if (me) return <Navigate to="/surveys" replace />;
  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void form.run(async () => {
      setMe(await post<Me>('/auth/signup', values));
      navigate('/surveys', { replace: true });
    });
  };
  return (
    <AuthLayout
      title="Create your account"
      footer={
        <>
          Already have an account?{' '}
          <Link className="font-medium text-brand-600" to="/login">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {form.error && !Object.keys(form.fields).length ? <Alert tone="error">{form.error}</Alert> : null}
        <TextField
          label="Your name"
          autoComplete="name"
          required
          value={values.name}
          onChange={set('name')}
          error={form.fields.name}
        />
        <TextField
          label="Work email"
          type="email"
          autoComplete="email"
          required
          value={values.email}
          onChange={set('email')}
          error={form.fields.email}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          required
          value={values.password}
          onChange={set('password')}
          error={form.fields.password}
        />
        <TextField
          label="Organization name"
          required
          value={values.orgName}
          onChange={set('orgName')}
          error={form.fields.orgName}
        />
        <Button type="submit" variant="primary" busy={form.busy}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const form = useForm();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <AuthLayout
      title="Reset your password"
      footer={
        <Link className="font-medium text-brand-600" to="/login">
          Back to log in
        </Link>
      }
    >
      {sent ? (
        <Alert tone="success">
          If an account exists for {email}, we've sent a link to reset its password. It expires in 1 hour.
        </Alert>
      ) : (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void form.run(async () => {
              await post('/auth/password/forgot', { email });
              setSent(true);
            });
          }}
        >
          {form.error ? <Alert tone="error">{form.error}</Alert> : null}
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" variant="primary" busy={form.busy}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const form = useForm();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  return (
    <AuthLayout title="Choose a new password">
      {done ? (
        <Alert tone="success">
          Your password has been changed and you've been logged out everywhere.{' '}
          <Link className="font-medium underline" to="/login">
            Log in
          </Link>
        </Alert>
      ) : (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void form.run(async () => {
              await post('/auth/password/reset', { token: params.get('token') ?? '', password });
              setDone(true);
            });
          }}
        >
          {form.error ? <Alert tone="error">{form.error}</Alert> : null}
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={form.fields.password}
          />
          <Button type="submit" variant="primary" busy={form.busy}>
            Change password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const [state, setState] = useState<'pending' | 'ok' | 'error'>('pending');
  useEffect(() => {
    post('/auth/verify-email', { token: params.get('token') ?? '' })
      .then(() => setState('ok'))
      .then(() => refresh())
      .catch(() => setState('error'));
  }, [params, refresh]);
  return (
    <AuthLayout title="Confirm your email">
      {state === 'pending' ? <p className="text-sm text-muted">Confirming…</p> : null}
      {state === 'ok' ? (
        <Alert tone="success">
          Your email address is confirmed.{' '}
          <Link className="font-medium underline" to="/surveys">
            Continue
          </Link>
        </Alert>
      ) : null}
      {state === 'error' ? <Alert tone="error">This link is invalid or has expired.</Alert> : null}
    </AuthLayout>
  );
}

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const { me, setMe } = useAuth();
  const navigate = useNavigate();
  const form = useForm();
  const [invite, setInvite] = useState<InvitationPreview | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [values, setValues] = useState({ name: '', password: '' });

  useEffect(() => {
    get<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`)
      .then(setInvite)
      .catch(() => setInvalid(true));
  }, [token]);

  const accept = (body: object) =>
    form.run(async () => {
      setMe(await post<Me>(`/invitations/${encodeURIComponent(token)}/accept`, body));
      navigate('/surveys', { replace: true });
    });

  if (invalid)
    return (
      <AuthLayout title="Invitation not found">
        <Alert tone="error">
          This invitation is invalid, was revoked, has already been used or has expired. Ask your admin for a
          new one.
        </Alert>
      </AuthLayout>
    );
  if (!invite) return <AuthLayout title="Invitation">Loading…</AuthLayout>;

  const role = { org_admin: 'an admin', creator: 'a survey creator', analyst: 'an analyst' }[invite.role];
  return (
    <AuthLayout title={`Join ${invite.orgName}`}>
      <p className="mb-4 text-sm text-muted">
        You've been invited to join <strong className="text-ink">{invite.orgName}</strong> as {role}.
      </p>
      {form.error && !Object.keys(form.fields).length ? (
        <Alert tone="error" className="mb-4">
          {form.error}
        </Alert>
      ) : null}
      {invite.userExists ? (
        me && me.user.email === invite.email ? (
          <Button variant="primary" className="w-full" busy={form.busy} onClick={() => void accept({})}>
            Accept invitation
          </Button>
        ) : (
          <Alert tone="info">
            Log in as <strong>{invite.email}</strong> to accept.{' '}
            <Link
              className="font-medium underline"
              to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
            >
              Log in
            </Link>
          </Alert>
        )
      ) : (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void accept(values);
          }}
        >
          <TextField label="Email" value={invite.email} disabled readOnly />
          <TextField
            label="Your name"
            autoComplete="name"
            value={values.name}
            onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
            error={form.fields.name}
          />
          <TextField
            label="Choose a password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters."
            value={values.password}
            onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
            error={form.fields.password}
          />
          <Button type="submit" variant="primary" busy={form.busy}>
            Join {invite.orgName}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
