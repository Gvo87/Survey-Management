import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Invitation, Member, Org, OrgRole, PageResult } from '@survey/contracts';
import { del, errorMessage, get, patch, post } from '../api';
import { useAuth } from '../auth';
import { Alert, Button, Card, Checkbox, ConfirmDialog, PageHeader, SelectField, TextField } from '../components/ui';
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
          <p className="text-xs text-muted">Plan: {org.data?.plan ?? '-'}.</p>
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
      {org.data ? <ApprovalSettings org={org.data} /> : null}
      {org.data ? <RetentionDefault org={org.data} /> : null}
      {org.data ? <AiSettings org={org.data} /> : null}
    </>
  );
}

/** Phase 3B: how long to keep responses (surveys can override it). */
function RetentionDefault({ org }: { org: Org }) {
  const queryClient = useQueryClient();
  const [keep, setKeep] = useState(org.retention.responsesDays === null);
  const [days, setDays] = useState(String(org.retention.responsesDays ?? 730));
  const invalid = !keep && !(Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 3650);
  const save = useMutation({
    mutationFn: () => patch<Org>('/org', { retention: { responsesDays: keep ? null : Number(days) } }),
    onSuccess: (data) => queryClient.setQueryData(['org'], data),
  });
  return (
    <Card className="mt-6 max-w-xl" title="Data retention">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) save.mutate();
        }}
      >
        <Checkbox label="Keep responses until someone deletes them" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        {!keep ? (
          <TextField
            label="Delete responses after (days)"
            type="number"
            min={1}
            max={3650}
            className="max-w-48"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            error={invalid ? 'Enter a whole number from 1 to 3650.' : undefined}
            hint="Every night, responses completed (or last active) longer ago than this are deleted for good, with their files. Each survey can set its own period."
          />
        ) : null}
        {save.isSuccess ? <Alert tone="success">Saved.</Alert> : null}
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
        <Button type="submit" variant="primary" className="self-start" busy={save.isPending} disabled={invalid}>
          Save retention
        </Button>
      </form>
    </Card>
  );
}

/** Phase 3B: AI summaries of open text are off until an admin turns them on here. */
function AiSettings({ org }: { org: Org }) {
  const queryClient = useQueryClient();
  // Shown at once; put back if saving fails.
  const [enabled, setEnabled] = useState(org.ai.enabled);
  const save = useMutation({
    mutationFn: (next: boolean) => patch<Org>('/org', { ai: { enabled: next } }),
    onSuccess: (data) => queryClient.setQueryData(['org'], data),
    onError: () => setEnabled(org.ai.enabled),
  });
  const ai = org.ai;
  return (
    <Card className="mt-6 max-w-xl" title="AI summaries">
      <div className="flex flex-col gap-3 text-sm">
        {!ai.available ? (
          <p className="text-muted">Not available on this platform: no AI provider is configured.</p>
        ) : (
          <>
            <p>
              Summarize answers to open questions into themes and sentiment, with links to sample answers. Every summary is labelled as AI-generated.
            </p>
            <Alert tone="info">
              When someone asks for a summary, up to a few hundred answers to that question are sent to {ai.provider === 'openai' ? 'OpenAI' : ai.provider} (model{' '}
              {ai.model}), a third-party processor. Email addresses and phone numbers are removed first, but other details people typed are sent as
              written. Check this fits your agreements with respondents before turning it on.
            </Alert>
            <Checkbox
              label="Turn on AI summaries for this organization"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                save.mutate(e.target.checked);
              }}
            />
            {save.isSuccess ? <p role="status" className="text-xs text-green-800">{enabled ? 'AI summaries are on.' : 'AI summaries are off.'}</p> : null}
            <p className="text-xs text-muted">
              Used this month: {ai.tokensUsedThisMonth.toLocaleString()} of {ai.monthlyTokenCap.toLocaleString()} tokens. The allowance resets on the 1st (UTC).
            </p>
          </>
        )}
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      </div>
    </Card>
  );
}

/** Phase 3A: require approval before publishing, and choose who besides admins can approve. */
function ApprovalSettings({ org }: { org: Org }) {
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: ['members'], queryFn: () => get<PageResult<Member>>('/org/members') });
  const [required, setRequired] = useState(org.approvalRequired);
  const [approvers, setApprovers] = useState(new Set(org.approverIds));
  const save = useMutation({
    mutationFn: () => patch<Org>('/org', { approvalRequired: required, approverIds: [...approvers] }),
    onSuccess: (data) => queryClient.setQueryData(['org'], data),
  });
  const candidates = (members.data?.data ?? []).filter((m) => m.role === 'creator');
  return (
    <Card className="mt-6 max-w-xl" title="Approval before publishing">
      <div className="flex flex-col gap-4">
        <Checkbox
          label="Require approval to publish"
          hint="Publishing sends the exact draft to an approver. It goes live only when someone else approves it, and any edit makes the request out of date."
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Approvers</legend>
          <p className="text-xs text-muted">
            Admins can always approve. Creators chosen here can approve surveys shared with them. Nobody approves their own request.
          </p>
          {candidates.length === 0 ? <p className="text-sm text-muted">No creators in this organization.</p> : null}
          {candidates.map((m) => (
            <Checkbox
              key={m.userId}
              label={m.name}
              hint={m.email}
              checked={approvers.has(m.userId)}
              onChange={() =>
                setApprovers((current) => {
                  const next = new Set(current);
                  if (next.has(m.userId)) next.delete(m.userId);
                  else next.add(m.userId);
                  return next;
                })
              }
            />
          ))}
        </fieldset>
        {save.isSuccess ? <Alert tone="success">Saved.</Alert> : null}
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
        <Button variant="primary" className="self-start" busy={save.isPending} onClick={() => save.mutate()}>
          Save approval settings
        </Button>
      </div>
    </Card>
  );
}
