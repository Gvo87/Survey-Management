/**
 * Phase 3B: single sign-on settings (org admins). Domains are verified with a DNS TXT record; connections
 * are OIDC (Google, Okta, Entra ID…) or SAML. Enforcement turns password sign-in off for verified domains
 * and can only be switched on after someone signed in through SSO.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Org, SaveSsoConnectionRequest, SsoConnection, SsoSettings } from '@survey/contracts';
import { ApiError, del, errorMessage, get, patch, post } from '../api';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, CopyButton, Dialog, PageHeader, SelectField, TextArea, TextField } from '../components/ui';
import { formatDateTime } from '../lib/format';

export function SsoSettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['sso'], queryFn: () => get<SsoSettings>('/org/sso') });
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['sso'] });
  const [editing, setEditing] = useState<SsoConnection | 'oidc' | 'saml' | null>(null);
  const [removing, setRemoving] = useState<SsoConnection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enforce = useMutation({
    mutationFn: (enforced: boolean) => patch<Org>('/org', { sso: { enforced } }),
    onSuccess: () => {
      setError(null);
      reload();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/org/sso/connections/${id}`),
    onSuccess: () => {
      setRemoving(null);
      reload();
    },
  });

  const data = settings.data;
  return (
    <>
      <PageHeader title="Single sign-on" description="Let people sign in with your identity provider (SAML or OpenID Connect), and add them on their first sign-in." />
      {settings.error ? <Alert tone="error">{errorMessage(settings.error)}</Alert> : null}
      {error ? (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      ) : null}
      {data ? (
        <div className="grid max-w-4xl gap-6">
          <Domains settings={data} onChanged={reload} />
          <Card
            title="Connections"
            actions={
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setEditing('oidc')}>
                  Add OpenID Connect
                </Button>
                <Button size="sm" onClick={() => setEditing('saml')}>
                  Add SAML
                </Button>
              </div>
            }
          >
            {data.connections.length === 0 ? <p className="text-sm text-muted">No connections yet.</p> : null}
            <ul className="flex flex-col divide-y divide-line">
              {data.connections.map((c) => (
                <li key={c.id} className="flex flex-wrap items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {c.name}
                      <Badge>{c.protocol === 'oidc' ? 'OpenID Connect' : 'SAML'}</Badge>
                      {!c.enabled ? <Badge className="bg-gray-200 text-gray-700">Off</Badge> : null}
                    </div>
                    <p className="text-xs text-muted">
                      {c.protocol === 'oidc' ? `Issuer ${c.summary.issuer}` : `Sign-on URL ${c.summary.entryPoint}`} · new members join as{' '}
                      {c.defaultRole} · {c.lastLoginAt ? `last sign-in ${formatDateTime(c.lastLoginAt)}` : 'no sign-in yet'}
                    </p>
                  </div>
                  <a className="text-sm text-brand-600 underline" href={c.loginUrl}>
                    Test sign-in
                  </a>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(c)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Enforcement">
            <div className="flex flex-col gap-3 text-sm">
              <p>
                {data.enforced
                  ? 'Password sign-in is off for your verified domains: people sign in with single sign-on.'
                  : 'People in your verified domains can sign in with a password or with single sign-on.'}
              </p>
              {!data.canEnforce && !data.enforced ? (
                <p className="text-muted">To enforce single sign-on, verify a domain and sign in once through a connection (use “Test sign-in”).</p>
              ) : null}
              <Button
                className="self-start"
                variant={data.enforced ? 'secondary' : 'primary'}
                busy={enforce.isPending}
                disabled={!data.enforced && !data.canEnforce}
                onClick={() => enforce.mutate(!data.enforced)}
              >
                {data.enforced ? 'Allow passwords again' : 'Require single sign-on'}
              </Button>
              <p className="text-xs text-muted">
                Enforced sign-on also turns off sign-up, password resets and new-password invitations for those domains. Sessions already open keep working.
              </p>
            </div>
          </Card>
        </div>
      ) : null}
      {editing ? <ConnectionDialog editing={editing} onClose={() => setEditing(null)} onSaved={reload} /> : null}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'connection'}?`}
        message="People can no longer sign in with it. If it was the only working connection, single sign-on stops being enforced."
        confirmLabel="Remove"
        danger
        busy={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </>
  );
}

function Domains({ settings, onChanged }: { settings: SsoSettings; onChanged: () => void }) {
  const [domain, setDomain] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const add = useMutation({
    mutationFn: () => post('/org/sso/domains', { domain }),
    onSuccess: () => {
      setDomain('');
      setMessage(null);
      onChanged();
    },
    onError: (e) => setMessage({ tone: 'error', text: errorMessage(e) }),
  });
  const verify = useMutation({
    mutationFn: (d: string) => post(`/org/sso/domains/${d}/verify`),
    onSuccess: () => {
      setMessage({ tone: 'success', text: 'Domain verified.' });
      onChanged();
    },
    onError: (e) => setMessage({ tone: 'error', text: errorMessage(e) }),
  });
  const remove = useMutation({ mutationFn: (d: string) => del(`/org/sso/domains/${d}`), onSuccess: onChanged });
  return (
    <Card title="Email domains">
      <p className="mb-3 text-sm text-muted">
        Single sign-on accepts only people whose email is in a verified domain. Prove you own a domain by adding a DNS TXT record.
      </p>
      <ul className="mb-4 flex flex-col divide-y divide-line">
        {settings.domains.map((d) => (
          <li key={d.domain} className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{d.domain}</span>
              {d.verified ? <Badge className="bg-green-100 text-green-800">Verified</Badge> : <Badge className="bg-amber-100 text-amber-900">Not verified</Badge>}
              <span className="ml-auto flex gap-2">
                {!d.verified ? (
                  <Button size="sm" busy={verify.isPending && verify.variables === d.domain} onClick={() => verify.mutate(d.domain)}>
                    Verify
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(d.domain)}>
                  Remove
                </Button>
              </span>
            </div>
            {!d.verified ? (
              <div className="rounded-md bg-gray-50 p-2 text-xs">
                <p>
                  Add a TXT record named <code>{d.txtRecord.name}</code> with this value, then verify:
                </p>
                <p className="mt-1 flex items-center gap-2">
                  <code className="break-all">{d.txtRecord.value}</code> <CopyButton text={d.txtRecord.value} />
                </p>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <TextField label="Domain" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} className="min-w-64 flex-1" />
        <Button type="submit" busy={add.isPending} disabled={!domain.trim()}>
          Add domain
        </Button>
      </form>
      {message ? (
        <Alert tone={message.tone} className="mt-3">
          {message.text}
        </Alert>
      ) : null}
    </Card>
  );
}

function ConnectionDialog({ editing, onClose, onSaved }: { editing: SsoConnection | 'oidc' | 'saml'; onClose: () => void; onSaved: () => void }) {
  const existing = typeof editing === 'string' ? null : editing;
  const protocol = existing?.protocol ?? (editing as 'oidc' | 'saml');
  const [values, setValues] = useState({
    name: existing?.name ?? (protocol === 'oidc' ? 'Google Workspace' : 'Okta'),
    defaultRole: existing?.defaultRole ?? 'creator',
    enabled: existing?.enabled ?? true,
    issuer: existing?.summary.issuer ?? '',
    clientId: existing?.summary.clientId ?? '',
    clientSecret: '',
    entryPoint: existing?.summary.entryPoint ?? '',
    idpIssuer: existing?.summary.idpIssuer ?? '',
    idpCert: '',
  });
  const [fields, setFields] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => {
      const base = { name: values.name, defaultRole: values.defaultRole, enabled: values.enabled };
      const body: SaveSsoConnectionRequest =
        protocol === 'oidc'
          ? { protocol, ...base, issuer: values.issuer, clientId: values.clientId, ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}) }
          : { protocol, ...base, entryPoint: values.entryPoint, idpIssuer: values.idpIssuer, ...(values.idpCert ? { idpCert: values.idpCert } : {}) };
      return existing ? patch(`/org/sso/connections/${existing.id}`, body) : post('/org/sso/connections', body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => setFields(e instanceof ApiError ? e.fieldErrors() : {}),
  });
  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  const sp = existing?.serviceProvider;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`${existing ? 'Edit' : 'Add'} ${protocol === 'oidc' ? 'OpenID Connect' : 'SAML'} connection`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField label="Name" value={values.name} onChange={set('name')} error={fields.name} />
        {protocol === 'oidc' ? (
          <>
            <TextField label="Issuer URL" placeholder="https://accounts.google.com" value={values.issuer} onChange={set('issuer')} error={fields.issuer} />
            <TextField label="Client ID" value={values.clientId} onChange={set('clientId')} error={fields.clientId} />
            <TextField
              label="Client secret"
              type="password"
              autoComplete="off"
              value={values.clientSecret}
              onChange={set('clientSecret')}
              error={fields.clientSecret}
              hint={existing ? 'Leave empty to keep the current secret. It is stored encrypted and never shown again.' : 'Stored encrypted and never shown again.'}
            />
            <p className="text-xs text-muted">
              Redirect URI to register at your provider: <code>{sp?.redirectUri ?? `${location.origin}/api/v1/auth/sso/oidc/callback`}</code>
            </p>
          </>
        ) : (
          <>
            <TextField label="Identity provider sign-on URL" placeholder="https://yourcompany.okta.com/app/…/sso/saml" value={values.entryPoint} onChange={set('entryPoint')} error={fields.entryPoint} />
            <TextField label="Identity provider entity ID (issuer)" value={values.idpIssuer} onChange={set('idpIssuer')} error={fields.idpIssuer} />
            <TextArea
              label="Signing certificate"
              rows={4}
              value={values.idpCert}
              onChange={set('idpCert')}
              error={fields.idpCert}
              hint={existing ? 'Leave empty to keep the current certificate.' : 'PEM or base64, from your identity provider.'}
            />
            {sp ? (
              <p className="text-xs text-muted">
                At your identity provider: ACS URL <code>{sp.acsUrl}</code>, entity ID / audience <code>{sp.entityId}</code>, NameID format email address.
                Metadata: <a className="underline" href={sp.metadataUrl}>{sp.metadataUrl}</a>
              </p>
            ) : (
              <p className="text-xs text-muted">After saving, this page shows the ACS URL and entity ID to enter at your identity provider.</p>
            )}
          </>
        )}
        <SelectField label="Role for people added on their first sign-in" value={values.defaultRole} onChange={set('defaultRole')}>
          <option value="creator">Creator</option>
          <option value="analyst">Analyst</option>
        </SelectField>
        <Checkbox label="Turned on" checked={values.enabled} onChange={(e) => setValues((v) => ({ ...v, enabled: e.target.checked }))} />
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      </form>
    </Dialog>
  );
}
