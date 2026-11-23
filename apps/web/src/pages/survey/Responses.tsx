import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageResult, ResponseDetail, ResponseSummary } from '@survey/contracts';
import { del, errorMessage, get } from '../../api';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  SelectField,
} from '../../components/ui';
import { formatDateTime, formatDuration } from '../../lib/format';
import { useSurvey } from './SurveyLayout';

const STATUS_LABEL = {
  completed: 'Completed',
  in_progress: 'In progress',
  disqualified: 'Screened out',
} as const;

const FLAG_LABEL: Record<string, { label: string; hint: string }> = {
  too_fast: { label: 'Too fast', hint: 'Answered in under 1.5 seconds per question.' },
  straight_lined: { label: 'Straight-lined', hint: 'Gave the same answer to every row of a matrix or a run of scale questions.' },
  malware: { label: 'Malware', hint: 'An uploaded file contained malware and was quarantined.' },
};

function Flags({ flags }: { flags: string[] }) {
  return (
    <>
      {flags.map((f) => (
        <Badge key={f} className="ml-1 bg-amber-100 text-amber-900">
          <span title={FLAG_LABEL[f]?.hint}>⚑ {FLAG_LABEL[f]?.label ?? f}</span>
        </Badge>
      ))}
    </>
  );
}

export function ResponsesPage() {
  const { survey } = useSurvey();
  const [status, setStatus] = useState<'all' | 'completed' | 'in_progress' | 'disqualified'>('all');
  const [includeTest, setIncludeTest] = useState(false);
  const [flag, setFlag] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['responses', survey.id, status, includeTest, flag],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ status, limit: '50' });
      if (includeTest) p.set('includeTest', 'true');
      if (flag) p.set('flag', flag);
      if (pageParam) p.set('cursor', pageParam);
      return get<PageResult<ResponseSummary>>(`/surveys/${survey.id}/responses?${p}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <option value="all">All responses</option>
          <option value="completed">Completed</option>
          <option value="in_progress">In progress</option>
          <option value="disqualified">Screened out</option>
        </SelectField>
        <SelectField label="Quality" value={flag} onChange={(e) => setFlag(e.target.value)}>
          <option value="">Any</option>
          {Object.entries(FLAG_LABEL).map(([key, f]) => (
            <option key={key} value={key}>
              Flagged: {f.label.toLowerCase()}
            </option>
          ))}
        </SelectField>
        <Checkbox
          className="pb-2"
          label="Include test responses"
          checked={includeTest}
          onChange={(e) => setIncludeTest(e.target.checked)}
        />
      </div>
      {query.error ? <Alert tone="error">{errorMessage(query.error)}</Alert> : null}
      {query.isPending ? <p className="text-sm text-muted">Loading…</p> : null}
      {!query.isPending && rows.length === 0 ? (
        <EmptyState title="No responses yet">
          Responses appear here as soon as people start the survey.
        </EmptyState>
      ) : null}
      {rows.length ? (
        <div className="overflow-x-auto rounded-xl border border-line bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-gray-50 text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Started
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Time taken
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                  Link
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                  Device
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Preview
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3">
                    <Link to={r.id} className="font-medium text-brand-600 hover:underline">
                      {formatDateTime(r.startedAt)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {STATUS_LABEL[r.status]} {r.isTest ? <Badge>Test</Badge> : null}
                    <span className="ml-1 text-xs text-muted">v{r.versionNumber}</span>
                    <Flags flags={r.qualityFlags} />
                  </td>
                  <td className="tabular px-4 py-3">{formatDuration(r.durationSec)}</td>
                  <td className="hidden px-4 py-3 text-muted md:table-cell">{r.distributionName ?? '-'}</td>
                  <td className="hidden px-4 py-3 capitalize text-muted md:table-cell">
                    {r.deviceType ?? '-'}
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-muted">{r.preview || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {query.hasNextPage ? (
        <Button
          className="self-center"
          busy={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}

function FileLink({ file }: { file: ResponseDetail['files'][number] }) {
  const size = file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1048576).toFixed(1)} MB`;
  if (file.scanStatus === 'clean')
    return (
      <a className="text-brand-600 underline" href={`/api/v1/files/${file.id}`} download={file.filename}>
        {file.filename} <span className="text-muted">({size})</span>
      </a>
    );
  return (
    <span>
      {file.filename} <span className="text-muted">({size})</span>{' '}
      {file.scanStatus === 'pending' ? (
        <Badge>Checking for malware…</Badge>
      ) : file.scanStatus === 'infected' ? (
        <Badge className="bg-red-100 text-red-800">Quarantined: contains malware</Badge>
      ) : (
        <Badge className="bg-amber-100 text-amber-900">Couldn't be checked, so it can't be downloaded</Badge>
      )}
    </span>
  );
}

