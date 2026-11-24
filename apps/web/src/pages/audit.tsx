import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AuditEntry, Member, PageResult } from '@survey/contracts';
import { errorMessage, get } from '../api';
import { Alert, Button, PageHeader, SelectField, TextField } from '../components/ui';
import { formatDateTime } from '../lib/format';

interface Filters {
  action: string;
  actorId: string;
  entityType: string;
  entityId: string;
  from: string;
  to: string;
}
const EMPTY: Filters = { action: '', actorId: '', entityType: '', entityId: '', from: '', to: '' };

function toParams(f: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (f.action.trim()) params.set('action', f.action.trim());
  if (f.actorId) params.set('actorId', f.actorId);
  if (f.entityType) params.set('entityType', f.entityType);
  if (f.entityId.trim()) params.set('entityId', f.entityId.trim());
  if (f.from) params.set('from', new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) params.set('to', new Date(`${f.to}T23:59:59.999`).toISOString());
  return params;
}

const ENTITY_TYPES = ['survey', 'user', 'folder', 'team', 'webhook', 'api_key', 'campaign', 'file'];

/** Audit-log viewer (Phase 3A): org admins only. */
export function AuditLogPage() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const members = useQuery({ queryKey: ['members'], queryFn: () => get<PageResult<Member>>('/org/members') });
  const log = useInfiniteQuery({
    queryKey: ['audit', applied],
    queryFn: ({ pageParam }) => {
      const params = toParams(applied);
      params.set('limit', '50');
      if (pageParam) params.set('cursor', pageParam);
      return get<PageResult<AuditEntry>>(`/audit-logs?${params}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = log.data?.pages.flatMap((p) => p.data) ?? [];
  const set = (key: keyof Filters) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who did what, and when. Entries can't be changed or deleted."
        actions={
          <a
            href={`/api/v1/audit-logs/export.csv?${toParams(applied)}`}
            className="inline-flex h-8 items-center rounded-lg border border-line bg-white px-3 text-sm font-medium hover:bg-gray-50"
          >
            Export CSV
          </a>
        }
      />
      <form
        className="mb-4 grid gap-3 rounded-xl border border-line bg-white p-4 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
        }}
      >
        <TextField
          label="Action"
          placeholder="e.g. survey.published or survey"
          value={draft.action}
          onChange={set('action')}
        />
        <SelectField label="Who" value={draft.actorId} onChange={set('actorId')}>
          <option value="">Anyone</option>
          {(members.data?.data ?? []).map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Entity type" value={draft.entityType} onChange={set('entityType')}>
          <option value="">Any</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </SelectField>
        <TextField label="Entity ID" value={draft.entityId} onChange={set('entityId')} />
        <TextField label="From" type="date" value={draft.from} onChange={set('from')} />
        <TextField label="To" type="date" value={draft.to} onChange={set('to')} />
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" variant="primary">
            Apply filters
          </Button>
          <Button
            onClick={() => {
              setDraft(EMPTY);
              setApplied(EMPTY);
            }}
          >
            Clear
          </Button>
        </div>
      </form>
      {log.error ? <Alert tone="error">{errorMessage(log.error)}</Alert> : null}
      <div className="overflow-x-auto rounded-xl border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-gray-50 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                When
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Who
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Action
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Entity
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Details
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-line align-top last:border-0">
                <td className="whitespace-nowrap px-4 py-2 text-muted">{formatDateTime(e.createdAt)}</td>
                <td className="px-4 py-2">
                  {e.actor.name ?? 'Former member'}
                  {e.actor.type === 'api_key' ? (
                    <span className="block text-xs text-muted">API key</span>
                  ) : null}
                </td>
                <td className="px-4 py-2">
                  <code className="text-xs">{e.action}</code>
                </td>
                <td className="px-4 py-2 text-xs text-muted">
                  {e.entityType ? (
                    <button
                      type="button"
                      className="text-left hover:text-brand-700 hover:underline"
                      onClick={() => {
                        const next = { ...EMPTY, entityId: e.entityId ?? '' };
                        setDraft(next);
                        setApplied(next);
                      }}
                    >
                      {e.entityType} {e.entityId?.slice(0, 8)}
                    </button>
                  ) : (
                    '-'
                  )}
                </td>
                <td
                  className="max-w-xs truncate px-4 py-2 text-xs text-muted"
                  title={JSON.stringify(e.metadata)}
                >
                  {Object.keys(e.metadata).length ? JSON.stringify(e.metadata) : ''}
                </td>
              </tr>
            ))}
            {log.isSuccess && entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted">
                  No entries match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {log.hasNextPage ? (
        <div className="mt-4 text-center">
          <Button onClick={() => void log.fetchNextPage()} busy={log.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
