import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ApprovalPending, BankItem, Org, PublishResult, SurveyDetail, Theme, VersionDetail, VersionSummary } from '@survey/contracts';
import {
  QUESTION_TYPES,
  QUESTION_TYPE_META,
  bankQuestion,
  createQuestion,
  createTextBlock,
  type Element,
  type Issue,
  type Page,
  type QuestionType,
  type SurveyDefinition,
} from '@survey/core';
import { ApiError, errorMessage, get, post } from '../../../api';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  CopyButton,
  Dialog,
  TextArea,
  TextField,
  cx,
} from '../../../components/ui';
import { CommentsPanel } from '../Comments';
import { useSurvey } from '../SurveyLayout';
import {
  addPage,
  duplicateElement,
  findElement,
  insertElement,
  moveElement,
  moveElementBy,
  movePage,
  questionNumbers,
  removeElement,
  removePage,
  updateElement,
  updatePage,
} from './defs';
import { ElementEditor, IssueList } from './ElementEditor';
import { LogicMapDialog, PageRulesEditor, PipeMenu, readableTokens, sourcesBefore, usePipeTarget, VisibilityEditor } from './logic';
import { PreviewFrame, type PreviewTheme } from './PreviewFrame';
import { useDraft, type SaveState } from './useDraft';

type DraftApi = ReturnType<typeof useDraft>;

/** The theme respondents will see: the survey's own, or the organization's default. */
function usePreviewTheme(survey: SurveyDetail): PreviewTheme | null {
  const themes = useQuery({ queryKey: ['themes'], queryFn: () => get<Theme[]>('/themes'), staleTime: 60_000 });
  const theme = themes.data?.find((t) => (survey.themeId ? t.id === survey.themeId : t.isDefault));
  return theme ? { tokens: theme.tokens, logoUrl: theme.logoUrl } : null;
}

export function BuilderPage() {
  const { survey, canEdit, refresh } = useSurvey();
  const d = useDraft(survey.id, survey.anonymous);
  if (!canEdit)
    return <Alert tone="info">You have view access to this survey. See its results and responses.</Alert>;
  if (d.error) return <Alert tone="error">{errorMessage(d.error)}</Alert>;
  if (d.loading) return <p className="text-sm text-muted">Loading the builder…</p>;
  if (!d.draft) return <LiveVersion survey={survey} onEdit={() => void d.createDraft()} />;
  if (!d.definition) return null;
  return <Editor survey={survey} d={d} definition={d.definition} onPublished={refresh} />;
}