export function ResponseDetailPage() {
  const { survey } = useSurvey();
  const { responseId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['response', responseId],
    queryFn: () => get<ResponseDetail>(`/surveys/${survey.id}/responses/${responseId}`),
  });
  const r = query.data;
  const canDelete = survey.myRole !== 'viewer';

  const remove = async () => {
    setDeleting(true);
    try {
      await del(`/surveys/${survey.id}/responses/${responseId}`);
      await queryClient.invalidateQueries({ queryKey: ['responses', survey.id] });
      await queryClient.invalidateQueries({ queryKey: ['results', survey.id] });
      navigate('..', { relative: 'path' });
    } catch (e) {
      setError(errorMessage(e));
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Link to=".." relative="path" className="text-sm text-muted hover:text-ink">
        ← All responses
      </Link>
      {query.error ? <Alert tone="error">{errorMessage(query.error)}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {r ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          <Card title="Answers">
            {r.answers.length === 0 ? <p className="text-sm text-muted">No answers saved yet.</p> : null}
            <dl className="flex flex-col divide-y divide-line">
              {r.answers.map((a) => {
                const files = r.files.filter((f) => f.questionKey === a.questionKey);
                return (
                  <div key={a.questionKey} className="py-3">
                    <dt className="text-sm font-medium">{a.title}</dt>
                    {files.length ? (
                      <dd className="mt-1 flex flex-col gap-1 text-sm">
                        {files.map((f) => (
                          <FileLink key={f.id} file={f} />
                        ))}
                      </dd>
                    ) : (
                      <dd className="mt-1 whitespace-pre-wrap text-sm text-ink">{a.display}</dd>
                    )}
                  </div>
                );
              })}
            </dl>
          </Card>
          <div className="flex flex-col gap-4">
            <Card title="Details">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted">Status</dt>
                <dd>
                  {STATUS_LABEL[r.status]} {r.isTest ? <Badge>Test</Badge> : null}
                </dd>
                {r.qualityFlags.length ? (
                  <>
                    <dt className="text-muted">Quality</dt>
                    <dd>
                      {r.qualityFlags.map((f) => (
                        <div key={f}>
                          <strong>{FLAG_LABEL[f]?.label ?? f}</strong>: {FLAG_LABEL[f]?.hint}
                        </div>
                      ))}
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted">Started</dt>
                <dd>{formatDateTime(r.startedAt)}</dd>
                <dt className="text-muted">Completed</dt>
                <dd>{formatDateTime(r.completedAt)}</dd>
                <dt className="text-muted">Time taken</dt>
                <dd>{formatDuration(r.durationSec)}</dd>
                <dt className="text-muted">Version</dt>
                <dd>{r.versionNumber}</dd>
                <dt className="text-muted">Link</dt>
                <dd>{r.distributionName ?? '-'}</dd>
                <dt className="text-muted">Device</dt>
                <dd className="capitalize">{r.deviceType ?? '-'}</dd>
                {Object.entries(r.hiddenFields).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted">{k}</dt>
                    <dd className="break-all">{v}</dd>
                  </div>
                ))}
              </dl>
              {survey.anonymous ? (
                <p className="mt-3 text-xs text-muted">Anonymous survey: times are rounded to the hour.</p>
              ) : null}
            </Card>
            {canDelete ? (
              <Button variant="danger" onClick={() => setConfirming(true)}>
                Delete response
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="Delete this response?"
        message="The response and all its answers are permanently deleted and removed from results. This can't be undone."
        confirmLabel="Delete permanently"
        danger
        busy={deleting}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
