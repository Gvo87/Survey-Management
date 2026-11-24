import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Integration, IntegrationKind } from '@survey/contracts';
import { del, errorMessage, get, post, put } from '../api';
import { Alert, Badge, Button, Card, PageHeader, TextField } from '../components/ui';
import { relativeTime } from '../lib/format';

/** Integrations (Phase 3A): Slack is live; HubSpot and Google Sheets are configuration-only stubs. */
export function IntegrationsPage() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['integrations'], queryFn: () => get<Integration[]>('/integrations') });
  const set = (data: Integration[]) => queryClient.setQueryData(['integrations'], data);
  const find = (kind: IntegrationKind) => list.data?.find((i) => i.kind === kind);
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Send survey activity to the tools your team already uses."
      />
      {list.error ? <Alert tone="error">{errorMessage(list.error)}</Alert> : null}
      {list.data ? (
        <div className="grid max-w-3xl gap-6">
          <SlackCard integration={find('slack')!} onChange={set} />
          <StubCard
            integration={find('hubspot')!}
            title="HubSpot"
            description="Update the respondent's HubSpot contact (matched by the email they gave) when they complete a survey."
            fields={[
              { name: 'accessToken', label: 'Private app access token', type: 'password' },
              {
                name: 'emailQuestionKey',
                label: 'Email question key (optional)',
                hint: 'Defaults to the first email question.',
              },
            ]}
            onChange={set}
          />
          <StubCard
            integration={find('google_sheets')!}
            title="Google Sheets"
            description="Add a row to a spreadsheet for each completed response."
            fields={[
              { name: 'spreadsheetId', label: 'Spreadsheet ID' },
              { name: 'sheetName', label: 'Sheet name', initial: 'Responses' },
              { name: 'accessToken', label: 'Access token', type: 'password' },
            ]}
            onChange={set}
          />
        </div>
      ) : null}
    </>
  );
}

function Status({ integration }: { integration: Integration }) {
  if (!integration.connected) return <Badge className="bg-gray-100 text-gray-700">Not connected</Badge>;
  if (integration.status === 'error') return <Badge className="bg-red-100 text-red-800">Error</Badge>;
  return <Badge className="bg-green-100 text-green-800">Connected</Badge>;
}

function SlackCard({
  integration,
  onChange,
}: {
  integration: Integration;
  onChange: (data: Integration[]) => void;
}) {
  const [webhookUrl, setWebhookUrl] = useState('');
  const [channelName, setChannelName] = useState(
    integration.summary.channel?.startsWith('#') ? integration.summary.channel : '',
  );
  const save = useMutation({
    mutationFn: () =>
      put<Integration[]>('/integrations/slack', { webhookUrl, ...(channelName ? { channelName } : {}) }),
    onSuccess: (data) => {
      setWebhookUrl('');
      onChange(data);
    },
  });
  const test = useMutation({
    mutationFn: () => post<{ ok: boolean; error: string | null }>('/integrations/slack/test'),
  });
  const disconnect = useMutation({
    mutationFn: () => del<Integration[]>('/integrations/slack'),
    onSuccess: onChange,
  });
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Slack <Status integration={integration} />
        </span>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Post survey notifications to a channel. In Slack, create an incoming webhook for the channel, then
        paste its URL here. Choose “Slack” as a channel in a survey's notification rules.
      </p>
      {integration.connected ? (
        <p className="mb-3 text-sm">
          Posting to {integration.summary.channel}
          {integration.updatedAt ? ` · updated ${relativeTime(integration.updatedAt)}` : ''}
        </p>
      ) : null}
      {integration.lastError ? (
        <Alert tone="error" className="mb-3">
          Last post failed: {integration.lastError}
        </Alert>
      ) : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label={integration.connected ? 'New incoming webhook URL' : 'Incoming webhook URL'}
          type="url"
          placeholder="https://hooks.slack.com/services/…"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
        />
        <TextField
          label="Channel name (for your reference)"
          placeholder="#survey-alerts"
          value={channelName}
          onChange={(e) => setChannelName(e.target.value)}
        />
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
        {test.data ? (
          <Alert tone={test.data.ok ? 'success' : 'error'}>
            {test.data.ok ? 'Test message sent.' : `Test failed: ${test.data.error}`}
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" busy={save.isPending} disabled={!webhookUrl.trim()}>
            {integration.connected ? 'Update' : 'Connect Slack'}
          </Button>
          {integration.connected ? (
            <>
              <Button busy={test.isPending} onClick={() => test.mutate()}>
                Send test message
              </Button>
              <Button variant="ghost" busy={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </Button>
            </>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

interface FieldSpec {
  name: string;
  label: string;
  type?: string;
  hint?: string;
  initial?: string;
}

function StubCard({
  integration,
  title,
  description,
  fields,
  onChange,
}: {
  integration: Integration;
  title: string;
  description: ReactNode;
  fields: FieldSpec[];
  onChange: (data: Integration[]) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.name, f.initial ?? ''])),
  );
  const save = useMutation({
    mutationFn: () =>
      put<Integration[]>(
        `/integrations/${integration.kind}`,
        Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())),
      ),
    onSuccess: onChange,
  });
  const disconnect = useMutation({
    mutationFn: () => del<Integration[]>(`/integrations/${integration.kind}`),
    onSuccess: onChange,
  });
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {title} <Status integration={integration} />
          <Badge className="bg-amber-100 text-amber-900">Preview</Badge>
        </span>
      }
    >
      <p className="mb-1 text-sm text-muted">{description}</p>
      <p className="mb-3 text-xs text-muted">
        Not syncing yet: you can save the connection now, and responses start flowing once this connector is
        switched on in a later release.
      </p>
      {integration.connected ? (
        <p className="mb-3 text-sm">
          Saved:{' '}
          {Object.entries(integration.summary)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {fields.map((f) => (
          <TextField
            key={f.name}
            label={f.label}
            hint={f.hint}
            type={f.type ?? 'text'}
            autoComplete="off"
            value={values[f.name] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
          />
        ))}
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
        <div className="flex gap-2">
          <Button type="submit" busy={save.isPending}>
            Save connection
          </Button>
          {integration.connected ? (
            <Button variant="ghost" busy={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Remove
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
