/**
 * Phase 3B: privacy requests (GDPR/CCPA). Export or erase everything this organization holds about one
 * email address. Anonymous responses can't be found, by design.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrivacyRequest } from '@survey/contracts';
import { ApiError, errorMessage, get, post } from '../api';
import { Alert, Badge, Button, Card, Dialog, PageHeader, TextField } from '../components/ui';
import { formatDateTime } from '../lib/format';

/** In this order; `[singular, plural]`. */
const RESULT_LABELS: [string, string, string][] = [
  ['contacts', 'contact', 'contacts'],
  ['campaignMessages', 'campaign email', 'campaign emails'],
  ['responses', 'response', 'responses'],
  ['files', 'uploaded file', 'uploaded files'],
  ['aiSummaries', 'AI summary', 'AI summaries'],
];
const describeResult = (result: Record<string, number>) =>
  RESULT_LABELS.filter(([key]) => key in result)
    .map(([key, one, many]) => `${result[key]} ${result[key] === 1 ? one : many}`)
    .join(', ');

export function PrivacyRequestsPage() {
  const queryClient = useQueryClient();
  const requests = useQuery({
    queryKey: ['privacy-requests'],
    queryFn: () => get<{ data: PrivacyRequest[] }>('/privacy/requests'),
    refetchInterval: (q) => (q.state.data?.data.some((r) => r.status === 'pending') ? 2000 : false),
  });
  const [email, setEmail] = useState('');
  const [erasing, setErasing] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['privacy-requests'] });
  const create = useMutation({
    mutationFn: (kind: 'export' | 'erase') => post<PrivacyRequest>('/privacy/requests', { subjectEmail: email, kind, ...(kind === 'erase' ? { confirmEmail } : {}) }),
    onSuccess: () => {
      setErasing(false);
      setConfirmEmail('');
      setFields({});
      reload();
    },
    onError: (e) => setFields(e instanceof ApiError ? e.fieldErrors() : {}),
  });

  return (
    <>
      <PageHeader
        title="Privacy requests"
        description="Answer a person's request to see or delete their data. Searches contacts, campaign emails and responses linked to an email address."
      />
      <div className="grid max-w-4xl gap-6">
        <Card title="New request">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate('export');
            }}
          >
            <TextField label="Email address" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={fields.subjectEmail} />
            <p className="text-xs text-muted">
              Found: contacts with this email, campaign emails sent to them, and responses through their personal link, a signed-in account, an answer
              or a hidden field equal to the address. Responses to anonymous surveys aren't linked to anyone, so they can't be found.
            </p>
            {create.error && !Object.keys(fields).length ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="primary" busy={create.isPending && create.variables === 'export'} disabled={!email.trim()}>
                Export their data
              </Button>
              <Button variant="danger" disabled={!email.trim()} onClick={() => setErasing(true)}>
                Erase their data…
              </Button>
            </div>
          </form>
        </Card>
        <Card title="Requests">
          {requests.data?.data.length === 0 ? <p className="text-sm text-muted">No requests yet.</p> : null}
          <ul className="flex flex-col divide-y divide-line">
            {requests.data?.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {r.kind === 'export' ? 'Export' : 'Erasure'} for <span className="break-all">{r.subjectEmail}</span>
                    <Badge className={r.status === 'done' ? 'bg-green-100 text-green-800' : r.status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-700'}>
                      {r.status === 'pending' ? 'Working…' : r.status === 'done' ? 'Done' : 'Failed'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted">
                    {formatDateTime(r.createdAt)}
                    {r.requestedBy ? ` · by ${r.requestedBy}` : ''}
                  </p>
                  {r.status === 'done' ? (
                    <p className="mt-1 text-sm">
                      {r.kind === 'export' ? 'Found ' : 'Removed '}
                      {describeResult(r.result)}.
                    </p>
                  ) : null}
                  {r.failure ? <p className="mt-1 text-sm text-red-700">{r.failure}</p> : null}
                </div>
                {r.downloadUrl ? (
                  <a className="inline-flex h-8 items-center rounded-lg border border-line bg-white px-3 text-sm font-medium hover:bg-gray-50" href={r.downloadUrl}>
                    Download (JSON)
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Export files are kept for 7 days. Requests and their counts stay as a record; the audit log never stores the address.</p>
        </Card>
      </div>
      <Dialog
        open={erasing}
        onClose={() => setErasing(false)}
        title="Erase this person's data?"
        footer={
          <>
            <Button onClick={() => setErasing(false)}>Cancel</Button>
            <Button variant="danger" busy={create.isPending && create.variables === 'erase'} disabled={confirmEmail.trim().toLowerCase() !== email.trim().toLowerCase()} onClick={() => create.mutate('erase')}>
              Erase for good
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>
            Contacts, campaign emails and responses linked to <strong className="break-all">{email}</strong> will be deleted, with their answers and files.
            This can't be undone. Results update straight away.
          </p>
          <TextField label="Type the email address again to confirm" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} error={fields.confirmEmail} />
        </div>
      </Dialog>
    </>
  );
}
