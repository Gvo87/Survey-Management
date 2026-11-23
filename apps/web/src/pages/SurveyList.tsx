import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { PageResult, SurveyDetail, SurveyStatus, SurveySummary } from '@survey/contracts';
import { errorMessage, get, post } from '../api';
import { useOrgRole } from '../auth';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  PageHeader,
  StatusBadge,
  TextField,
} from '../components/ui';
import { formatNumber, relativeTime } from '../lib/format';

export function SurveyListPage() {
  const role = useOrgRole();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<SurveyStatus | ''>('');
  const [creating, setCreating] = useState(false);

  const query = useInfiniteQuery({
    queryKey: ['surveys', q, status],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      if (pageParam) params.set('cursor', pageParam);
      return get<PageResult<SurveySummary>>(`/surveys?${params}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const surveys = query.data?.pages.flatMap((p) => p.data) ?? [];
  const canCreate = role === 'org_admin' || role === 'creator';
  const open = (s: SurveySummary) =>
    s.myRole === 'viewer' ? `/surveys/${s.id}/results` : `/surveys/${s.id}/edit`;

  return (
    <>
      <PageHeader
        title="Surveys"
        description={
          role === 'org_admin'
            ? 'Every survey in your organization.'
            : 'Surveys you own or that were shared with you.'
        }
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New survey
            </Button>
          ) : null
        }
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="flex-1">
          <span className="sr-only">Search surveys</span>
          <input
            type="search"
            placeholder="Search by title"
            className="w-full max-w-sm rounded-lg border border-line bg-white px-3 py-2 text-sm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Status</span>
          <select
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as SurveyStatus | '')}
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="live">Live</option>
            <option value="closed">Closed</option>
            <option value="archived">Archived</option>
          </select>
        </label>
      </div>

      {query.error ? <Alert tone="error">{errorMessage(query.error)}</Alert> : null}
      {query.isPending ? <p className="text-sm text-muted">Loading surveys…</p> : null}
      {!query.isPending && surveys.length === 0 ? (
        <EmptyState
          title={q || status ? 'No surveys match' : 'No surveys yet'}
          action={
            canCreate && !q && !status ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create your first survey
              </Button>
            ) : null
          }
        >
          {!canCreate && !q && !status ? 'Surveys shared with you will appear here.' : null}
        </EmptyState>
      ) : null}

      {surveys.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-line bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-gray-50 text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Title
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Responses
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                  Owner
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {surveys.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={open(s)} className="font-medium text-ink hover:text-brand-600">
                      {s.title}
                    </Link>
                    <div className="mt-0.5 flex gap-2 text-xs text-muted">
                      {s.currentVersionNumber ? (
                        <span>Version {s.currentVersionNumber}</span>
                      ) : (
                        <span>Not published</span>
                      )}
                      {s.hasDraft && s.currentVersionNumber ? <Badge>Unpublished changes</Badge> : null}
                      {s.myRole !== 'owner' ? (
                        <span>· You can {s.myRole === 'viewer' ? 'view' : 'edit'}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="tabular px-4 py-3 text-right">{formatNumber(s.completedCount)}</td>
                  <td className="hidden px-4 py-3 text-muted md:table-cell">{s.owner?.name ?? '-'}</td>
                  <td className="hidden px-4 py-3 text-muted md:table-cell">{relativeTime(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {query.hasNextPage ? (
        <div className="mt-4 text-center">
          <Button onClick={() => void query.fetchNextPage()} busy={query.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      ) : null}

      <NewSurveyDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(s) => navigate(`/surveys/${s.id}/edit`)}
      />
    </>
  );
}

function NewSurveyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (s: SurveyDetail) => void;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (!title.trim()) return setError('Give your survey a title.');
    setBusy(true);
    try {
      onCreated(await post<SurveyDetail>('/surveys', { title }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New survey"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void create()}>
            Create survey
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <TextField
          label="Title"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={error ?? undefined}
          placeholder="e.g. Customer satisfaction, Q1"
        />
      </form>
    </Dialog>
  );
}