/** A published survey without a draft: show what's live and offer to edit it. */
function LiveVersion({ survey, onEdit }: { survey: SurveyDetail; onEdit: () => void }) {
  const versions = useQuery({
    queryKey: ['versions', survey.id],
    queryFn: () => get<VersionSummary[]>(`/surveys/${survey.id}/versions`),
  });
  const current = versions.data?.[0];
  const detail = useQuery({
    queryKey: ['version', current?.id],
    queryFn: () => get<VersionDetail>(`/surveys/${survey.id}/versions/${current!.id}`),
    enabled: Boolean(current),
  });
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const theme = usePreviewTheme(survey);
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="success">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            <strong>Version {survey.currentVersionNumber} is live.</strong> Editing creates a draft;
            respondents keep seeing version {survey.currentVersionNumber} until you publish the draft.
          </span>
          <span className="flex gap-2">
            {survey.publicUrl ? <CopyButton text={survey.publicUrl} label="Copy link" /> : null}
            <Link
              to="../distribute"
              className="inline-flex h-8 items-center rounded-lg border border-line bg-white px-3 text-sm font-medium"
            >
              Share
            </Link>
            <Button size="sm" variant="primary" onClick={onEdit}>
              Edit survey
            </Button>
          </span>
        </div>
      </Alert>
      {detail.data ? (
        <div className="flex flex-col gap-2">
          <DeviceToggle device={device} onChange={setDevice} />
          <div className="h-[70vh]">
            <PreviewFrame
              definition={detail.data.definition}
              title={survey.title}
              pageKey={null}
              device={device}
              theme={theme}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DeviceToggle({
  device,
  onChange,
}: {
  device: 'desktop' | 'mobile';
  onChange: (d: 'desktop' | 'mobile') => void;
}) {
  return (
    <div
      role="group"
      aria-label="Preview size"
      className="inline-flex self-start rounded-lg border border-line bg-white p-0.5 text-sm"
    >
      {(['desktop', 'mobile'] as const).map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={device === d}
          onClick={() => onChange(d)}
          className={cx(
            'rounded-md px-3 py-1',
            device === d ? 'bg-brand-600 text-white' : 'text-muted hover:text-ink',
          )}
        >
          {d === 'desktop' ? 'Desktop' : 'Mobile'}
        </button>
      ))}
    </div>
  );
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'All changes saved',
  unsaved: 'Unsaved changes…',
  saving: 'Saving…',
  offline: "Can't reach the server. Retrying…",
  error: "Couldn't save. Reload the page.",
  conflict: 'Not saved: conflict',
};

function Editor({
  survey,
  d,
  definition,
  onPublished,
}: {
  survey: SurveyDetail;
  d: DraftApi;
  definition: SurveyDefinition;
  onPublished: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('mobile');
  const [dialog, setDialog] = useState<null | 'settings' | 'publish' | 'problems' | 'discard' | 'logic' | 'comments'>(null);
  const theme = usePreviewTheme(survey);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'element' | 'page'; key: string } | null>(null);

  const numbers = useMemo(() => questionNumbers(definition), [definition]);
  const issuesByKey = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const issue of d.issues) {
      const key = issue.elementKey ?? issue.pageKey;
      if (key) map.set(key, [...(map.get(key) ?? []), issue]);
    }
    return map;
  }, [d.issues]);
  const errors = d.issues.filter((i) => i.severity === 'error');

  const selectedPage = selected
    ? (findElement(definition, selected)?.page.key ??
      (definition.pages.some((p) => p.key === selected) ? selected : null))
    : null;

  const select = (key: string | null) => {
    setSelected(key);
    if (key)
      requestAnimationFrame(() =>
        document.getElementById(`el-${key}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      );
  };

  const add = (pageKey: string, element: Element) => {
    d.update((def) => insertElement(def, pageKey, element));
    select(element.key);
  };

  const doDelete = () => {
    if (!confirmDelete) return;
    if (confirmDelete.kind === 'element') d.update((def) => removeElement(def, confirmDelete.key));
    else d.update((def) => removePage(def, confirmDelete.key));
    setConfirmDelete(null);
    setSelected(null);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-b border-line bg-canvas/95 px-4 py-2 backdrop-blur">
        <span
          className={cx(
            'text-sm',
            d.saveState === 'error' || d.saveState === 'conflict' ? 'text-red-700' : 'text-muted',
          )}
          role="status"
          aria-live="polite"
        >
          {SAVE_LABEL[d.saveState]}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {d.issues.length ? (
            <Button
              size="sm"
              variant={errors.length ? 'secondary' : 'ghost'}
              onClick={() => setDialog('problems')}
            >
              {errors.length ? <span className="text-red-700">⚠ {errors.length} to fix</span> : null}
              {errors.length && d.issues.length > errors.length ? ' · ' : ''}
              {d.issues.length > errors.length
                ? `${d.issues.length - errors.length} suggestion${d.issues.length - errors.length > 1 ? 's' : ''}`
                : ''}
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setDialog('logic')}>
            Logic map
          </Button>
          <Button size="sm" onClick={() => setDialog('comments')}>
            Comments
          </Button>
          <Button size="sm" onClick={() => setDialog('settings')}>
            Survey settings
          </Button>
          <Button size="sm" onClick={() => setShowPreview((v) => !v)} aria-pressed={showPreview}>
            {showPreview ? 'Hide preview' : 'Show preview'}
          </Button>
          <Button size="sm" variant="primary" onClick={() => setDialog('publish')}>
            {survey.currentVersionNumber ? 'Publish changes' : 'Publish'}
          </Button>
        </div>
      </div>

      {survey.currentVersionNumber ? (
        <Alert tone="info">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              You're editing a draft of version {survey.currentVersionNumber + 1}. Version{' '}
              {survey.currentVersionNumber} stays live until you publish.
            </span>
            <Button size="sm" variant="ghost" onClick={() => setDialog('discard')}>
              Discard draft
            </Button>
          </div>
        </Alert>
      ) : null}
      {survey.pendingApproval ? (
        <Alert tone="warning">
          Waiting for approval. Editing the draft withdraws the request, so the approver always reviews exactly what you sent.
        </Alert>
      ) : null}
      {d.conflict ? (
        <Alert tone="error">
          <p className="mb-2">
            {d.conflict.updatedBy ?? 'Someone else'} saved this draft while you were editing, so your latest
            changes weren't saved.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void d.resolveConflict('theirs')}>
              Load their version (discard mine)
            </Button>
            <Button size="sm" variant="danger" onClick={() => void d.resolveConflict('mine')}>
              Keep mine (overwrite theirs)
            </Button>
          </div>
        </Alert>
      ) : null}

      <div
        className={cx(
          'grid items-start gap-6',
          showPreview
            ? device === 'mobile'
              ? 'lg:grid-cols-[200px_1fr_420px]'
              : 'lg:grid-cols-[1fr_minmax(0,1.2fr)]'
            : 'lg:grid-cols-[200px_1fr]',
        )}
      >
        {!(showPreview && device === 'desktop') ? (
          <Outline
            definition={definition}
            selectedPage={selectedPage}
            numbers={numbers}
            onSelect={select}
            onMove={(from, to) => d.update((def) => movePage(def, from, to))}
          />
        ) : null}

        <Canvas
          definition={definition}
          selected={selected}
          numbers={numbers}
          issuesByKey={issuesByKey}
          onSelect={select}
          update={d.update}
          onAdd={add}
          onAddPage={() => {
            let key = '';
            d.update((def) => {
              const result = addPage(def);
              key = result.pageKey;
              return result.def;
            });
            select(key);
          }}
          onDelete={(kind, key) => {
            const page = definition.pages.find((p) => p.key === key);
            if (kind === 'page' && page && page.elements.length === 0)
              d.update((def) => removePage(def, key));
            else setConfirmDelete({ kind, key });
          }}
        />

        {showPreview ? (
          <aside aria-label="Preview" className="sticky top-16 flex h-[calc(100vh-6rem)] flex-col gap-2">
            <DeviceToggle device={device} onChange={setDevice} />
            <PreviewFrame
              definition={definition}
              title={survey.title}
              pageKey={selectedPage}
              device={device}
              theme={theme}
            />
          </aside>
        ) : null}
      </div>

      <SurveySettingsDialog
        open={dialog === 'settings'}
        onClose={() => setDialog(null)}
        definition={definition}
        anonymous={survey.anonymous}
        update={d.update}
      />
      <LogicMapDialog
        open={dialog === 'logic'}
        onClose={() => setDialog(null)}
        def={definition}
        numbers={numbers}
        onPick={(key) => {
          setDialog(null);
          select(key);
        }}
      />
      <Dialog
        open={dialog === 'comments'}
        onClose={() => setDialog(null)}
        title={selected ? 'Comments on the selected item' : 'Comments on the survey'}
        wide
      >
        <p className="mb-3 text-sm text-muted">
          {selected ? 'Select nothing to comment on the survey as a whole. ' : 'Select a question or page to comment on it. '}
          <Link to={`/surveys/${survey.id}/comments`} className="text-brand-700 underline">
            See every comment
          </Link>
        </p>
        <CommentsPanel survey={survey} definition={definition} onlyAnchor={selected} />
      </Dialog>
      <ProblemsDialog
        open={dialog === 'problems'}
        onClose={() => setDialog(null)}
        issues={d.issues}
        numbers={numbers}
        onPick={(key) => {
          setDialog(null);
          select(key);
        }}
      />
      <PublishDialog
        open={dialog === 'publish'}
        onClose={() => setDialog(null)}
        survey={survey}
        d={d}
        errors={errors}
        onPublished={onPublished}
      />
      <ConfirmDialog
        open={dialog === 'discard'}
        title="Discard draft?"
        message={`Your unpublished changes will be deleted. Version ${survey.currentVersionNumber} stays live.`}
        confirmLabel="Discard draft"
        danger
        onCancel={() => setDialog(null)}
        onConfirm={() => void d.discardDraft().then(() => setDialog(null))}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete?.kind === 'page' ? 'Delete page?' : 'Delete question?'}
        message={
          confirmDelete?.kind === 'page'
            ? 'The page and everything on it will be deleted.'
            : 'This question will be removed from the draft.'
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={doDelete}
      />
    </div>
  );
}

// ── Outline (page list, drag to reorder pages) ─────────────────────────────
function Outline({
  definition,
  selectedPage,
  numbers,
  onSelect,
  onMove,
}: {
  definition: SurveyDefinition;
  selectedPage: string | null;
  numbers: Map<string, number>;
  onSelect: (key: string) => void;
  onMove: (from: number, to: number) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const keys = definition.pages.map((p) => p.key);
  const pageLabel = (id: UniqueIdentifier) => `page ${keys.indexOf(String(id)) + 1}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${pageLabel(active.id)}.`,
    onDragOver: ({ over }) =>
      over ? `Over position ${keys.indexOf(String(over.id)) + 1} of ${keys.length}.` : undefined,
    onDragEnd: ({ over }) =>
      over ? `Dropped at position ${keys.indexOf(String(over.id)) + 1}.` : 'Dropped.',
    onDragCancel: () => 'Move cancelled.',
  };
  return (
    <nav aria-label="Pages" className="hidden lg:block">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Pages</h2>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements }}
        onDragEnd={({ active, over }) => {
          if (over && active.id !== over.id)
            onMove(keys.indexOf(String(active.id)), keys.indexOf(String(over.id)));
        }}
      >
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col gap-1">
            {definition.pages.map((page, i) => (
              <OutlineItem
                key={page.key}
                page={page}
                index={i}
                active={selectedPage === page.key}
                numbers={numbers}
                onSelect={onSelect}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </nav>
  );
}

function OutlineItem({
  page,
  index,
  active,
  numbers,
  onSelect,
}: {
  page: Page;
  index: number;
  active: boolean;
  numbers: Map<string, number>;
  onSelect: (key: string) => void;
}) {
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: page.key,
  });
  const questions = page.elements.filter((e) => e.kind === 'question');
  const first = questions[0] ? numbers.get(questions[0].key) : null;
  const last = questions.at(-1) ? numbers.get(questions.at(-1)!.key) : null;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx(
        'flex items-center gap-1 rounded-lg',
        active ? 'bg-brand-50' : 'hover:bg-white',
        isDragging && 'opacity-60',
      )}
    >
      <span
        ref={setActivatorNodeRef}
        {...listeners}
        aria-hidden="true"
        title="Drag to reorder"
        className="cursor-grab touch-none rounded px-1.5 py-2 text-muted hover:text-ink"
      >
        ⠿
      </span>
      <button className="min-w-0 flex-1 py-2 pr-2 text-left text-sm" onClick={() => onSelect(page.key)}>
        <span className="block truncate font-medium">{page.title?.trim() ? readableTokens(page.title, numbers) : `Page ${index + 1}`}</span>
        <span className="text-xs text-muted">
          {first ? (first === last ? `Question ${first}` : `Questions ${first}–${last}`) : 'No questions'}
        </span>
      </button>
    </li>
  );
}

// ── Canvas (pages with sortable elements, drag across pages) ───────────────
function Canvas({
  definition,
  selected,
  numbers,
  issuesByKey,
  onSelect,
  update,
  onAdd,
  onAddPage,
  onDelete,
}: {
  definition: SurveyDefinition;
  selected: string | null;
  numbers: Map<string, number>;
  issuesByKey: Map<string, Issue[]>;
  onSelect: (key: string | null) => void;
  update: DraftApi['update'];
  onAdd: (pageKey: string, element: Element) => void;
  onAddPage: () => void;
  onDelete: (kind: 'element' | 'page', key: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const pageOf = (id: UniqueIdentifier | undefined) => {
    if (id === undefined) return undefined;
    const key = String(id);
    if (key.startsWith('page:')) return definition.pages.find((p) => p.key === key.slice(5));
    return definition.pages.find((p) => p.elements.some((e) => e.key === key));
  };
  const label = (id: UniqueIdentifier) => {
    const found = findElement(definition, String(id));
    if (!found) return 'item';
    return found.element.kind === 'question' ? `question ${numbers.get(found.element.key)}` : 'text block';
  };
  const position = (id: UniqueIdentifier) => {
    const page = pageOf(id);
    if (!page) return '';
    const index = page.elements.findIndex((e) => e.key === String(id));
    return `position ${index + 1} of ${page.elements.length} on page ${definition.pages.indexOf(page) + 1}`;
  };
  const target = (id: UniqueIdentifier) =>
    String(id).startsWith('page:')
      ? `empty page ${definition.pages.findIndex((p) => `page:${p.key}` === String(id)) + 1}`
      : `${label(id)}, ${position(id)}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${label(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${label(active.id)} is over ${target(over.id)}.`
        : `${label(active.id)} is not over a drop area.`,
    onDragEnd: ({ active, over }) =>
      over ? `Dropped ${label(active.id)} at ${target(over.id)}.` : `Dropped ${label(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled moving ${label(active.id)}.`,
  };
  // Questions are the drop targets; a page only counts when it's empty (so you can drop into it).
  // closestCenter copes with cards of different heights (an expanded card is tall).
  const collisionDetection: CollisionDetection = (args) =>
    closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => {
        const id = String(c.id);
        return (
          !id.startsWith('page:') ||
          definition.pages.some((p) => `page:${p.key}` === id && p.elements.length === 0)
        );
      }),
    });

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const from = pageOf(active.id);
    const to = pageOf(over?.id);
    if (!from || !to || from.key === to.key || !over) return;
    const overIndex = to.elements.findIndex((e) => e.key === String(over.id));
    update((def) =>
      moveElement(def, String(active.id), to.key, overIndex === -1 ? to.elements.length : overIndex),
    );
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const page = pageOf(over.id);
    if (!page) return;
    const overIndex = page.elements.findIndex((e) => e.key === String(over.id));
    if (overIndex !== -1) update((def) => moveElement(def, String(active.id), page.key, overIndex));
  };

  const active = activeId ? findElement(definition, activeId)?.element : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        accessibility={{ announcements }}
        onDragStart={({ active: a }) => setActiveId(String(a.id))}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        {definition.pages.map((page, pageIndex) => (
          <PageSection
            key={page.key}
            def={definition}
            page={page}
            index={pageIndex}
            pageCount={definition.pages.length}
            selected={selected}
            issues={issuesByKey.get(page.key) ?? []}
            onSelect={onSelect}
            onChangePage={(patch) => update((def) => updatePage(def, page.key, patch))}
            onChangeRules={(rules) => update((def) => ({ ...def, logic: rules.length ? rules : undefined }))}
            onMovePage={(delta) => update((def) => movePage(def, pageIndex, pageIndex + delta))}
            onDeletePage={() => onDelete('page', page.key)}
            onAdd={(element) => onAdd(page.key, element)}
          >
            {page.elements.map((element) => (
              <ElementCard
                key={element.key}
                def={definition}
                element={element}
                number={numbers.get(element.key)}
                selected={selected === element.key}
                issues={issuesByKey.get(element.key) ?? []}
                pages={definition.pages}
                currentPage={page.key}
                onSelect={() => onSelect(selected === element.key ? null : element.key)}
                onChange={(next) =>
                  update((def) => {
                    const updated = updateElement(def, element.key, () => next);
                    if (next.key !== element.key) queueMicrotask(() => onSelect(next.key)); // type change → new key
                    return updated;
                  })
                }
                onDuplicate={() => {
                  let newKey = '';
                  update((def) => {
                    const r = duplicateElement(def, element.key);
                    newKey = r.newKey;
                    return r.def;
                  });
                  onSelect(newKey);
                }}
                onMove={(delta) => update((def) => moveElementBy(def, element.key, delta))}
                onMoveToPage={(pageKey) =>
                  update((def) =>
                    moveElement(
                      def,
                      element.key,
                      pageKey,
                      def.pages.find((p) => p.key === pageKey)!.elements.length,
                    ),
                  )
                }
                onDelete={() => onDelete('element', element.key)}
              />
            ))}
          </PageSection>
        ))}
        <DragOverlay>
          {active ? (
            <div className="rounded-xl border border-brand-500 bg-white px-4 py-3 text-sm shadow-lg">
              {active.kind === 'question' ? active.title || 'Untitled question' : 'Text block'}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <Button onClick={onAddPage} className="self-start">
        Add page
      </Button>
    </div>
  );
}

function PageSection({
  def,
  page,
  index,
  pageCount,
  selected,
  issues,
  onSelect,
  onChangePage,
  onChangeRules,
  onMovePage,
  onDeletePage,
  onAdd,
  children,
}: {
  def: SurveyDefinition;
  page: Page;
  index: number;
  pageCount: number;
  selected: string | null;
  issues: Issue[];
  onSelect: (key: string | null) => void;
  onChangePage: (patch: Partial<Page>) => void;
  onChangeRules: (rules: NonNullable<SurveyDefinition['logic']>) => void;
  onMovePage: (delta: -1 | 1) => void;
  onDeletePage: () => void;
  onAdd: (element: Element) => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `page:${page.key}` });
  const [showDescription, setShowDescription] = useState(Boolean(page.description));
  const ruleCount = (def.logic ?? []).filter((r) => r.afterPage === page.key).length;
  const logicCount = ruleCount + (page.visibleIf ? 1 : 0);
  const [showLogic, setShowLogic] = useState(false);
  const pageSources = useMemo(() => sourcesBefore(def, { pageKey: page.key }), [def, page.key]);
  return (
    <section
      id={`el-${page.key}`}
      aria-label={`Page ${index + 1}`}
      className={cx(
        'rounded-2xl border bg-gray-50/60 p-4',
        selected === page.key ? 'border-brand-500' : 'border-line',
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Page {index + 1}</span>
        <input
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold hover:border-line focus:border-line focus:bg-white"
          aria-label={`Page ${index + 1} title`}
          placeholder="Page title (optional)"
          value={page.title ?? ''}
          onFocus={() => onSelect(page.key)}
          onChange={(e) => {
            const { title: _, ...rest } = page;
            onChangePage(e.target.value ? { title: e.target.value } : { ...rest, title: undefined });
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowDescription((v) => !v)}
          aria-expanded={showDescription}
        >
          Description
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowLogic((v) => !v)} aria-expanded={showLogic}>
          Logic{logicCount ? <Badge className="bg-brand-50 text-brand-700">{logicCount}</Badge> : null}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Move page ${index + 1} up`}
          disabled={index === 0}
          onClick={() => onMovePage(-1)}
        >
          ↑
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Move page ${index + 1} down`}
          disabled={index === pageCount - 1}
          onClick={() => onMovePage(1)}
        >
          ↓
        </Button>
        {pageCount > 1 ? (
          <Button size="sm" variant="ghost" aria-label={`Delete page ${index + 1}`} onClick={onDeletePage}>
            ✕
          </Button>
        ) : null}
      </div>
      {showDescription ? (
        <TextArea
          label="Page description"
          className="mb-3"
          rows={2}
          value={page.description ?? ''}
          onChange={(e) => onChangePage({ description: e.target.value || undefined })}
        />
      ) : null}
      {showLogic ? (
        <div className="mb-3 flex flex-col gap-3">
          <VisibilityEditor
            def={def}
            condition={page.visibleIf}
            sources={pageSources}
            what="page"
            onChange={(visibleIf) => {
              const { visibleIf: _, ...rest } = page;
              onChangePage(visibleIf ? { visibleIf } : { ...rest, visibleIf: undefined });
            }}
          />
          <PageRulesEditor def={def} pageKey={page.key} onChange={onChangeRules} />
        </div>
      ) : null}
      <IssueList issues={issues} />
      <SortableContext items={page.elements.map((e) => e.key)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cx(
            'flex min-h-16 flex-col gap-3 rounded-xl',
            isOver && page.elements.length === 0 && 'bg-brand-50',
          )}
        >
          {children}
          {page.elements.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
              This page is empty. Add a question or drag one here.
            </p>
          ) : null}
        </div>
      </SortableContext>
      <AddElementMenu onAdd={onAdd} />
    </section>
  );
}

function ElementCard({
  def,
  element,
  number,
  selected,
  issues,
  pages,
  currentPage,
  onSelect,
  onChange,
  onDuplicate,
  onMove,
  onMoveToPage,
  onDelete,
}: {
  def: SurveyDefinition;
  element: Element;
  number: number | undefined;
  selected: boolean;
  issues: Issue[];
  pages: Page[];
  currentPage: string;
  onSelect: () => void;
  onChange: (element: Element) => void;
  onDuplicate: () => void;
  onMove: (delta: -1 | 1) => void;
  onMoveToPage: (pageKey: string) => void;
  onDelete: () => void;
}) {
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: element.key,
  });
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const title =
    element.kind === 'question'
      ? element.title.trim() || 'Untitled question'
      : element.body.trim().split('\n')[0] || 'Empty text block';
  const label = element.kind === 'question' ? `Question ${number}` : 'Text block';

  return (
    <div
      ref={setNodeRef}
      id={`el-${element.key}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx(
        'rounded-xl border bg-white shadow-sm',
        selected ? 'border-brand-500 ring-2 ring-brand-100' : 'border-line',
        isDragging && 'opacity-40',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          ref={setActivatorNodeRef}
          {...listeners}
          aria-hidden="true"
          title="Drag to reorder"
          className="cursor-grab touch-none rounded px-1.5 py-1 text-muted hover:text-ink"
        >
          ⠿
        </span>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
          onClick={onSelect}
          aria-expanded={selected}
        >
          <span className="shrink-0 text-sm font-semibold text-muted">
            {element.kind === 'question' ? `${number}.` : '¶'}
          </span>
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          <span className="shrink-0 text-xs text-muted">
            {element.kind === 'question' ? QUESTION_TYPE_META[element.type].label : 'Text'}
          </span>
          {element.kind === 'question' && element.required ? <Badge>Required</Badge> : null}
          {element.visibleIf ? <Badge className="bg-brand-50 text-brand-700">Conditional</Badge> : null}
          {errorCount ? <Badge className="bg-red-100 text-red-800">⚠ {errorCount}</Badge> : null}
        </button>
        <div className="flex shrink-0 items-center">
          <Button size="sm" variant="ghost" aria-label={`Move ${label} up`} onClick={() => onMove(-1)}>
            ↑
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Move ${label} down`} onClick={() => onMove(1)}>
            ↓
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Duplicate ${label}`} onClick={onDuplicate}>
            ⧉
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Delete ${label}`} onClick={onDelete}>
            ✕
          </Button>
        </div>
      </div>
      {selected ? (
        <div className="border-t border-line px-4 py-4">
          <ElementEditor element={element} issues={issues} def={def} pageKey={currentPage} onChange={onChange} />
          {pages.length > 1 ? (
            <label className="mt-4 flex items-center gap-2 text-sm text-muted">
              Move to
              <select
                className="min-w-0 max-w-full rounded-md border border-line px-2 py-1 text-sm text-ink"
                value={currentPage}
                onChange={(e) => onMoveToPage(e.target.value)}
              >
                {pages.map((p, i) => (
                  <option key={p.key} value={p.key}>
                    Page {i + 1}
                    {p.title ? `: ${readableTokens(p.title, new Map())}` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AddElementMenu({ onAdd }: { onAdd: (element: Element) => void }) {
  const [open, setOpen] = useState(false);
  const [bank, setBank] = useState(false);
  const pick = (element: Element) => {
    onAdd(element);
    setOpen(false);
  };
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          + Add question
        </Button>
        <Button size="sm" variant="ghost" onClick={() => pick(createTextBlock(''))}>
          + Add text
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setBank(true)}>
          + From question bank
        </Button>
      </div>
      <BankDialog
        open={bank}
        onClose={() => setBank(false)}
        onPick={(q) => {
          setBank(false);
          pick(q);
        }}
      />
      {open ? (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2" aria-label="Question types">
          {QUESTION_TYPES.map((type: QuestionType) => (
            <li key={type}>
              <button
                type="button"
                className="w-full rounded-lg border border-line bg-white px-3 py-2 text-left hover:border-brand-500"
                onClick={() => pick(createQuestion(type, ''))}
              >
                <span className="block text-sm font-medium">{QUESTION_TYPE_META[type].label}</span>
                <span className="block text-xs text-muted">{QUESTION_TYPE_META[type].description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────
function BankDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (q: Element) => void }) {
  const [q, setQ] = useState('');
  const items = useQuery({
    queryKey: ['question-bank', q],
    queryFn: () => get<BankItem[]>(`/question-bank${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`),
    enabled: open,
  });
  return (
    <Dialog open={open} onClose={onClose} title="Question bank" wide>
      <div className="flex flex-col gap-3">
        <TextField label="Search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. satisfaction" />
        {items.isLoading ? <p className="text-sm text-muted">Loading…</p> : null}
        {items.error ? <Alert tone="error">{errorMessage(items.error)}</Alert> : null}
        {items.data && items.data.length === 0 ? (
          <p className="text-sm text-muted">
            {q ? 'No saved questions match.' : 'No saved questions yet. Open a question and choose "Save to question bank".'}
          </p>
        ) : null}
        <ul className="flex flex-col divide-y divide-line">
          {(items.data ?? []).map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{item.question.title}</div>
                <div className="text-xs text-muted">
                  {QUESTION_TYPE_META[item.question.type].label}
                  {item.tags.length ? ` · ${item.tags.join(', ')}` : ''}
                  {item.createdBy ? ` · added by ${item.createdBy}` : ''}
                </div>
              </div>
              {/* Fresh keys every time, so the same bank question can be inserted twice. */}
              <Button size="sm" onClick={() => onPick(bankQuestion(item.question))}>
                Insert
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

function SurveySettingsDialog({
  open,
  onClose,
  definition,
  anonymous,
  update,
}: {
  open: boolean;
  onClose: () => void;
  definition: SurveyDefinition;
  anonymous: boolean;
  update: DraftApi['update'];
}) {
  const settings = definition.settings;
  const setSettings = (patch: Partial<SurveyDefinition['settings']>) =>
    update((def) => ({ ...def, settings: { ...def.settings, ...patch } }));
  const fields = definition.hiddenFields;
  const setFields = (next: SurveyDefinition['hiddenFields']) =>
    update((def) => ({ ...def, hiddenFields: next }));
  const lastPage = definition.pages.at(-1)!.key;
  const sources = useMemo(() => sourcesBefore(definition, { pageKey: lastPage, throughPage: true }), [definition, lastPage]);
  const setThankYou = (patch: Partial<SurveyDefinition['settings']['thankYou']>) => {
    const next = { ...settings.thankYou, ...patch } as Record<string, unknown>;
    for (const k of ['redirectUrl', 'appendHiddenFields']) if (next[k] === '' || next[k] === false || next[k] === undefined) delete next[k];
    setSettings({ thankYou: next as SurveyDefinition['settings']['thankYou'] });
  };
  const thankTitle = usePipeTarget(settings.thankYou.title, (v) => setThankYou({ title: v }));
  const thankBody = usePipeTarget(settings.thankYou.body, (v) => setThankYou({ body: v }));
  const screenOut = settings.disqualified ?? { title: 'Thank you for your time', body: "Unfortunately you don't qualify for this survey." };
  const usesScreenOut = (definition.logic ?? []).some((r) => 'disqualify' in r.then);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Survey settings"
      wide
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Checkbox
            label="Show a progress bar"
            checked={settings.showProgressBar}
            onChange={(e) => setSettings({ showProgressBar: e.target.checked })}
          />
          <Checkbox
            label="Let respondents go back to earlier pages"
            checked={settings.allowBack}
            onChange={(e) => setSettings({ allowBack: e.target.checked })}
          />
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Thank-you page</legend>
          <div className="flex justify-end">
            <PipeMenu sources={sources} onInsert={thankBody.insert} label="Insert answer in message" />
          </div>
          <TextField label="Title" value={settings.thankYou.title} onChange={(e) => setThankYou({ title: e.target.value })} {...thankTitle.trackProps} />
          <TextArea label="Message" rows={3} value={settings.thankYou.body} onChange={(e) => setThankYou({ body: e.target.value })} {...thankBody.trackProps} />
          <TextField
            label="Then send respondents to (optional)"
            type="url"
            placeholder="https://example.com/thanks"
            hint="Redirects straight after submitting. Use {{q.…}} or {{param.…}} tokens to pass answers along."
            value={settings.thankYou.redirectUrl ?? ''}
            onChange={(e) => setThankYou({ redirectUrl: e.target.value })}
          />
          {settings.thankYou.redirectUrl ? (
            <Checkbox
              label="Add the hidden fields to the redirect URL"
              hint="For example, panel providers often need their respondent ID passed back."
              checked={Boolean(settings.thankYou.appendHiddenFields)}
              onChange={(e) => setThankYou({ appendHiddenFields: e.target.checked })}
            />
          ) : null}
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Screen-out message</legend>
          <p className="text-sm text-muted">
            {usesScreenOut ? 'Shown to respondents a logic rule screens out.' : 'Shown when a logic rule screens a respondent out. No rule does yet.'}
          </p>
          <TextField label="Title" value={screenOut.title} onChange={(e) => setSettings({ disqualified: { ...screenOut, title: e.target.value } })} />
          <TextArea label="Message" rows={2} value={screenOut.body} onChange={(e) => setSettings({ disqualified: { ...screenOut, body: e.target.value } })} />
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">Hidden fields</legend>
          <p className="text-sm text-muted">
            Values passed in the survey link (for example <code>?source=newsletter</code>) are stored with
            each response. Only fields declared here are kept.
            {anonymous
              ? ' This survey is anonymous: only fields marked as non-identifying are collected.'
              : ''}
          </p>
          {fields.map((field, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <TextField
                label="URL parameter"
                className="w-48"
                value={field.key}
                onChange={(e) =>
                  setFields(
                    fields.map((f, j) =>
                      j === i ? { ...f, key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') } : f,
                    ),
                  )
                }
              />
              <Checkbox
                className="mb-2"
                label="Non-identifying"
                checked={Boolean(field.nonIdentifying)}
                onChange={(e) =>
                  setFields(
                    fields.map((f, j) =>
                      j === i ? { ...f, nonIdentifying: e.target.checked || undefined } : f,
                    ),
                  )
                }
              />
              <Button
                size="sm"
                variant="ghost"
                className="mb-1"
                aria-label={`Remove hidden field ${field.key}`}
                onClick={() => setFields(fields.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            className="self-start"
            onClick={() => setFields([...fields, { key: `field${fields.length + 1}` }])}
          >
            Add hidden field
          </Button>
        </fieldset>
      </div>
    </Dialog>
  );
}

function ProblemsDialog({
  open,
  onClose,
  issues,
  numbers,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  issues: Issue[];
  numbers: Map<string, number>;
  onPick: (key: string) => void;
}) {
  const sorted = [...issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1,
  );
  return (
    <Dialog open={open} onClose={onClose} title="Problems and suggestions" wide>
      {sorted.length === 0 ? (
        <p className="text-sm">No problems found.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {sorted.map((issue, i) => {
            const key = issue.elementKey ?? issue.pageKey;
            const where =
              issue.elementKey && numbers.has(issue.elementKey)
                ? `Question ${numbers.get(issue.elementKey)}`
                : issue.pageKey
                  ? 'Page'
                  : 'Survey';
            return (
              <li key={i} className="py-2">
                <button
                  type="button"
                  className="w-full text-left text-sm disabled:cursor-default"
                  disabled={!key}
                  onClick={() => key && onPick(key)}
                >
                  <span
                    className={
                      issue.severity === 'error' ? 'font-medium text-red-700' : 'font-medium text-amber-800'
                    }
                  >
                    {issue.severity === 'error' ? 'Must fix' : 'Suggestion'}
                  </span>
                  <span className="text-muted"> · {where}: </span>
                  {issue.message}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

function PublishDialog({
  open,
  onClose,
  survey,
  d,
  errors,
  onPublished,
}: {
  open: boolean;
  onClose: () => void;
  survey: SurveyDetail;
  d: DraftApi;
  errors: Issue[];
  onPublished: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const next = (survey.currentVersionNumber ?? 0) + 1;
  // Phase 3A: with approvals on, publishing sends the draft for review instead.
  const org = useQuery({ queryKey: ['org'], queryFn: () => get<Org>('/org'), enabled: open });
  const needsApproval = org.data?.approvalRequired ?? false;

  const publish = async () => {
    setBusy(true);
    setProblem(null);
    setServerErrors([]);
    try {
      if (!(await d.flush())) throw new Error('Your latest changes could not be saved. Resolve that first.');
      const result = await post<PublishResult | ApprovalPending>(`/surveys/${survey.id}/publish`, {
        revision: d.revision(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if ('approvalRequest' in result) {
        setSent(true);
        onPublished();
        return;
      }
      d.markPublished();
      onPublished();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'publish_blocked')
        setServerErrors((e.problem?.errors ?? []).map((x) => x.message));
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        setSent(false);
        onClose();
      }}
      title={needsApproval ? 'Send for approval?' : survey.currentVersionNumber ? `Publish version ${next}?` : 'Publish survey?'}
      footer={
        sent ? (
          <Button
            variant="primary"
            onClick={() => {
              setSent(false);
              onClose();
            }}
          >
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={errors.length > 0} onClick={() => void publish()}>
              {needsApproval ? 'Send for approval' : 'Publish'}
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <Alert tone="success">
          Sent for approval. An approver will review this exact draft; you'll be notified when they decide. Editing the draft withdraws
          the request.
        </Alert>
      ) : errors.length ? (
        <Alert tone="error">
          Fix {errors.length === 1 ? 'this problem' : `these ${errors.length} problems`} first:
          <ul className="mt-2 list-disc pl-5">
            {errors.slice(0, 8).map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </Alert>
      ) : needsApproval ? null : survey.currentVersionNumber ? (
        <p className="text-sm">
          New respondents will get version {next}. People who already started keep version{' '}
          {survey.currentVersionNumber}, and their answers stay linked to it.
        </p>
      ) : (
        <p className="text-sm">
          The survey goes live with a public link you can share. You can keep editing afterwards: changes go
          into a new version.
        </p>
      )}
      {needsApproval && !sent && !errors.length ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-sm text-muted">Your organization requires approval: it goes live when an approver approves it.</p>
          <TextArea label="Note for the approver (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </div>
      ) : null}
      {problem ? (
        <Alert tone="error" className="mt-3">
          {problem}
          {serverErrors.length ? (
            <ul className="mt-2 list-disc pl-5">
              {serverErrors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </Dialog>
  );
}
