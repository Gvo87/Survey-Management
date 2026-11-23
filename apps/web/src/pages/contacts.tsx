/**
 * Contacts (Phase 2B): people to invite by email, grouped in lists, imported from CSV.
 * Admins and creators only; contacts are personal data.
 */
import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Contact, ContactImport, ContactList, PageResult } from '@survey/contracts';
import { del, errorMessage, get, post, upload } from '../api';
import { useOrgRole } from '../auth';
import { Alert, Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, PageHeader, SelectField, TextField, cx } from '../components/ui';
import { formatDateTime, formatNumber } from '../lib/format';

const STATUS_LABEL = { subscribed: 'Subscribed', unsubscribed: 'Unsubscribed', bounced: 'Bounced' } as const;

export function ContactsPage() {
  const role = useOrgRole();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [listId, setListId] = useState('');
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<Contact | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const lists = useQuery({ queryKey: ['contact-lists'], queryFn: () => get<ContactList[]>('/contact-lists'), enabled: role !== 'analyst' });
  const contacts = useInfiniteQuery({
    queryKey: ['contacts', search, listId, status],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (search) p.set('q', search);
      if (listId) p.set('listId', listId);
      if (status) p.set('status', status);
      if (pageParam) p.set('cursor', pageParam);
      return get<PageResult<Contact>>(`/contacts?${p}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: role !== 'analyst',
  });
  const rows = contacts.data?.pages.flatMap((p) => p.data) ?? [];
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['contacts'] });
    void queryClient.invalidateQueries({ queryKey: ['contact-lists'] });
  };
  const remove = useMutation({
    mutationFn: (id: string) => del(`/contacts/${id}`),
    onSuccess: () => {
      setDeleting(null);
      reload();
    },
  });

  if (role === 'analyst') return <Alert tone="info">Contacts are managed by admins and creators.</Alert>;

  return (
    <>
      <PageHeader
        title="Contacts"
        description="People you invite to surveys by email. Unsubscribed and bounced addresses are never emailed."
        actions={
          <>
            <Button onClick={() => setImporting(true)}>Import CSV</Button>
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add contact
            </Button>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <ListsPanel lists={lists.data ?? []} selected={listId} onSelect={setListId} onChanged={reload} />
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <TextField label="Search" type="search" className="min-w-56 flex-1" placeholder="Name or email" value={q} onChange={(e) => setQ(e.target.value)} />
            <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </SelectField>
          </div>
          {contacts.error ? <Alert tone="error">{errorMessage(contacts.error)}</Alert> : null}
          {!contacts.isPending && rows.length === 0 ? (
            <EmptyState title={search || listId || status ? 'No contacts match' : 'No contacts yet'}>
              {search || listId || status ? 'Try another search or filter.' : 'Add people one by one, or import a CSV with an email column.'}
            </EmptyState>
          ) : null}
          {rows.length ? (
            <div className="overflow-x-auto rounded-xl border border-line bg-white shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line bg-gray-50 text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Contact
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Lists
                    </th>
                    <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                      Attributes
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-medium">{[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}</div>
                        <div className="text-xs text-muted">{c.email}</div>
                      </td>
                      <td className="px-4 py-3 text-muted">{c.lists.map((l) => l.name).join(', ') || '—'}</td>
                      <td className="hidden max-w-xs truncate px-4 py-3 text-xs text-muted md:table-cell">
                        {Object.entries(c.attributes)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' · ') || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={c.status === 'subscribed' ? 'bg-green-100 text-green-800' : c.status === 'bounced' ? 'bg-red-100 text-red-800' : ''}>
                          {STATUS_LABEL[c.status]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button size="sm" variant="ghost" aria-label={`Delete ${c.email}`} onClick={() => setDeleting(c)}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {contacts.hasNextPage ? (
            <Button className="self-center" busy={contacts.isFetchingNextPage} onClick={() => void contacts.fetchNextPage()}>
              Load more
            </Button>
          ) : null}
        </div>
      </div>
      <AddContactDialog open={adding} lists={lists.data ?? []} onClose={() => setAdding(false)} onSaved={reload} />
      <ImportDialog open={importing} lists={lists.data ?? []} onClose={() => setImporting(false)} onDone={reload} />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete contact?"
        message={`${deleting?.email} is removed with their list memberships and campaign history. Survey responses they already gave stay, without the link to them.`}
        confirmLabel="Delete contact"
        danger
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </>
  );
}

function ListsPanel({ lists, selected, onSelect, onChanged }: { lists: ContactList[]; selected: string; onSelect: (id: string) => void; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<ContactList | null>(null);
  const create = useMutation({
    mutationFn: () => post<ContactList>('/contact-lists', { name }),
    onSuccess: (list) => {
      setName('');
      onChanged();
      onSelect(list.id);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/contact-lists/${id}`),
    onSuccess: () => {
      setConfirm(null);
      onSelect('');
      onChanged();
    },
  });
  return (
    <Card title="Lists">
      <nav aria-label="Contact lists">
        <ul className="flex flex-col gap-1 text-sm">
          {[{ id: '', name: 'All contacts', memberCount: null as number | null }, ...lists].map((l) => (
            <li key={l.id} className="flex items-center gap-1">
              <button
                type="button"
                aria-current={selected === l.id ? 'true' : undefined}
                className={cx('flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left', selected === l.id ? 'bg-brand-50 font-medium text-brand-700' : 'hover:bg-gray-50')}
                onClick={() => onSelect(l.id)}
              >
                <span className="truncate">{l.name}</span>
                {l.memberCount !== null ? <span className="text-xs text-muted">{formatNumber(l.memberCount)}</span> : null}
              </button>
              {l.id ? (
                <Button size="sm" variant="ghost" aria-label={`Delete list ${l.name}`} onClick={() => setConfirm(l as ContactList)}>
                  ✕
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </nav>
      <form
        className="mt-4 flex items-end gap-2 border-t border-line pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <TextField label="New list" className="min-w-0 flex-1" value={name} onChange={(e) => setName(e.target.value)} error={create.error ? errorMessage(create.error) : undefined} />
        <Button type="submit" size="sm" className="mb-1" busy={create.isPending}>
          Add
        </Button>
      </form>
      <ConfirmDialog
        open={confirm !== null}
        title="Delete list?"
        message={`The list "${confirm?.name}" is deleted. Its contacts stay in your contacts.`}
        confirmLabel="Delete list"
        danger
        busy={remove.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && remove.mutate(confirm.id)}
      />
    </Card>
  );
}

function AddContactDialog({ open, lists, onClose, onSaved }: { open: boolean; lists: ContactList[]; onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [listId, setListId] = useState('');
  const save = useMutation({
    mutationFn: () => post('/contacts', { email, firstName: first || null, lastName: last || null, listIds: listId ? [listId] : [] }),
    onSuccess: () => {
      setEmail('');
      setFirst('');
      setLast('');
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add contact"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={!email.trim()} onClick={() => save.mutate()}>
            Add contact
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField label="Email" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="First name" value={first} onChange={(e) => setFirst(e.target.value)} />
          <TextField label="Last name" value={last} onChange={(e) => setLast(e.target.value)} />
        </div>
        <SelectField label="Add to list" value={listId} onChange={(e) => setListId(e.target.value)}>
          <option value="">No list</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </SelectField>
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      </form>
    </Dialog>
  );
}

/** Read the header and a few rows locally, so columns can be mapped before uploading. */
function previewCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && lines.length < 6; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) lines.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if ((cell || row.length) && lines.length < 6) lines.push([...row, cell.trim()]);
  const [headers = [], ...rows] = lines;
  return { headers: headers.map((h) => h.trimStart()), rows };
}

const guess = (headers: string[], patterns: RegExp[]) => headers.find((h) => patterns.some((p) => p.test(h))) ?? '';
const attributeName = (header: string) =>
  header
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'a_$1')
    .toLowerCase()
    .slice(0, 40) || 'field';

function ImportDialog({ open, lists, onClose, onDone }: { open: boolean; lists: ContactList[]; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState({ email: '', firstName: '', lastName: '' });
  const [extra, setExtra] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<{ kind: 'none' | 'existing' | 'new'; listId: string; name: string }>({ kind: 'new', listId: '', name: '' });
  const [job, setJob] = useState<ContactImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setJob(null);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const status = useQuery({
    queryKey: ['contact-import', job?.id],
    queryFn: () => get<ContactImport>(`/contacts/imports/${job!.id}`),
    enabled: Boolean(job) && (job?.status === 'queued' || job?.status === 'running'),
    refetchInterval: 1000,
  });
  const current = status.data ?? job;
  useEffect(() => {
    if (current && (current.status === 'done' || current.status === 'failed')) onDone();
  }, [current?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (f: File | null) => {
    reset();
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) return setError('Choose a .csv file. In Excel, use "Save as > CSV UTF-8".');
    const text = await f.slice(0, 64 * 1024).text();
    const p = previewCsv(text);
    if (!p.headers.length) return setError('The file looks empty.');
    setFile(f);
    setPreview(p);
    const email = guess(p.headers, [/^e-?mail/i, /mail/i]);
    const firstName = guess(p.headers, [/^first/i, /given/i, /^name$/i]);
    const lastName = guess(p.headers, [/^last/i, /surname|family/i]);
    setMapping({ email, firstName, lastName });
    setExtra(Object.fromEntries(p.headers.filter((h) => ![email, firstName, lastName].includes(h)).map((h) => [h, true])));
    setTarget((t) => ({ ...t, name: t.name || f.name.replace(/\.csv$/i, '').slice(0, 100) }));
  };

  const attributes = useMemo(
    () => Object.fromEntries(Object.entries(extra).filter(([h, on]) => on && h).map(([h]) => [h, attributeName(h)])),
    [extra],
  );

  const start = async () => {
    if (!file || !mapping.email) return setError('Choose the column with email addresses.');
    setBusy(true);
    setError(null);
    try {
      const fields: Record<string, string> = {
        mapping: JSON.stringify({ email: mapping.email, ...(mapping.firstName ? { firstName: mapping.firstName } : {}), ...(mapping.lastName ? { lastName: mapping.lastName } : {}), attributes }),
      };
      if (target.kind === 'existing' && target.listId) fields.listId = target.listId;
      if (target.kind === 'new' && target.name.trim()) fields.newListName = target.name.trim();
      setJob(await upload<ContactImport>('/contacts/imports', file, fields));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const columnSelect = (label: string, value: string, onChange: (v: string) => void, required = false) => (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{required ? 'Choose a column…' : 'Not in this file'}</option>
      {preview?.headers.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </SelectField>
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import contacts"
      wide
      footer={
        current ? (
          <Button variant="primary" onClick={close}>
            {current.status === 'done' || current.status === 'failed' ? 'Done' : 'Close (keeps running)'}
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={!preview || !mapping.email} onClick={() => void start()}>
              Import
            </Button>
          </>
        )
      }
    >
      {current ? (
        <ImportProgress job={current} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="import-file" className="text-sm font-medium">
              CSV file
            </label>
            <input id="import-file" type="file" accept=".csv,text/csv" className="text-sm" onChange={(e) => void choose(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-muted">UTF-8, with a header row. Up to 200,000 rows and 20 MB. Rows with the same email are merged.</p>
          </div>
          {preview ? (
            <>
              <fieldset className="grid gap-3 sm:grid-cols-3">
                <legend className="mb-1 text-sm font-semibold">Columns</legend>
                {columnSelect('Email', mapping.email, (v) => setMapping({ ...mapping, email: v }), true)}
                {columnSelect('First name', mapping.firstName, (v) => setMapping({ ...mapping, firstName: v }))}
                {columnSelect('Last name', mapping.lastName, (v) => setMapping({ ...mapping, lastName: v }))}
              </fieldset>
              {preview.headers.filter((h) => ![mapping.email, mapping.firstName, mapping.lastName].includes(h)).length ? (
                <fieldset>
                  <legend className="mb-1 text-sm font-semibold">Also import as attributes</legend>
                  <p className="mb-2 text-xs text-muted">Usable in emails as merge tags, like {'{{contact.plan}}'}.</p>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {preview.headers
                      .filter((h) => h && ![mapping.email, mapping.firstName, mapping.lastName].includes(h))
                      .map((h) => (
                        <label key={h} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={extra[h] ?? false} onChange={(e) => setExtra({ ...extra, [h]: e.target.checked })} />
                          {h} <code className="text-xs text-muted">{`{{contact.${attributeName(h)}}}`}</code>
                        </label>
                      ))}
                  </div>
                </fieldset>
              ) : null}
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">First rows of the file</caption>
                  <thead className="bg-gray-50">
                    <tr>
                      {preview.headers.map((h) => (
                        <th key={h} scope="col" className="px-2 py-1.5 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={i} className="border-t border-line">
                        {preview.headers.map((_, j) => (
                          <td key={j} className="max-w-40 truncate px-2 py-1.5">
                            {r[j]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-semibold">Add the contacts to</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="target" checked={target.kind === 'new'} onChange={() => setTarget({ ...target, kind: 'new' })} />
                  A new list
                </label>
                {target.kind === 'new' ? <TextField label="List name" value={target.name} onChange={(e) => setTarget({ ...target, name: e.target.value })} className="ml-6" /> : null}
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="target" checked={target.kind === 'existing'} disabled={!lists.length} onChange={() => setTarget({ ...target, kind: 'existing', listId: lists[0]?.id ?? '' })} />
                  An existing list
                </label>
                {target.kind === 'existing' ? (
                  <SelectField label="List" className="ml-6" value={target.listId} onChange={(e) => setTarget({ ...target, listId: e.target.value })}>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </SelectField>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="target" checked={target.kind === 'none'} onChange={() => setTarget({ ...target, kind: 'none' })} />
                  No list
                </label>
              </fieldset>
            </>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
        </div>
      )}
    </Dialog>
  );
}

function ImportProgress({ job }: { job: ContactImport }) {
  if (job.status === 'queued' || job.status === 'running')
    return (
      <p className="text-sm" role="status">
        Importing {job.filename}… {job.total ? `${formatNumber(job.created + job.updated)} of ${formatNumber(job.total)} saved` : ''}
      </p>
    );
  if (job.status === 'failed') return <Alert tone="error">The import failed: {job.failure}</Alert>;
  return (
    <div className="flex flex-col gap-3 text-sm" role="status">
      <Alert tone="success">
        Imported {formatNumber(job.total)} rows: {formatNumber(job.created)} new contacts, {formatNumber(job.updated)} updated
        {job.skipped ? `, ${formatNumber(job.skipped)} skipped` : ''}.
      </Alert>
      {job.errors.length ? (
        <>
          <p className="font-medium">Rows that weren't imported:</p>
          <ul className="max-h-40 list-disc overflow-auto pl-5 text-muted">
            {job.errors.slice(0, 20).map((e) => (
              <li key={e.row}>
                Line {e.row}: {e.message}
              </li>
            ))}
          </ul>
          {job.errorReportUrl ? (
            <a className="text-brand-600 underline" href={job.errorReportUrl}>
              Download the full error report (CSV)
            </a>
          ) : null}
        </>
      ) : null}
      <p className="text-xs text-muted">Finished {formatDateTime(job.finishedAt)}.</p>
    </div>
  );
}

