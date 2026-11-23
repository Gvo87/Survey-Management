import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  API_SCOPES,
  WEBHOOK_EVENTS,
  type ApiKey,
  type ApiScope,
  type CreatedApiKey,
  type CreatedWebhook,
  type PageResult,
  type Webhook,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookEvent,
  type WebhookTestResult,
} from '@survey/contracts';
import { del, errorMessage, get, patch, post } from '../api';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  CopyButton,
  Dialog,
  EmptyState,
  PageHeader,
  TextField,
  cx,
} from '../components/ui';
import { formatDateTime, relativeTime } from '../lib/format';

const SCOPE_HINT: Record<ApiScope, string> = {
  'surveys:read': 'List surveys, read drafts and versions',
  'surveys:write': 'Create, edit, publish and close surveys',
  'responses:read': 'Read responses, summaries and CSV exports',
  'responses:delete': 'Delete responses',
  'contacts:read': 'List contacts and lists',
  'contacts:write': 'Create, change and delete contacts and lists',
  'webhooks:manage': 'Manage webhook endpoints and deliveries',
};

/** Public API keys and outgoing webhooks (Phase 3A). Org admins only. */
export function ApiPage() {
  return (
    <>
      <PageHeader
        title="API and webhooks"
        description={
          <>
            Connect other systems. The API is described in the{' '}
            <a
              href="/api/v1/openapi.json"
              className="text-brand-700 underline"
              target="_blank"
              rel="noreferrer"
            >
              OpenAPI document
            </a>
            .
          </>
        }
      />
      <div className="flex flex-col gap-6">
        <ApiKeys />
        <Webhooks />
      </div>
    </>
  );
}

