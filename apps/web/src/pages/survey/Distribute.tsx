import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Distribution, SurveyDetail } from '@survey/contracts';
import { errorMessage, get, patch, post } from '../../api';
import { Alert, Badge, Button, Card, Checkbox, CopyButton, Dialog, TextField } from '../../components/ui';
import { formatDateTime, formatNumber } from '../../lib/format';
import { useSurvey } from './SurveyLayout';

export function DistributePage() {
  const { survey, refresh } = useSurvey();
  const queryClient = useQueryClient();
  const links = useQuery({
    queryKey: ['distributions', survey.id],
    queryFn: () => get<Distribution[]>(`/surveys/${survey.id}/distributions`),
  });
  const [qrFor, setQrFor] = useState<Distribution | null>(null);
  const [creating, setCreating] = useState(false);
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['distributions', survey.id] });

  const toggle = useMutation({
    mutationFn: (d: Distribution) => patch(`/distributions/${d.id}`, { disabled: !d.disabledAt }),
    onSuccess: reload,
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-6">
        {!survey.publicUrl ? (
          <Alert tone="info">
            Publish the survey to get a link you can share.{' '}
            <Link className="font-medium underline" to="../edit">
              Go to the builder
            </Link>
          </Alert>
        ) : null}
        <Card
          title="Links"
          actions={
            survey.publicUrl ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                New tracked link
              </Button>
            ) : null
          }
        >
          <p className="mb-4 text-sm text-muted">
            Create a separate link for each channel (newsletter, website, QR poster) to see where responses
            come from. Preset values are stored with every response from that link.
          </p>
          {links.error ? <Alert tone="error">{errorMessage(links.error)}</Alert> : null}
          <ul className="flex flex-col divide-y divide-line">
            {(links.data ?? []).map((d) => (
              <li key={d.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.name}</span>
                  {d.isDefault ? <Badge>Default</Badge> : null}
                  {d.disabledAt ? <Badge className="bg-red-100 text-red-800">Disabled</Badge> : null}
                  <span className="ml-auto text-sm text-muted">
                    {formatNumber(d.responseCount)} responses
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-gray-50 px-2 py-1 text-xs">
                    {d.url}
                  </code>
                  {survey.publicUrl ? (
                    <>
                      <CopyButton text={d.url} />
                      <Button size="sm" onClick={() => setQrFor(d)}>
                        QR code
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={toggle.isPending && toggle.variables?.id === d.id}
                    onClick={() => toggle.mutate(d)}
                  >
                    {d.disabledAt ? 'Enable' : 'Disable'}
                  </Button>
                </div>
                {Object.keys(d.presetHiddenFields).length ? (
                  <p className="text-xs text-muted">
                    Presets:{' '}
                    {Object.entries(d.presetHiddenFields)
                      .map(([k, v]) => `${k} = ${v}`)
                      .join(', ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
        <HiddenFieldsHelp survey={survey} />
      </div>
      <AccessSettings survey={survey} onSaved={refresh} />
      <QrDialog distribution={qrFor} onClose={() => setQrFor(null)} />
      <NewLinkDialog
        open={creating}
        surveyId={survey.id}
        onClose={() => setCreating(false)}
        onCreated={reload}
      />
    </div>
  );
}

function HiddenFieldsHelp({ survey }: { survey: SurveyDetail }) {
  if (!survey.publicUrl) return null;
  return (
    <Card title="Passing data in the link">
      <p className="text-sm text-muted">
        Add declared hidden fields to any link, for example{' '}
        <code className="rounded bg-gray-50 px-1">{survey.publicUrl}?source=email</code>. Declare them in the
        builder under <em>Survey settings</em>; undeclared parameters are ignored.
      </p>
    </Card>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function AccessSettings({ survey, onSaved }: { survey: SurveyDetail; onSaved: () => void }) {
  const [opensAt, setOpensAt] = useState(toLocalInput(survey.access.opensAt));
  const [closesAt, setClosesAt] = useState(toLocalInput(survey.access.closesAt));
  const [quota, setQuota] = useState(survey.access.quota?.toString() ?? '');
  const [onePerBrowser, setOnePerBrowser] = useState(survey.access.onePerBrowser);
  const [captcha, setCaptcha] = useState(survey.access.captcha);
  const [anonymous, setAnonymous] = useState(survey.anonymous);
  // Write-only: '' keeps the current password; `null` removes it.
  const [password, setPassword] = useState<string | null>('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    setOpensAt(toLocalInput(survey.access.opensAt));
    setClosesAt(toLocalInput(survey.access.closesAt));
    setQuota(survey.access.quota?.toString() ?? '');
    setOnePerBrowser(survey.access.onePerBrowser);
    setCaptcha(survey.access.captcha);
    setAnonymous(survey.anonymous);
    setPassword('');
  }, [survey]);
  const passwordTooShort = typeof password === 'string' && password.length > 0 && password.length < 4;

  const save = useMutation({
    mutationFn: () =>
      patch<SurveyDetail>(`/surveys/${survey.id}`, {
        access: {
          opensAt: opensAt ? new Date(opensAt).toISOString() : null,
          closesAt: closesAt ? new Date(closesAt).toISOString() : null,
          quota: quota ? Number(quota) : null,
          onePerBrowser,
          captcha,
          ...(password === null || password ? { password } : {}),
        },
        ...(anonymous !== survey.anonymous ? { anonymous } : {}),
      }),
    onSuccess: () => {
      setMessage({ tone: 'success', text: 'Saved.' });
      onSaved();
    },
    onError: (e) => setMessage({ tone: 'error', text: errorMessage(e) }),
  });
  const status = useMutation({
    mutationFn: (action: 'close' | 'reopen') => post<SurveyDetail>(`/surveys/${survey.id}/${action}`),
    onSuccess: () => {
      setMessage(null);
      onSaved();
    },
    onError: (e) => setMessage({ tone: 'error', text: errorMessage(e) }),
  });
  const locked = survey.responseCount > 0;

  return (
    <div className="flex flex-col gap-6">
      <Card title="Collecting responses">
        <div className="flex flex-col gap-3 text-sm">
          <p>
            {survey.status === 'live'
              ? 'Accepting responses.'
              : survey.status === 'draft'
                ? 'Not published yet.'
                : 'Not accepting new responses.'}
            {survey.closedReason === 'quota' ? ' The response limit was reached.' : null}
            {survey.closedReason === 'close_date' ? ' The close date has passed.' : null}
          </p>
          {survey.status === 'live' ? (
            <Button busy={status.isPending} onClick={() => status.mutate('close')}>
              Close survey
            </Button>
          ) : survey.status !== 'draft' ? (
            <Button variant="primary" busy={status.isPending} onClick={() => status.mutate('reopen')}>
              Reopen survey
            </Button>
          ) : null}
          <p className="text-xs text-muted">
            People who already started can finish within 24 hours of closing.
          </p>
        </div>
      </Card>
      <Card title="Access">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setMessage(null);
            if (!passwordTooShort) save.mutate();
          }}
        >
          <TextField
            label="Open on"
            type="datetime-local"
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
            hint="Your local time. Before then, the link shows when the survey opens. Leave empty to open now."
          />
          <TextField
            label="Close automatically on"
            type="datetime-local"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
            hint="Your local time. Leave empty to keep it open."
          />
          <TextField
            label="Response limit"
            type="number"
            min={1}
            value={quota}
            onChange={(e) => setQuota(e.target.value)}
            hint={`Closes after this many completed responses. Currently ${formatNumber(survey.completedCount)}.`}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-ink">Password</legend>
            {survey.access.passwordEnabled && password === '' ? (
              <p className="text-sm">
                Respondents need a password to open this survey.{' '}
                <Button size="sm" variant="ghost" onClick={() => setPassword(null)}>
                  Remove password
                </Button>
              </p>
            ) : null}
            {password === null ? (
              <p className="text-sm">
                The password will be removed when you save.{' '}
                <Button size="sm" variant="ghost" onClick={() => setPassword('')}>
                  Undo
                </Button>
              </p>
            ) : (
              <TextField
                label={survey.access.passwordEnabled ? 'New password' : 'Require a password (optional)'}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={passwordTooShort ? 'Use at least 4 characters.' : undefined}
                hint={
                  survey.access.passwordEnabled
                    ? 'Leave empty to keep the current password. Changing it signs out everyone who entered the old one.'
                    : 'Share it with respondents separately. It is stored hashed, so it cannot be shown again.'
                }
              />
            )}
          </fieldset>
          <Checkbox
            label="Ask respondents to prove they're human (CAPTCHA)"
            hint="Uses Cloudflare Turnstile, usually without a puzzle. Helps against bots on public links."
            checked={captcha}
            onChange={(e) => setCaptcha(e.target.checked)}
          />
          <Checkbox
            label="One response per browser"
            hint="Best effort: stops casual repeat submissions, but clearing the browser's data gets around it."
            checked={onePerBrowser}
            onChange={(e) => setOnePerBrowser(e.target.checked)}
          />
          <Checkbox
            label="Anonymous responses"
            hint={
              locked
                ? "Can't be changed after responses have been collected. Duplicate the survey instead."
                : 'No identifying data is stored: no email questions, hidden fields only if non-identifying, times rounded to the hour.'
            }
            checked={anonymous}
            disabled={locked}
            onChange={(e) => setAnonymous(e.target.checked)}
          />
          {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save access settings
          </Button>
        </form>
      </Card>
      {survey.testUrl ? (
        <Card title="Test link">
          <p className="mb-3 text-sm text-muted">
            Responses from this link are marked as tests and left out of results unless you include them.
          </p>
          <CopyButton text={survey.testUrl} label="Copy test link" />
        </Card>
      ) : null}
      {survey.access.closesAt ? (
        <p className="text-xs text-muted">Closes {formatDateTime(survey.access.closesAt)}</p>
      ) : null}
    </div>
  );
}

function QrDialog({ distribution, onClose }: { distribution: Distribution | null; onClose: () => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [png, setPng] = useState<string | null>(null);
  useEffect(() => {
    setSvg(null);
    setPng(null);
    if (!distribution) return;
    void import('qrcode').then(async (QR) => {
      setSvg(await QR.toString(distribution.url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
      setPng(await QR.toDataURL(distribution.url, { width: 1024, margin: 2, errorCorrectionLevel: 'M' }));
    });
  }, [distribution]);
  const svgHref = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : undefined;
  return (
    <Dialog
      open={distribution !== null}
      onClose={onClose}
      title={`QR code: ${distribution?.name ?? ''}`}
      footer={
        <>
          <a
            className="inline-flex h-10 items-center rounded-lg border border-line px-4 text-sm font-medium"
            href={svgHref}
            download="survey-qr.svg"
          >
            Download SVG
          </a>
          <a
            className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white"
            href={png ?? undefined}
            download="survey-qr.png"
          >
            Download PNG
          </a>
        </>
      }
    >
      {svgHref ? (
        <img src={svgHref} alt={`QR code linking to ${distribution?.url}`} className="mx-auto w-64" />
      ) : (
        <p className="text-sm text-muted">Generating…</p>
      )}
      <p className="mt-2 break-all text-center text-xs text-muted">{distribution?.url}</p>
    </Dialog>
  );
}

function NewLinkDialog({
  open,
  surveyId,
  onClose,
  onCreated,
}: {
  open: boolean;
  surveyId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [presets, setPresets] = useState<{ key: string; value: string }[]>([]);
  const create = useMutation({
    mutationFn: () =>
      post(`/surveys/${surveyId}/distributions`, {
        channel: 'link',
        name,
        presetHiddenFields: Object.fromEntries(presets.filter((p) => p.key).map((p) => [p.key, p.value])),
      }),
    onSuccess: () => {
      onCreated();
      setName('');
      setPresets([]);
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New tracked link"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={!name.trim()}
            onClick={() => create.mutate()}
          >
            Create link
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Name"
          autoFocus
          placeholder="e.g. November newsletter"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Preset hidden fields (optional)</legend>
          {presets.map((p, i) => (
            <div key={i} className="flex items-end gap-2">
              <TextField
                label="Field"
                value={p.key}
                onChange={(e) =>
                  setPresets(
                    presets.map((x, j) =>
                      j === i ? { ...x, key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') } : x,
                    ),
                  )
                }
              />
              <TextField
                label="Value"
                value={p.value}
                onChange={(e) =>
                  setPresets(presets.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                }
              />
            </div>
          ))}
          <Button
            size="sm"
            className="self-start"
            onClick={() => setPresets([...presets, { key: 'source', value: '' }])}
          >
            Add preset
          </Button>
        </fieldset>
        {create.error ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
      </div>
    </Dialog>
  );
}
