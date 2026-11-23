/**
 * Email campaigns and the embed snippet (Phase 2B), on the survey's Distribute page.
 */
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Campaign, CampaignRecipient, ContactList, Distribution, PageResult, SurveyDetail } from '@survey/contracts';
import { del, errorMessage, get, patch, post } from '../../api';
import { useOrgRole } from '../../auth';
import { Alert, Badge, Button, Card, Checkbox, CopyButton, Dialog, SelectField, TextArea, TextField } from '../../components/ui';
import { formatDateTime, formatNumber } from '../../lib/format';

const STATUS: Record<Campaign['status'], { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-gray-100 text-gray-700' },
  scheduled: { label: 'Scheduled', className: 'bg-brand-50 text-brand-700' },
  sending: { label: 'Sending', className: 'bg-amber-100 text-amber-900' },
  sent: { label: 'Sent', className: 'bg-green-100 text-green-800' },
  cancelled: { label: 'Cancelled', className: 'bg-gray-200 text-gray-600' },
};

export function CampaignsCard({ survey }: { survey: SurveyDetail }) {
  const role = useOrgRole();
  const canManage = role !== 'analyst' && survey.myRole !== 'viewer';
  const queryClient = useQueryClient();
  const campaigns = useQuery({
    queryKey: ['campaigns', survey.id],
    queryFn: () => get<Campaign[]>(`/surveys/${survey.id}/campaigns`),
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'sending' || c.status === 'scheduled') ? 5000 : false),
  });
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const [sending, setSending] = useState<Campaign | null>(null);
  const [viewing, setViewing] = useState<Campaign | null>(null);
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['campaigns', survey.id] });
  const cancel = useMutation({ mutationFn: (c: Campaign) => post(`/campaigns/${c.id}/cancel`), onSuccess: reload });
  const remove = useMutation({ mutationFn: (c: Campaign) => del(`/campaigns/${c.id}`), onSuccess: reload });
  const failure = cancel.error ?? remove.error;

  return (
    <Card
      title="Email invitations"
      actions={
        canManage ? (
          <Button size="sm" onClick={() => setEditing('new')} disabled={!survey.publicUrl}>
            New campaign
          </Button>
        ) : null
      }
    >
      <p className="mb-4 text-sm text-muted">
        Send each contact a personal link: they can answer once, pick up where they left off on any device, and only people who
        haven't responded get reminders. Manage people on the{' '}
        <Link className="underline" to="/contacts">
          Contacts
        </Link>{' '}
        page.
      </p>
      {campaigns.error ? <Alert tone="error">{errorMessage(campaigns.error)}</Alert> : null}
      {failure ? <Alert tone="error">{errorMessage(failure)}</Alert> : null}
      {campaigns.data?.length === 0 ? <p className="text-sm text-muted">No campaigns yet.</p> : null}
      <ul className="flex flex-col divide-y divide-line">
        {(campaigns.data ?? []).map((c) => {
          const status = STATUS[c.status];
          const rate = c.counts.sent + c.counts.responded ? Math.round((c.counts.responded / (c.counts.sent + c.counts.responded)) * 100) : 0;
          return (
            <li key={c.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <Badge className={status.className}>{status.label}</Badge>
                <span className="text-xs text-muted">to {c.list?.name ?? 'a deleted list'}</span>
                {c.status === 'scheduled' && c.scheduledAt ? (
                  <span className="text-xs text-muted">
                    · sends {formatDateTime(c.scheduledAt)} ({c.timezone})
                  </span>
                ) : null}
              </div>
              {c.counts.total ? (
                <p className="text-sm text-muted">
                  {formatNumber(c.counts.sent + c.counts.responded)} sent · {formatNumber(c.counts.responded)} responded ({rate}%)
                  {c.counts.bounced ? ` · ${formatNumber(c.counts.bounced)} bounced` : ''}
                  {c.counts.suppressed ? ` · ${formatNumber(c.counts.suppressed)} skipped (unsubscribed or bounced)` : ''}
                  {c.counts.failed ? ` · ${formatNumber(c.counts.failed)} failed` : ''}
                  {c.counts.pending ? ` · ${formatNumber(c.counts.pending)} waiting` : ''}
                  {c.reminders ? ` · reminders after ${c.reminders.afterDays} days (up to ${c.reminders.max})` : ''}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {canManage && (c.status === 'draft' || c.status === 'scheduled') ? (
                  <>
                    <Button size="sm" onClick={() => setEditing(c)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => setSending(c)}>
                      {c.status === 'scheduled' ? 'Reschedule' : 'Send or schedule'}
                    </Button>
                  </>
                ) : null}
                {c.counts.total ? (
                  <Button size="sm" variant="ghost" onClick={() => setViewing(c)}>
                    Recipients
                  </Button>
                ) : null}
                {canManage && ['scheduled', 'sending'].includes(c.status) ? (
                  <Button size="sm" variant="ghost" busy={cancel.isPending && cancel.variables?.id === c.id} onClick={() => cancel.mutate(c)}>
                    Cancel
                  </Button>
                ) : null}
                {canManage && c.status === 'draft' ? (
                  <Button size="sm" variant="ghost" busy={remove.isPending && remove.variables?.id === c.id} onClick={() => remove.mutate(c)}>
                    Delete
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <CampaignDialog survey={survey} campaign={editing} onClose={() => setEditing(null)} onSaved={reload} />
      <SendDialog campaign={sending} onClose={() => setSending(null)} onSent={reload} />
      <RecipientsDialog campaign={viewing} onClose={() => setViewing(null)} />
    </Card>
  );
}

function CampaignDialog({ survey, campaign, onClose, onSaved }: { survey: SurveyDetail; campaign: Campaign | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const open = campaign !== null;
  const existing = campaign && campaign !== 'new' ? campaign : null;
  const lists = useQuery({ queryKey: ['contact-lists'], queryFn: () => get<ContactList[]>('/contact-lists'), enabled: open });
  const attributes = useQuery({ queryKey: ['contact-attributes'], queryFn: () => get<string[]>('/contacts/attributes'), enabled: open });
  const [form, setForm] = useState({ name: '', listId: '', subject: '', body: '', reminders: false, afterDays: 3, max: 1 });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const key = existing?.id ?? (open ? 'new' : null);
  if (open && loadedFor !== key) {
    setLoadedFor(key);
    setForm(
      existing
        ? {
            name: existing.name,
            listId: existing.list?.id ?? '',
            subject: existing.subject,
            body: existing.body,
            reminders: Boolean(existing.reminders),
            afterDays: existing.reminders?.afterDays ?? 3,
            max: existing.reminders?.max ?? 1,
          }
        : {
            name: `${survey.title} invitation`.slice(0, 100),
            listId: '',
            subject: `Your opinion on ${survey.title}`.slice(0, 200),
            body: `Hi {{contact.first_name|there}},\n\nWe'd love your feedback. It takes a few minutes:\n\n{{survey.link}}\n\nThank you!`,
            reminders: true,
            afterDays: 3,
            max: 1,
          },
    );
  }
  if (!open && loadedFor !== null) setLoadedFor(null);
  const caret = useRef<number | null>(null);
  const insert = (tag: string) => {
    const at = caret.current ?? form.body.length;
    setForm({ ...form, body: form.body.slice(0, at) + tag + form.body.slice(at) });
    caret.current = at + tag.length;
  };
  const save = useMutation({
    mutationFn: () => {
      const payload = { name: form.name, listId: form.listId, subject: form.subject, body: form.body, reminders: form.reminders ? { afterDays: form.afterDays, max: form.max } : null };
      return existing ? patch(`/campaigns/${existing.id}`, payload) : post(`/surveys/${survey.id}/campaigns`, payload);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const tags = ['contact.first_name|there', 'contact.last_name', 'contact.email', 'survey.title', 'survey.link', ...(attributes.data ?? []).map((a) => `contact.${a}`)];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={existing ? 'Edit campaign' : 'New email campaign'}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={!form.listId || !form.subject.trim() || !form.body.trim()} onClick={() => save.mutate()}>
            Save campaign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Campaign name" hint="Only you see this." value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <SelectField label="Send to list" value={form.listId} onChange={(e) => setForm({ ...form, listId: e.target.value })}>
            <option value="">Choose a list…</option>
            {(lists.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({formatNumber(l.memberCount)})
              </option>
            ))}
          </SelectField>
        </div>
        {lists.data?.length === 0 ? (
          <Alert tone="info">
            You have no contact lists yet.{' '}
            <Link className="underline" to="/contacts">
              Import contacts
            </Link>{' '}
            first.
          </Alert>
        ) : null}
        <TextField label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        <div className="flex flex-col gap-1">
          <TextArea
            label="Message"
            rows={8}
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            onSelect={(e) => {
              caret.current = e.currentTarget.selectionStart;
            }}
            onKeyUp={(e) => {
              caret.current = e.currentTarget.selectionStart;
            }}
            onClick={(e) => {
              caret.current = e.currentTarget.selectionStart;
            }}
            hint="Plain text. The personal survey link is added at the end if you don't place {{survey.link}} yourself. An unsubscribe link is always added."
          />
          <div className="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label="Insert a merge tag">
            <span className="text-muted">Insert:</span>
            {tags.map((t) => (
              <button key={t} type="button" className="rounded border border-line bg-white px-1.5 py-0.5 font-mono hover:border-brand-500" onClick={() => insert(`{{${t}}}`)}>
                {`{{${t}}}`}
              </button>
            ))}
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Reminders</legend>
          <Checkbox label="Remind people who haven't responded" checked={form.reminders} onChange={(e) => setForm({ ...form, reminders: e.target.checked })} />
          {form.reminders ? (
            <div className="grid gap-3 pl-6 sm:max-w-md sm:grid-cols-2">
              <TextField label="After (days)" type="number" min={1} max={60} value={form.afterDays} onChange={(e) => setForm({ ...form, afterDays: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })} />
              <TextField label="At most (reminders)" type="number" min={1} max={5} value={form.max} onChange={(e) => setForm({ ...form, max: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })} />
            </div>
          ) : null}
        </fieldset>
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      </div>
    </Dialog>
  );
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();

function SendDialog({ campaign, onClose, onSent }: { campaign: Campaign | null; onClose: () => void; onSent: () => void }) {
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [zone, setZone] = useState(browserZone());
  const zones = useMemo(() => (ZONES.includes(zone) ? ZONES : [zone, ...ZONES]), [zone]);
  const send = useMutation({
    mutationFn: () => post(`/campaigns/${campaign!.id}/send`, when === 'now' ? {} : { scheduledAt: at, timezone: zone }),
    onSuccess: () => {
      onSent();
      onClose();
    },
  });
  return (
    <Dialog
      open={campaign !== null}
      onClose={onClose}
      title="Send invitations"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={send.isPending} disabled={when === 'later' && !at} onClick={() => send.mutate()}>
            {when === 'now' ? 'Send now' : 'Schedule'}
          </Button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">When</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} />
          Send now
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} />
          Schedule for later
        </label>
        {when === 'later' ? (
          <div className="grid gap-3 pl-6">
            <TextField label="Date and time" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            <SelectField label="Time zone" value={zone} onChange={(e) => setZone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </SelectField>
          </div>
        ) : null}
      </fieldset>
      <p className="mt-3 text-xs text-muted">The contact list is read when sending starts. Unsubscribed and bounced addresses are skipped.</p>
      {send.error ? (
        <Alert tone="error" className="mt-3">
          {errorMessage(send.error)}
        </Alert>
      ) : null}
    </Dialog>
  );
}

const RECIPIENT_STATUS: Record<CampaignRecipient['status'], string> = {
  pending: 'Waiting',
  sent: 'Sent',
  responded: 'Responded',
  bounced: 'Bounced',
  failed: 'Failed',
  suppressed: 'Skipped',
};

function RecipientsDialog({ campaign, onClose }: { campaign: Campaign | null; onClose: () => void }) {
  const [status, setStatus] = useState('');
  const recipients = useInfiniteQuery({
    queryKey: ['recipients', campaign?.id, status],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (status) p.set('status', status);
      if (pageParam) p.set('cursor', pageParam);
      return get<PageResult<CampaignRecipient>>(`/campaigns/${campaign!.id}/recipients?${p}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: campaign !== null,
  });
  const rows = recipients.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Dialog open={campaign !== null} onClose={onClose} title={`Recipients: ${campaign?.name ?? ''}`} wide>
      <div className="flex flex-col gap-3">
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-xs">
          <option value="">All</option>
          {Object.entries(RECIPIENT_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
        {recipients.error ? <Alert tone="error">{errorMessage(recipients.error)}</Alert> : null}
        <div className="max-h-96 overflow-auto rounded-lg border border-line">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-gray-50 text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Contact
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Sent
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Reminders
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-3 py-2">
                    <div>{r.name || r.email}</div>
                    {r.name ? <div className="text-xs text-muted">{r.email}</div> : null}
                  </td>
                  <td className="px-3 py-2">
                    {RECIPIENT_STATUS[r.status]}
                    {r.error ? <div className="text-xs text-red-700">{r.error}</div> : null}
                  </td>
                  <td className="px-3 py-2 text-muted">{r.sentAt ? formatDateTime(r.sentAt) : '—'}</td>
                  <td className="px-3 py-2 text-muted">{r.remindersSent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {recipients.hasNextPage ? (
          <Button className="self-center" busy={recipients.isFetchingNextPage} onClick={() => void recipients.fetchNextPage()}>
            Load more
          </Button>
        ) : null}
        <p className="text-xs text-muted">In anonymous surveys you see who responded, but never which response is theirs.</p>
      </div>
    </Dialog>
  );
}

const RESPONDENT_ORIGIN = new URL((import.meta.env.VITE_RESPONDENT_URL as string | undefined) ?? 'http://localhost:5174').origin;

export function EmbedCard({ survey, links }: { survey: SurveyDetail; links: Distribution[] }) {
  const [mode, setMode] = useState<'inline' | 'popup'>('inline');
  const [linkId, setLinkId] = useState('');
  const [label, setLabel] = useState('Give feedback');
  const [delay, setDelay] = useState('');
  if (!survey.publicUrl) return null;
  const link = links.find((l) => l.id === linkId && !l.isDefault);
  const token = link ? new URL(link.url).searchParams.get('d') : null;
  const attrs = [`data-survey="${survey.publicId}"`, `data-mode="${mode}"`, token ? `data-link="${token}"` : null, `data-title="${survey.title.replace(/"/g, '&quot;')}"`, mode === 'popup' && delay ? `data-open-after="${delay}"` : null]
    .filter(Boolean)
    .join(' ');
  const element = mode === 'inline' ? `<div ${attrs}></div>` : `<button type="button" ${attrs}>${label.replace(/[<>&]/g, '')}</button>`;
  const snippet = `${element}\n<script src="${RESPONDENT_ORIGIN}/embed.js" async></script>`;
  return (
    <Card title="Embed on a website">
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Show as" value={mode} onChange={(e) => setMode(e.target.value as 'inline' | 'popup')}>
            <option value="inline">Inline, in the page</option>
            <option value="popup">Popup, from a button</option>
          </SelectField>
          <SelectField label="Count responses under" value={linkId} onChange={(e) => setLinkId(e.target.value)}>
            <option value="">The default link</option>
            {links
              .filter((l) => !l.isDefault && !l.disabledAt && l.name && !l.name.startsWith('Email:'))
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </SelectField>
          {mode === 'popup' ? (
            <>
              <TextField label="Button text" value={label} onChange={(e) => setLabel(e.target.value)} />
              <TextField label="Also open by itself after (seconds)" type="number" min={1} max={600} placeholder="Off" value={delay} onChange={(e) => setDelay(e.target.value)} />
            </>
          ) : null}
        </div>
        <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 text-xs">
          <code>{snippet}</code>
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={snippet} label="Copy snippet" />
        </div>
        <p className="text-xs text-muted">
          The survey runs in an iframe, so the website's styles and scripts can't affect it. On sites with a Content-Security-Policy,
          allow <code>{RESPONDENT_ORIGIN}</code> in <code>script-src</code> and <code>frame-src</code>.
        </p>
      </div>
    </Card>
  );
}