function ApiKeys() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => get<ApiKey[]>('/api-keys') });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const revoke = useMutation({
    mutationFn: (key: ApiKey) => del(`/api-keys/${key.id}`),
    onSuccess: () => {
      setRevoking(null);
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });
  return (
    <Card
      title="API keys"
      actions={
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          New API key
        </Button>
      }
    >
      {created ? (
        <Alert tone="success" className="mb-4">
          <p className="font-medium">Copy the key for “{created.name}” now. It won’t be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-xs"
              data-testid="new-api-key"
            >
              {created.key}
            </code>
            <CopyButton text={created.key} />
          </div>
        </Alert>
      ) : null}
      {keys.data?.length === 0 ? <p className="text-sm text-muted">No keys yet.</p> : null}
      <ul className="divide-y divide-line">
        {(keys.data ?? []).map((k) => (
          <li key={k.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {k.name} <code className="ml-1 text-xs text-muted">{k.prefix}…</code>
                {k.revokedAt ? <Badge className="ml-2 bg-gray-200 text-gray-600">Revoked</Badge> : null}
                {!k.revokedAt && k.expiresAt && new Date(k.expiresAt) < new Date() ? (
                  <Badge className="ml-2 bg-amber-100 text-amber-900">Expired</Badge>
                ) : null}
              </p>
              <p className="text-xs text-muted">
                {k.scopes.join(', ')} · created by {k.createdBy?.name ?? 'a former admin'}{' '}
                {relativeTime(k.createdAt)} ·{' '}
                {k.lastUsedAt ? `last used ${relativeTime(k.lastUsedAt)}` : 'never used'}
                {k.expiresAt ? ` · expires ${formatDateTime(k.expiresAt)}` : ''}
              </p>
            </div>
            {!k.revokedAt ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRevoking(k)}
                aria-label={`Revoke ${k.name}`}
              >
                Revoke
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">
        Send <code>Authorization: Bearer sk_live_…</code>. Each key allows 600 requests a minute. A key stops
        working if the admin who created it stops being an admin.
      </p>
      {creating ? (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreated(key);
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke “${revoking?.name}”?`}
        message="Anything using this key stops working immediately. This can't be undone."
        confirmLabel="Revoke key"
        danger
        busy={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </Card>
  );
}

function CreateKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<ApiScope>>(new Set(['surveys:read', 'responses:read']));
  const [expires, setExpires] = useState('');
  const create = useMutation({
    mutationFn: () =>
      post<CreatedApiKey>('/api-keys', {
        name,
        scopes: [...scopes],
        ...(expires ? { expiresAt: new Date(`${expires}T23:59:59`).toISOString() } : {}),
      }),
    onSuccess: onCreated,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="New API key"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={!name.trim() || scopes.size === 0}
            onClick={() => create.mutate()}
          >
            Create key
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Name"
          hint="What uses it, e.g. “CRM sync”."
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Scopes</legend>
          {API_SCOPES.map((scope) => (
            <Checkbox
              key={scope}
              label={<code>{scope}</code>}
              hint={SCOPE_HINT[scope]}
              checked={scopes.has(scope)}
              onChange={() =>
                setScopes((current) => {
                  const next = new Set(current);
                  if (next.has(scope)) next.delete(scope);
                  else next.add(scope);
                  return next;
                })
              }
            />
          ))}
        </fieldset>
        <TextField
          label="Expires (optional)"
          type="date"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
        />
        {create.error ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
      </div>
    </Dialog>
  );
}

function Webhooks() {
  const queryClient = useQueryClient();
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => get<Webhook[]>('/webhooks') });
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const [deliveriesOf, setDeliveriesOf] = useState<Webhook | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const [tested, setTested] = useState<Record<string, WebhookTestResult>>({});
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['webhooks'] });
  const toggle = useMutation({
    mutationFn: (h: Webhook) => patch(`/webhooks/${h.id}`, { active: !h.active }),
    onSuccess: reload,
  });
  const test = useMutation({
    mutationFn: (h: Webhook) => post<WebhookTestResult>(`/webhooks/${h.id}/test`),
    onSuccess: (result, h) => setTested((t) => ({ ...t, [h.id]: result })),
  });
  const rotate = useMutation({
    mutationFn: (h: Webhook) => post<{ secret: string }>(`/webhooks/${h.id}/rotate-secret`),
    onSuccess: (data, h) => {
      setSecret({ url: h.url, secret: data.secret });
      reload();
    },
  });
  const remove = useMutation({
    mutationFn: (h: Webhook) => del(`/webhooks/${h.id}`),
    onSuccess: () => {
      setDeleting(null);
      reload();
    },
  });
  const error = toggle.error ?? test.error ?? rotate.error ?? remove.error;

  return (
    <Card
      title="Webhooks"
      actions={
        <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
          Add endpoint
        </Button>
      }
    >
      {secret ? (
        <Alert tone="success" className="mb-4">
          <p className="font-medium">
            Signing secret for {secret.url}. Copy it now: it won’t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-xs">
              {secret.secret}
            </code>
            <CopyButton text={secret.secret} />
          </div>
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" className="mb-3">
          {errorMessage(error)}
        </Alert>
      ) : null}
      {hooks.data?.length === 0 ? (
        <EmptyState title="No webhook endpoints">
          We POST a signed JSON event to your URL when a response is submitted or a survey is published or
          closed.
        </EmptyState>
      ) : null}
      <ul className="divide-y divide-line">
        {(hooks.data ?? []).map((h) => (
          <li key={h.id} className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-sm">{h.url}</code>
              {h.active ? (
                <Badge className="bg-green-100 text-green-800">Active</Badge>
              ) : (
                <Badge className="bg-gray-200 text-gray-700">Off</Badge>
              )}
            </div>
            <p className="text-xs text-muted">
              {h.events.join(', ')} ·{' '}
              {h.surveyIds
                ? `${h.surveyIds.length} survey${h.surveyIds.length === 1 ? '' : 's'}`
                : 'every survey'}
              {h.description ? ` · ${h.description}` : ''}
              {h.consecutiveFailures
                ? ` · ${h.consecutiveFailures} failed event${h.consecutiveFailures === 1 ? '' : 's'} in a row`
                : ''}
              {h.previousSecretExpiresAt
                ? ` · old secret valid until ${formatDateTime(h.previousSecretExpiresAt)}`
                : ''}
            </p>
            {h.disabledReason ? <Alert tone="warning">{h.disabledReason}</Alert> : null}
            {tested[h.id] ? (
              <p
                className={cx('text-xs', tested[h.id]!.error ? 'text-red-700' : 'text-green-800')}
                role="status"
              >
                Test: {tested[h.id]!.error ?? `HTTP ${tested[h.id]!.httpStatus}`} in{' '}
                {tested[h.id]!.durationMs} ms
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setDeliveriesOf(h)}>
                Deliveries
              </Button>
              <Button
                size="sm"
                busy={test.isPending && test.variables?.id === h.id}
                onClick={() => test.mutate(h)}
              >
                Send test
              </Button>
              <Button size="sm" onClick={() => setEditing(h)}>
                Edit
              </Button>
              <Button size="sm" onClick={() => toggle.mutate(h)}>
                {h.active ? 'Turn off' : 'Turn on'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => rotate.mutate(h)}>
                Rotate secret
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(h)} aria-label={`Delete ${h.url}`}>
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">
        Verify each request’s <code>Survey-Webhook-Signature</code> (HMAC-SHA256 of timestamp and body with
        your secret). Failed deliveries are retried after 1 m, 5 m, 30 m, 2 h, 6 h, 12 h and 24 h; 50 failed
        events in a row turn the endpoint off.
      </p>
      {editing ? (
        <WebhookDialog
          webhook={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            if (created) setSecret({ url: created.url, secret: created.secret });
            setEditing(null);
            reload();
          }}
        />
      ) : null}
      {deliveriesOf ? (
        <DeliveriesDialog webhook={deliveriesOf} onClose={() => setDeliveriesOf(null)} />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this endpoint?"
        message={`Nothing more is sent to ${deleting?.url}, and its delivery history is deleted.`}
        confirmLabel="Delete endpoint"
        danger
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Card>
  );
}

function WebhookDialog({
  webhook,
  onClose,
  onSaved,
}: {
  webhook: Webhook | null;
  onClose: () => void;
  onSaved: (created: CreatedWebhook | null) => void;
}) {
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [description, setDescription] = useState(webhook?.description ?? '');
  const [events, setEvents] = useState<Set<WebhookEvent>>(new Set(webhook?.events ?? ['response.submitted']));
  const save = useMutation({
    mutationFn: async () => {
      const body = { url, description, events: [...events] };
      if (webhook) {
        await patch(`/webhooks/${webhook.id}`, body);
        return null;
      }
      return post<CreatedWebhook>('/webhooks', body);
    },
    onSuccess: onSaved,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={webhook ? 'Edit endpoint' : 'Add webhook endpoint'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={!url.trim() || events.size === 0}
            onClick={() => save.mutate()}
          >
            {webhook ? 'Save' : 'Add endpoint'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Endpoint URL"
          type="url"
          placeholder="https://example.com/webhooks/surveys"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <TextField
          label="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Events</legend>
          {WEBHOOK_EVENTS.map((event) => (
            <Checkbox
              key={event}
              label={<code>{event}</code>}
              checked={events.has(event)}
              onChange={() =>
                setEvents((current) => {
                  const next = new Set(current);
                  if (next.has(event)) next.delete(event);
                  else next.add(event);
                  return next;
                })
              }
            />
          ))}
        </fieldset>
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      </div>
    </Dialog>
  );
}

const DELIVERY_TONE = {
  pending: 'bg-amber-100 text-amber-900',
  succeeded: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
} as const;

function DeliveriesDialog({ webhook, onClose }: { webhook: Webhook; onClose: () => void }) {
  const queryClient = useQueryClient();
  const deliveries = useQuery({
    queryKey: ['deliveries', webhook.id],
    queryFn: () => get<PageResult<WebhookDelivery>>(`/webhooks/${webhook.id}/deliveries?limit=50`),
  });
  const [open, setOpen] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ['delivery', open],
    queryFn: () => get<WebhookDeliveryDetail>(`/webhooks/${webhook.id}/deliveries/${open}`),
    enabled: open !== null,
  });
  const redeliver = useMutation({
    mutationFn: (id: string) => post(`/webhooks/${webhook.id}/deliveries/${id}/redeliver`),
    onSuccess: () => {
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['deliveries', webhook.id] }), 1500);
      void queryClient.invalidateQueries({ queryKey: ['delivery', open] });
    },
  });
  return (
    <Dialog open onClose={onClose} title="Deliveries" wide>
      <p className="mb-3 truncate text-sm text-muted">{webhook.url}</p>
      {redeliver.error ? (
        <Alert tone="error" className="mb-3">
          {errorMessage(redeliver.error)}
        </Alert>
      ) : null}
      {deliveries.data?.data.length === 0 ? <p className="text-sm text-muted">Nothing sent yet.</p> : null}
      <ul className="divide-y divide-line text-sm">
        {(deliveries.data?.data ?? []).map((d) => (
          <li key={d.id} className="py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={DELIVERY_TONE[d.status]}>{d.status}</Badge>
              <code className="text-xs">{d.eventType}</code>
              <span className="text-xs text-muted">
                {relativeTime(d.createdAt)} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                {d.httpStatus ? ` · HTTP ${d.httpStatus}` : ''}
                {d.nextAttemptAt ? ` · next try ${formatDateTime(d.nextAttemptAt)}` : ''}
              </span>
              <span className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={open === d.id}
                  onClick={() => setOpen(open === d.id ? null : d.id)}
                >
                  {open === d.id ? 'Hide' : 'Details'}
                </Button>
                {d.status !== 'pending' ? (
                  <Button
                    size="sm"
                    busy={redeliver.isPending && redeliver.variables === d.id}
                    onClick={() => redeliver.mutate(d.id)}
                  >
                    Redeliver
                  </Button>
                ) : null}
              </span>
            </div>
            {open === d.id && detail.data ? (
              <div className="mt-2 flex flex-col gap-2">
                <table className="w-full text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th scope="col" className="text-left font-medium">
                        Attempt
                      </th>
                      <th scope="col" className="text-left font-medium">
                        When
                      </th>
                      <th scope="col" className="text-left font-medium">
                        Result
                      </th>
                      <th scope="col" className="text-right font-medium">
                        Time
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.attemptLog.map((a) => (
                      <tr key={a.attempt}>
                        <td>
                          {a.attempt}
                          {a.manual ? ' (manual)' : ''}
                        </td>
                        <td>{formatDateTime(a.createdAt)}</td>
                        <td>{a.error ?? `HTTP ${a.httpStatus}`}</td>
                        <td className="text-right">{a.durationMs} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2 text-xs">
                  {JSON.stringify(detail.data.payload, null, 2)}
                </pre>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
