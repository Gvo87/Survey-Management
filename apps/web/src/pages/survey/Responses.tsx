import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BulkDeleteResult, PageResult, ResponseDetail, ResponseSummary, Tag } from '@survey/contracts';
import { useAuth } from '../../auth';
import { del, errorMessage, get, post, put } from '../../api';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  SelectField,
  TextArea,
  TextField,
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
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const tags = useQuery({ queryKey: ['tags', survey.id], queryFn: () => get<Tag[]>(`/surveys/${survey.id}/tags`) });
  const query = useInfiniteQuery({
    queryKey: ['responses', survey.id, status, includeTest, flag, q, tag],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ status, limit: '50' });
      if (includeTest) p.set('includeTest', 'true');
      if (flag) p.set('flag', flag);
      if (q) p.set('q', q);
      if (tag) p.set('tag', tag);
      if (pageParam) p.set('cursor', pageParam);
      return get<PageResult<ResponseSummary> & { total?: number }>(`/surveys/${survey.id}/responses?${p}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const narrowed = Boolean(q || tag || flag || status !== 'all');
  const canDelete = survey.myRole !== 'viewer';
  const bulk = useMutation({
    mutationFn: () =>
      post<BulkDeleteResult>(`/surveys/${survey.id}/responses/bulk-delete`, {
        scope: { status, includeTest, ...(q ? { q } : {}), ...(tag ? { tag } : {}), ...(flag ? { flag } : {}) },
        expectedCount: total,
      }),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ['responses', survey.id] });
      void queryClient.invalidateQueries({ queryKey: ['results', survey.id] });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <TextField label="Search answers" type="search" className="min-w-56" placeholder="Words in open answers" value={text} onChange={(e) => setText(e.target.value)} />
        {tags.data?.length ? (
          <SelectField label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Any</option>
            {tags.data.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.responseCount})
              </option>
            ))}
          </SelectField>
        ) : null}
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
      {query.data ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted" aria-live="polite">
            {total.toLocaleString()} {total === 1 ? 'response' : 'responses'}
            {narrowed ? ' match' : ''}
          </span>
          {canDelete && narrowed && total > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Delete these {total.toLocaleString()}…
            </Button>
          ) : null}
        </div>
      ) : null}
      {bulk.error ? <Alert tone="error">{errorMessage(bulk.error)}</Alert> : null}
      {bulk.data ? <Alert tone="success">Deleted {bulk.data.deleted.toLocaleString()} responses. Results were updated.</Alert> : null}
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
                    {r.tags.map((t) => (
                      <Badge key={t.id} className="ml-1 bg-brand-50 text-brand-700">
                        {t.name}
                      </Badge>
                    ))}
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
      <ConfirmDialog
        open={confirming}
        title={`Delete ${total.toLocaleString()} responses?`}
        message="Every response that matches the current search and filters is permanently deleted with its answers, files, tags and notes, and removed from results. This can't be undone, and it's recorded in the audit log."
        confirmLabel={`Delete ${total.toLocaleString()} responses`}
        danger
        busy={bulk.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => bulk.mutate()}
      />
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
            <TagsCard surveyId={survey.id} responseId={r.id} tags={r.tags} onChange={() => void query.refetch()} />
            <NotesCard surveyId={survey.id} responseId={r.id} notes={r.notes} onChange={() => void query.refetch()} />
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
                {r.contact ? (
                  <>
                    <dt className="text-muted">Contact</dt>
                    <dd className="break-all">
                      {r.contact.name ? `${r.contact.name} · ` : ''}
                      {r.contact.email}
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

function TagsCard({ surveyId, responseId, tags, onChange }: { surveyId: string; responseId: string; tags: { id: string; name: string }[]; onChange: () => void }) {
  const queryClient = useQueryClient();
  const all = useQuery({ queryKey: ['tags', surveyId], queryFn: () => get<Tag[]>(`/surveys/${surveyId}/tags`) });
  const [name, setName] = useState('');
  const changed = () => {
    onChange();
    void queryClient.invalidateQueries({ queryKey: ['tags', surveyId] });
    void queryClient.invalidateQueries({ queryKey: ['responses', surveyId] });
  };
  const add = useMutation({
    mutationFn: async (tagName: string) => {
      const tag = await post<Tag>(`/surveys/${surveyId}/tags`, { name: tagName });
      await put(`/surveys/${surveyId}/responses/${responseId}/tags/${tag.id}`);
    },
    onSuccess: () => {
      setName('');
      changed();
    },
  });
  const remove = useMutation({ mutationFn: (tagId: string) => del(`/surveys/${surveyId}/responses/${responseId}/tags/${tagId}`), onSuccess: changed });
  const suggestions = (all.data ?? []).filter((t) => !tags.some((x) => x.id === t.id));
  return (
    <Card title="Tags">
      <ul className="mb-3 flex flex-wrap gap-2" aria-label="Tags on this response">
        {tags.length === 0 ? <li className="text-sm text-muted">No tags yet.</li> : null}
        {tags.map((t) => (
          <li key={t.id}>
            <Badge className="bg-brand-50 text-brand-700">
              {t.name}
              <button type="button" className="ml-1 rounded px-0.5 hover:bg-brand-100" aria-label={`Remove tag ${t.name}`} onClick={() => remove.mutate(t.id)}>
                ✕
              </button>
            </Badge>
          </li>
        ))}
      </ul>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add.mutate(name.trim());
        }}
      >
        <TextField label="Add a tag" className="min-w-0 flex-1" list={`tags-${responseId}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        <datalist id={`tags-${responseId}`}>
          {suggestions.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
        <Button type="submit" size="sm" className="mb-1" busy={add.isPending}>
          Add
        </Button>
      </form>
      {add.error || remove.error ? <p className="mt-2 text-sm text-red-700">{errorMessage(add.error ?? remove.error)}</p> : null}
    </Card>
  );
}

function NotesCard({ surveyId, responseId, notes, onChange }: { surveyId: string; responseId: string; notes: ResponseDetail['notes']; onChange: () => void }) {
  const { me } = useAuth();
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: () => post(`/surveys/${surveyId}/responses/${responseId}/notes`, { body }),
    onSuccess: () => {
      setBody('');
      onChange();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/surveys/${surveyId}/responses/${responseId}/notes/${id}`), onSuccess: onChange });
  const isAdmin = me?.activeOrg?.role === 'org_admin';
  return (
    <Card title="Notes">
      <p className="mb-3 text-xs text-muted">Visible to your team only, never to the respondent.</p>
      <ul className="mb-3 flex flex-col gap-3">
        {notes.map((n) => (
          <li key={n.id} className="rounded-lg bg-gray-50 p-3 text-sm">
            <p className="whitespace-pre-wrap">{n.body}</p>
            <p className="mt-1 flex items-center gap-2 text-xs text-muted">
              {n.author ?? 'Former member'} · {formatDateTime(n.createdAt)}
              {n.authorId === me?.user.id || isAdmin ? (
                <button type="button" className="underline" onClick={() => remove.mutate(n.id)}>
                  Delete
                </button>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) add.mutate();
        }}
      >
        <TextArea label="Add a note" rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
        <Button type="submit" size="sm" className="self-start" busy={add.isPending} disabled={!body.trim()}>
          Save note
        </Button>
      </form>
      {add.error ? <p className="mt-2 text-sm text-red-700">{errorMessage(add.error)}</p> : null}
    </Card>
  );
}
