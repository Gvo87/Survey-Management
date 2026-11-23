/** Phase 3A survey settings: sharing with teams, and notification rules. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Integration,
  NotificationChannel,
  NotificationKind,
  NotificationRule,
  NotificationRuleInput,
  SurveyDetail,
  Team,
  TeamShare,
} from '@survey/contracts';
import { del, errorMessage, get, put } from '../../api';
import { useAuth } from '../../auth';
import { Alert, Button, Card, Checkbox, TextField } from '../../components/ui';

export function TeamAccess({ survey, canShare }: { survey: SurveyDetail; canShare: boolean }) {
  const queryClient = useQueryClient();
  const key = ['survey-teams', survey.id];
  const shares = useQuery({ queryKey: key, queryFn: () => get<TeamShare[]>(`/surveys/${survey.id}/teams`) });
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => get<Team[]>('/org/teams'),
    enabled: canShare,
  });
  const [teamId, setTeamId] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer');
  const set = (data: TeamShare[]) => queryClient.setQueryData(key, data);
  const share = useMutation({
    mutationFn: (v: { teamId: string; role: 'viewer' | 'editor' }) =>
      put<TeamShare[]>(`/surveys/${survey.id}/teams/${v.teamId}`, { role: v.role }),
    onSuccess: (data) => {
      set(data);
      setTeamId('');
    },
  });
  const unshare = useMutation({
    mutationFn: (id: string) => del(`/surveys/${survey.id}/teams/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const sharedIds = new Set(shares.data?.map((s) => s.team.id));
  const candidates = (teams.data ?? []).filter((t) => !sharedIds.has(t.id));
  const error = share.error ?? unshare.error;

  if (!canShare && shares.data?.length === 0) return null;
  return (
    <Card title="Teams with access">
      <p className="mb-3 text-sm text-muted">
        Everyone in a team gets its role. Analysts in a team can still only view. Manage teams in{' '}
        <Link to="/settings/teams" className="text-brand-700 underline">
          Settings
        </Link>
        .
      </p>
      {error ? (
        <Alert tone="error" className="mb-3">
          {errorMessage(error)}
        </Alert>
      ) : null}
      <ul className="flex flex-col divide-y divide-line">
        {(shares.data ?? []).map((s) => (
          <li key={s.team.id} className="flex flex-wrap items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{s.team.name}</div>
              <div className="text-xs text-muted">
                {s.team.memberCount} member{s.team.memberCount === 1 ? '' : 's'}
              </div>
            </div>
            {canShare ? (
              <>
                <label>
                  <span className="sr-only">Access for team {s.team.name}</span>
                  <select
                    className="rounded-md border border-line px-2 py-1 text-sm"
                    value={s.role}
                    onChange={(e) =>
                      share.mutate({ teamId: s.team.id, role: e.target.value as 'viewer' | 'editor' })
                    }
                  >
                    <option value="viewer">Can view</option>
                    <option value="editor">Can edit</option>
                  </select>
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => unshare.mutate(s.team.id)}
                  aria-label={`Remove team ${s.team.name}`}
                >
                  Remove
                </Button>
              </>
            ) : (
              <span className="text-sm text-muted">{s.role === 'editor' ? 'Can edit' : 'Can view'}</span>
            )}
          </li>
        ))}
      </ul>
      {canShare && candidates.length ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (teamId) share.mutate({ teamId, role });
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Share with team</span>
            <select
              className="rounded-lg border border-line px-3 py-2 text-sm"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              <option value="">Choose a team</option>
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Access</span>
            <select
              className="rounded-lg border border-line px-3 py-2 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')}
            >
              <option value="viewer">Can view</option>
              <option value="editor">Can edit</option>
            </select>
          </label>
          <Button type="submit" disabled={!teamId} busy={share.isPending}>
            Share
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

const RULES: { kind: NotificationKind; label: string; hint: string }[] = [
  { kind: 'new_response', label: 'Each new response', hint: 'When someone completes the survey.' },
  { kind: 'nps_detractor', label: 'NPS detractors', hint: 'When an NPS question gets a score of 0 to 6.' },
  { kind: 'threshold', label: 'A response milestone', hint: 'Once, when this many responses are complete.' },
  {
    kind: 'closing',
    label: 'The survey closes',
    hint: 'By hand, by its close date or by its response limit.',
  },
];
const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: 'In the app',
  email: 'Email',
  slack: 'Slack',
};

type RuleState = Record<NotificationKind, { on: boolean; channels: Set<NotificationChannel>; count: string }>;
const fromRules = (rules: NotificationRule[]): RuleState =>
  Object.fromEntries(
    RULES.map(({ kind }) => {
      const rule = rules.find((r) => r.kind === kind);
      return [
        kind,
        {
          on: Boolean(rule),
          channels: new Set(rule?.channels ?? ['in_app']),
          count: String(rule?.config.count ?? 100),
        },
      ];
    }),
  ) as RuleState;

export function NotificationRules({ survey, canEdit }: { survey: SurveyDetail; canEdit: boolean }) {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const key = ['notification-rules', survey.id];
  const rules = useQuery({
    queryKey: key,
    queryFn: () => get<NotificationRule[]>(`/surveys/${survey.id}/notification-rules`),
  });
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => get<Integration[]>('/integrations'),
    enabled: me?.activeOrg?.role === 'org_admin',
  });
  const [state, setState] = useState<RuleState | null>(null);
  useEffect(() => {
    if (rules.data && !state) setState(fromRules(rules.data));
  }, [rules.data, state]);
  const save = useMutation({
    mutationFn: () => {
      const body: NotificationRuleInput[] = RULES.filter(({ kind }) => state![kind].on).map(({ kind }) => ({
        kind,
        config: kind === 'threshold' ? { count: Number(state![kind].count) } : {},
        channels: [...state![kind].channels],
      }));
      return put<NotificationRule[]>(`/surveys/${survey.id}/notification-rules`, { rules: body });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
      setState(fromRules(data));
    },
  });
  // Non-admins can't read integrations; the server refuses Slack rules when Slack isn't connected.
  const slackConnected = integrations.data
    ? integrations.data.some((i) => i.kind === 'slack' && i.connected)
    : true;
  const channels: NotificationChannel[] = slackConnected ? ['in_app', 'email', 'slack'] : ['in_app', 'email'];
  const update = (kind: NotificationKind, change: Partial<RuleState[NotificationKind]>) =>
    setState((s) => (s ? { ...s, [kind]: { ...s[kind], ...change } } : s));

  return (
    <Card title="Notifications">
      <p className="mb-3 text-sm text-muted">
        Notifies everyone this survey is shared with (people and teams). Each person can turn off email or
        in-app notifications in their own{' '}
        <Link to="/settings/notifications" className="text-brand-700 underline">
          preferences
        </Link>
        .
      </p>
      {state ? (
        <div className="flex flex-col divide-y divide-line">
          {RULES.map(({ kind, label, hint }) => (
            <div key={kind} className="flex flex-col gap-2 py-3">
              <Checkbox
                label={label}
                hint={hint}
                checked={state[kind].on}
                disabled={!canEdit}
                onChange={(e) => update(kind, { on: e.target.checked })}
              />
              {state[kind].on ? (
                <div className="ml-6 flex flex-wrap items-end gap-4">
                  {kind === 'threshold' ? (
                    <TextField
                      label="Responses"
                      type="number"
                      min={1}
                      className="w-28"
                      value={state[kind].count}
                      disabled={!canEdit}
                      onChange={(e) => update(kind, { count: e.target.value })}
                    />
                  ) : null}
                  <fieldset className="flex flex-wrap gap-4">
                    <legend className="sr-only">Channels for {label}</legend>
                    {channels.map((channel) => (
                      <Checkbox
                        key={channel}
                        label={CHANNEL_LABEL[channel]}
                        checked={state[kind].channels.has(channel)}
                        disabled={!canEdit}
                        onChange={() => {
                          const next = new Set(state[kind].channels);
                          if (next.has(channel)) next.delete(channel);
                          else next.add(channel);
                          update(kind, { channels: next });
                        }}
                      />
                    ))}
                  </fieldset>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {save.isSuccess ? (
        <Alert tone="success" className="mt-3">
          Saved.
        </Alert>
      ) : null}
      {save.error ? (
        <Alert tone="error" className="mt-3">
          {errorMessage(save.error)}
        </Alert>
      ) : null}
      {canEdit ? (
        <Button
          className="mt-3"
          variant="primary"
          busy={save.isPending}
          disabled={!state}
          onClick={() => save.mutate()}
        >
          Save notifications
        </Button>
      ) : null}
    </Card>
  );
}
