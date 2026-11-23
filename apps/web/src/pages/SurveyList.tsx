import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import type {
  Folder,
  PageResult,
  SurveyDetail,
  SurveyStatus,
  SurveySummary,
  TemplateSummary,
} from '@survey/contracts';
import { del, errorMessage, get, patch, post } from '../api';
import { useOrgRole } from '../auth';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  PageHeader,
  StatusBadge,
  TextField,
  cx,
} from '../components/ui';
import { formatNumber, relativeTime } from '../lib/format';

/** `all`, `none` (not in a folder) or a folder id. */
type FolderFilter = string;
const MAX_DEPTH = 3;

export function SurveyListPage() {
  const role = useOrgRole();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<SurveyStatus | ''>('');
  const [folder, setFolder] = useState<FolderFilter>('all');
  const [creating, setCreating] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const folders = useQuery({ queryKey: ['folders'], queryFn: () => get<Folder[]>('/folders') });
  const query = useInfiniteQuery({
    queryKey: ['surveys', q, status, folder],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      if (folder !== 'all') params.set('folderId', folder);
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

  const move = useMutation({
    mutationFn: (v: { surveyId: string; folderId: string | null }) =>
      patch(`/surveys/${v.surveyId}`, { folderId: v.folderId }),
    onSuccess: () => {
      setMoveError(null);
      void queryClient.invalidateQueries({ queryKey: ['surveys'] });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
    },
    onError: (e) => setMoveError(errorMessage(e)),
  });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = (event: DragEndEvent) => {
    const surveyId = String(event.active.id).replace(/^survey:/, '');
    const target = event.over ? String(event.over.id).replace(/^folder:/, '') : null;
    if (target === null) return;
    const survey = surveys.find((s) => s.id === surveyId);
    const folderId = target === 'none' ? null : target;
    if (survey && survey.folderId !== folderId) move.mutate({ surveyId, folderId });
  };
  const folderName = (id: string | null) => folders.data?.find((f) => f.id === id)?.name;

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
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          <FolderTree
            folders={folders.data ?? []}
            selected={folder}
            onSelect={setFolder}
            canManage={canCreate}
          />
          <div className="min-w-0">
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
            {moveError ? (
              <Alert tone="error" className="mb-3">
                {moveError}
              </Alert>
            ) : null}
            {query.isPending ? <p className="text-sm text-muted">Loading surveys…</p> : null}
            {!query.isPending && surveys.length === 0 ? (
              <EmptyState
                title={q || status || folder !== 'all' ? 'No surveys match' : 'No surveys yet'}
                action={
                  canCreate && !q && !status && folder === 'all' ? (
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
                      <th scope="col" className="px-4 py-3 font-medium">
                        <span className="sr-only">Folder</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {surveys.map((s) => (
                      <SurveyRow key={s.id} survey={s} draggable={s.myRole !== 'viewer'}>
                        <td className="px-4 py-3">
                          <Link to={open(s)} className="font-medium text-ink hover:text-brand-600">
                            {s.title}
                          </Link>
                          <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted">
                            {s.currentVersionNumber ? (
                              <span>Version {s.currentVersionNumber}</span>
                            ) : (
                              <span>Not published</span>
                            )}
                            {s.hasDraft && s.currentVersionNumber ? <Badge>Unpublished changes</Badge> : null}
                            {s.pendingApproval ? (
                              <Badge className="bg-amber-100 text-amber-900">Waiting for approval</Badge>
                            ) : null}
                            {s.folderId && folder === 'all' ? <span>· {folderName(s.folderId)}</span> : null}
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
                        <td className="hidden px-4 py-3 text-muted md:table-cell">
                          {relativeTime(s.updatedAt)}
                        </td>
                        <td className="px-4 py-3">
                          {s.myRole !== 'viewer' && (folders.data?.length ?? 0) > 0 ? (
                            <label>
                              <span className="sr-only">Move {s.title} to folder</span>
                              <select
                                className="max-w-36 rounded-md border border-line bg-white px-2 py-1 text-xs"
                                value={s.folderId ?? ''}
                                onChange={(e) =>
                                  move.mutate({ surveyId: s.id, folderId: e.target.value || null })
                                }
                              >
                                <option value="">No folder</option>
                                {orderedFolders(folders.data ?? []).map((f) => (
                                  <option key={f.id} value={f.id}>
                                    {'  '.repeat(f.depth - 1)}
                                    {f.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                        </td>
                      </SurveyRow>
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
          </div>
        </div>
      </DndContext>

      <NewSurveyDialog
        open={creating}
        folderId={folder !== 'all' && folder !== 'none' ? folder : null}
        onClose={() => setCreating(false)}
        onCreated={(s) => navigate(`/surveys/${s.id}/edit`)}
      />
    </>
  );
}

/** Folders in tree order (parents before children, siblings by name). */
function orderedFolders(all: Folder[]): Folder[] {
  const out: Folder[] = [];
  const walk = (parentId: string | null) => {
    for (const f of all.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(f);
      walk(f.id);
    }
  };
  walk(null);
  return out;
}

function SurveyRow({
  survey,
  draggable,
  children,
}: {
  survey: SurveySummary;
  draggable: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `survey:${survey.id}`,
    disabled: !draggable,
  });
  // Keyboard users move surveys with the folder menu in the row, so the row itself isn't a tab stop.
  const { tabIndex: _tabIndex, role: _role, ...dragAttributes } = attributes;
  return (
    <tr
      ref={setNodeRef}
      {...dragAttributes}
      {...listeners}
      className={cx(
        'border-b border-line last:border-0 hover:bg-gray-50',
        draggable && 'cursor-grab',
        isDragging && 'opacity-50',
      )}
    >
      {children}
    </tr>
  );
}

function FolderTarget({ id, children }: { id: string; children: (isOver: boolean) => ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `folder:${id}` });
  return <div ref={setNodeRef}>{children(isOver)}</div>;
}

function FolderTree({
  folders,
  selected,
  onSelect,
  canManage,
}: {
  folders: Folder[];
  selected: FolderFilter;
  onSelect: (f: FolderFilter) => void;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ mode: 'new' | 'rename'; folder: Folder | null } | null>(null);
  const [deleting, setDeleting] = useState<Folder | null>(null);
  const current = folders.find((f) => f.id === selected) ?? null;
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['folders'] });
    void queryClient.invalidateQueries({ queryKey: ['surveys'] });
  };
  const remove = useMutation({
    mutationFn: (f: Folder) => del(`/folders/${f.id}`),
    onSuccess: (_d, f) => {
      setDeleting(null);
      onSelect(f.parentId ?? 'all');
      reload();
    },
  });
  const item = (id: FolderFilter, label: ReactNode, depth = 0, droppable = true) => {
    const button = (isOver: boolean) => (
      <button
        type="button"
        aria-current={selected === id ? 'true' : undefined}
        onClick={() => onSelect(id)}
        style={{ paddingLeft: `${0.75 + depth * 0.9}rem` }}
        className={cx(
          'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm',
          selected === id ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink hover:bg-gray-100',
          isOver && 'ring-2 ring-brand-500',
        )}
      >
        {label}
      </button>
    );
    return droppable ? (
      <FolderTarget key={id} id={id}>
        {button}
      </FolderTarget>
    ) : (
      <div key={id}>{button(false)}</div>
    );
  };

  return (
    <nav aria-label="Folders" className="flex flex-col gap-0.5">
      <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-muted">Folders</p>
      {item('all', 'All surveys', 0, false)}
      {item('none', 'Not in a folder')}
      {orderedFolders(folders).map((f) =>
        item(
          f.id,
          <>
            <span aria-hidden="true">📁</span>
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="text-xs text-muted">{f.surveyCount || ''}</span>
          </>,
          f.depth - 1,
        ),
      )}
      {canManage ? (
        <div className="mt-2 flex flex-wrap gap-1 px-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={Boolean(current && current.depth >= MAX_DEPTH)}
            title={current && current.depth >= MAX_DEPTH ? 'Folders nest at most three levels' : undefined}
            onClick={() => setDialog({ mode: 'new', folder: current })}
          >
            + {current ? 'Subfolder' : 'New folder'}
          </Button>
          {current ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDialog({ mode: 'rename', folder: current })}
              >
                Rename
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(current)}>
                Delete
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {canManage ? (
        <p className="mt-1 px-3 text-xs text-muted">Drag a survey onto a folder to move it.</p>
      ) : null}
      {dialog ? (
        <FolderDialog
          mode={dialog.mode}
          folder={dialog.folder}
          onClose={() => setDialog(null)}
          onSaved={(f) => {
            setDialog(null);
            reload();
            onSelect(f.id);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete folder “${deleting?.name}”?`}
        message="Its surveys and subfolders move up one level. No survey is deleted."
        confirmLabel="Delete folder"
        danger
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
      {remove.error ? <Alert tone="error">{errorMessage(remove.error)}</Alert> : null}
    </nav>
  );
}

function FolderDialog({
  mode,
  folder,
  onClose,
  onSaved,
}: {
  mode: 'new' | 'rename';
  folder: Folder | null;
  onClose: () => void;
  onSaved: (f: Folder) => void;
}) {
  const [name, setName] = useState(mode === 'rename' ? (folder?.name ?? '') : '');
  const save = useMutation({
    mutationFn: () =>
      mode === 'rename' && folder
        ? patch<Folder>(`/folders/${folder.id}`, { name })
        : post<Folder>('/folders', { name, parentId: folder?.id ?? null }),
    onSuccess: onSaved,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'rename' ? 'Rename folder' : folder ? `New folder in “${folder.name}”` : 'New folder'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={!name.trim()}
            onClick={() => save.mutate()}
          >
            {mode === 'rename' ? 'Rename' : 'Create folder'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label="Folder name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={save.error ? errorMessage(save.error) : undefined}
        />
      </form>
    </Dialog>
  );
}

function NewSurveyDialog({
  open,
  folderId,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** Phase 3A: create it in the folder being viewed. */
  folderId: string | null;
  onClose: () => void;
  onCreated: (s: SurveyDetail) => void;
}) {
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState<TemplateSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => get<TemplateSummary[]>('/templates'),
    enabled: open,
  });
  const groups = useMemo(() => {
    const map = new Map<string, TemplateSummary[]>();
    for (const t of templates.data ?? []) map.set(t.category, [...(map.get(t.category) ?? []), t]);
    return [...map.entries()];
  }, [templates.data]);

  const create = async () => {
    if (!title.trim()) return setError('Give your survey a title.');
    setBusy(true);
    try {
      onCreated(
        await post<SurveyDetail>('/surveys', {
          title,
          ...(template ? { fromTemplate: { kind: template.kind, id: template.id } } : {}),
          ...(folderId ? { folderId } : {}),
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const choose = (t: TemplateSummary | null) => {
    setTemplate(t);
    if (t && (!title.trim() || title === template?.name)) setTitle(t.name);
  };
  const option = (t: TemplateSummary | null) => {
    const checked = template?.id === t?.id;
    return (
      <label
        key={t ? `${t.kind}:${t.id}` : 'blank'}
        className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm ${checked ? 'border-brand-500 bg-brand-50' : 'border-line bg-white hover:border-brand-500'}`}
      >
        <span className="flex items-center gap-2">
          <input
            type="radio"
            name="template"
            className="accent-brand-600"
            checked={checked}
            onChange={() => choose(t)}
          />
          <span className="font-medium">{t ? t.name : 'Blank survey'}</span>
        </span>
        <span className="text-xs text-muted">
          {t
            ? `${t.description ? `${t.description} ` : ''}${t.questionCount} question${t.questionCount === 1 ? '' : 's'}.`
            : 'Start from an empty page.'}
        </span>
      </label>
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New survey"
      wide
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
        className="flex flex-col gap-4"
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
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">Start from</legend>
          <div className="grid gap-2 sm:grid-cols-2">{option(null)}</div>
          {templates.isLoading ? <p className="text-sm text-muted">Loading templates…</p> : null}
          {groups.map(([category, list]) => (
            <div key={category} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{category}</h3>
              <div className="grid gap-2 sm:grid-cols-2">{list.map((t) => option(t))}</div>
            </div>
          ))}
        </fieldset>
      </form>
    </Dialog>
  );
}
