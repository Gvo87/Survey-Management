import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Invitation, Member, Org, OrgRole, PageResult } from '@survey/contracts';
import { del, errorMessage, get, patch, post } from '../api';
import { useAuth } from '../auth';
import { Alert, Button, Card, ConfirmDialog, PageHeader, SelectField, TextField } from '../components/ui';
import { formatDate, relativeTime } from '../lib/format';

const ROLES: { value: OrgRole; label: string; description: string }[] = [
  {
    value: 'org_admin',
    label: 'Admin',
    description: 'Manages members and settings; full access to every survey.',
  },
  {
    value: 'creator',
    label: 'Creator',
    description: 'Creates surveys and works on surveys shared with them.',
  },
  { value: 'analyst', label: 'Analyst', description: 'Views results of surveys shared with them.' },
];
const roleLabel = (role: OrgRole) => ROLES.find((r) => r.value === role)!.label;

export function MembersPage() {
  const { me, refresh } = useAuth();
  const isAdmin = me?.activeOrg?.role === 'org_admin';
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: ['members'], queryFn: () => get<PageResult<Member>>('/org/members') });
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: () => get<PageResult<Invitation>>('/org/invitations'),
    enabled: isAdmin,
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('creator');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [transferTo, setTransferTo] = useState('');
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['members'] });
    void queryClient.invalidateQueries({ queryKey: ['invitations'] });
  };
  const onError = (e: unknown) => setError(errorMessage(e));

  const invite = useMutation({
    mutationFn: () => post<Invitation>('/org/invitations', { email, role }),
    onSuccess: (inv) => {
      setNotice(`Invitation sent to ${inv.email}.`);
      setEmail('');
      setError(null);
      reload();
    },
    onError,
  });
  const changeRole = useMutation({
    mutationFn: (v: { userId: string; role: OrgRole }) => patch(`/org/members/${v.userId}`, { role: v.role }),
    onSuccess: (_d, v) => {
      setError(null);
      reload();
      if (v.userId === me?.user.id) void refresh();
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/org/invitations/${id}`),
    onSuccess: reload,
    onError,
  });
  const remove = useMutation({
    mutationFn: (m: Member) =>
      del(`/org/members/${m.userId}${transferTo ? `?transferTo=${transferTo}` : ''}`),
    onSuccess: () => {
      setRemoving(null);
      setError(null);
      reload();
    },
    onError: (e) => {
      setRemoving(null);
      onError(e);
    },
  });

  const list = members.data?.data ?? [];
  return (
    <>
      <PageHeader
        title="Members"
        description={isAdmin ? 'Invite people and choose what they can do.' : 'People in your organization.'}
      />
      {error ? (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" className="mb-4">
          {notice}
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card title={`${list.length} member${list.length === 1 ? '' : 's'}`}>
          <ul className="flex flex-col divide-y divide-line">
            {list.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {m.name} {m.userId === me?.user.id ? <span className="text-muted">(you)</span> : null}
                  </div>
                  <div className="text-xs text-muted">
                    {m.email} ·{' '}
                    {m.lastLoginAt ? `last active ${relativeTime(m.lastLoginAt)}` : 'never logged in'}
                  </div>
                </div>
                {isAdmin ? (
                  <>
                    <label>
                      <span className="sr-only">Role for {m.name}</span>
                      <select
                        className="rounded-md border border-line px-2 py-1 text-sm"
                        value={m.role}
                        onChange={(e) =>
                          changeRole.mutate({ userId: m.userId, role: e.target.value as OrgRole })
                        }
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {m.userId !== me?.user.id ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRemoving(m)}
                        aria-label={`Remove ${m.name}`}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <span className="text-sm text-muted">{roleLabel(m.role)}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
        {isAdmin ? (
          <div className="flex flex-col gap-6">
            <Card title="Invite someone">
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  setNotice(null);
                  invite.mutate();
                }}
              >
                <TextField
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <SelectField
                  label="Role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as OrgRole)}
                  hint={ROLES.find((r) => r.value === role)!.description}
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </SelectField>
                <Button type="submit" variant="primary" busy={invite.isPending} disabled={!email}>
                  Send invitation
                </Button>
              </form>
            </Card>
            <Card title="Pending invitations">
              {(invitations.data?.data ?? []).length === 0 ? (
                <p className="text-sm text-muted">None.</p>
              ) : null}
              <ul className="flex flex-col divide-y divide-line">
                {(invitations.data?.data ?? []).map((inv) => (
                  <li key={inv.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{inv.email}</div>
                      <div className="text-xs text-muted">
                        {roleLabel(inv.role)} · expires {formatDate(inv.expiresAt)}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => revoke.mutate(inv.id)}>
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name}?`}
        message={
          <div className="flex flex-col gap-3">
            <p>They lose access to this organization immediately. Surveys they own are transferred.</p>
            <SelectField
              label="Transfer their surveys to"
              value={transferTo}
              onChange={(e) => setTransferTo(e.target.value)}
            >
              <option value="">Me</option>
              {list
                .filter(
                  (m) => m.userId !== removing?.userId && m.userId !== me?.user.id && m.role !== 'analyst',
                )
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
            </SelectField>
          </div>
        }
        confirmLabel="Remove member"
        danger
        busy={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  );
}

export function OrgSettingsPage() {
  const { refresh } = useAuth();
  const org = useQuery({ queryKey: ['org'], queryFn: () => get<Org>('/org') });
  const [name, setName] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => patch<Org>('/org', { name }),
    onSuccess: () => void refresh(),
  });
  const value = name ?? org.data?.name ?? '';
  return (
    <>
      <PageHeader title="Organization" />
      <Card className="max-w-xl" title="Details">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <TextField label="Organization name" value={value} onChange={(e) => setName(e.target.value)} />
          <p className="text-xs text-muted">
            Plan: {org.data?.plan ?? '-'}. Branding, data retention and SSO arrive in later phases.
          </p>
          {save.isSuccess ? <Alert tone="success">Saved.</Alert> : null}
          {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
          <Button
            type="submit"
            variant="primary"
            className="self-start"
            busy={save.isPending}
            disabled={!value.trim()}
          >
            Save
          </Button>
        </form>
      </Card>
    </>
  );
}
