/**
 * Results analysis tools (Phase 2B): the filter builder (same grammar as survey logic), segments
 * side by side, cross-tab with chi-square, drop-off by question, word frequencies, live updates,
 * asynchronous exports and scheduled reports.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CrosstabResult,
  Distribution,
  DropoffByQuestion,
  ExportFormat,
  ExportJob,
  Member,
  PageResult,
  QuestionSummary,
  ResultFilter,
  ResultsSummary,
  ScheduledReport,
  Tag,
  TermsResult,
} from '@survey/contracts';
import { del, errorMessage, get, post, put } from '../../api';
import { BarList, DataTable } from '../../components/charts';
import { Alert, Badge, Button, Card, Checkbox, Dialog, SelectField, TextField, cx } from '../../components/ui';
import { formatDateTime, formatNumber } from '../../lib/format';

// ── Filter builder ───────────────────────────────────────────────────────
type SourceKind = 'choice' | 'multi' | 'number' | 'text' | 'date' | 'presence' | 'hidden' | 'status' | 'device' | 'tag' | 'started' | 'link';
interface Source {
  id: string;
  label: string;
  kind: SourceKind;
  options?: { key: string; label: string }[];
  ref?: { question: string; sub?: string } | { hidden: string };
}

export interface FilterContext {
  questions: QuestionSummary[];
  hiddenFields: string[];
  tags: Tag[];
  links: Distribution[];
}

function sourcesFor(ctx: FilterContext): Source[] {
  const out: Source[] = [];
  ctx.questions.forEach((q, i) => {
    const label = `Q${i + 1}. ${q.title.length > 50 ? `${q.title.slice(0, 49)}…` : q.title}`;
    const ref = { question: q.questionKey };
    switch (q.type) {
      case 'single_choice':
      case 'dropdown':
      case 'likert':
        out.push({ id: `q:${q.questionKey}`, label, kind: 'choice', options: q.options, ref });
        break;
      case 'multi_choice':
        out.push({ id: `q:${q.questionKey}`, label, kind: 'multi', options: q.options, ref });
        break;
      case 'matrix':
        for (const row of q.rows)
          out.push({ id: `q:${q.questionKey}:${row.key}`, label: `${label} › ${row.label}`, kind: 'choice', options: q.columns, ref: { question: q.questionKey, sub: row.key } });
        break;
      case 'rating':
      case 'nps':
      case 'slider':
        out.push({ id: `q:${q.questionKey}`, label, kind: 'number', ref });
        break;
      case 'short_text':
      case 'long_text':
      case 'email':
      case 'phone':
        out.push({ id: `q:${q.questionKey}`, label, kind: 'text', ref });
        break;
      case 'date':
        out.push({ id: `q:${q.questionKey}`, label, kind: 'date', ref });
        break;
      default:
        out.push({ id: `q:${q.questionKey}`, label, kind: 'presence', ref });
    }
  });
  for (const h of ctx.hiddenFields) out.push({ id: `h:${h}`, label: `Hidden field "${h}"`, kind: 'hidden', ref: { hidden: h } });
  out.push({ id: 'f:status', label: 'Response status', kind: 'status' });
  out.push({ id: 'f:device', label: 'Device', kind: 'device' });
  out.push({ id: 'f:started', label: 'Started on', kind: 'started' });
  if (ctx.tags.length) out.push({ id: 'f:tag', label: 'Tag', kind: 'tag', options: ctx.tags.map((t) => ({ key: t.id, label: t.name })) });
  if (ctx.links.length > 1) out.push({ id: 'f:link', label: 'Link', kind: 'link', options: ctx.links.map((l) => ({ key: l.id, label: l.name })) });
  return out;
}

const OPS: Record<SourceKind, { op: string; label: string }[]> = {
  choice: [
    { op: 'in', label: 'is any of' },
    { op: 'not_in', label: 'is none of' },
    { op: 'answered', label: 'is answered' },
    { op: 'not_answered', label: 'is not answered' },
  ],
  multi: [
    { op: 'contains_any', label: 'includes any of' },
    { op: 'contains_all', label: 'includes all of' },
    { op: 'contains_none', label: 'includes none of' },
    { op: 'answered', label: 'is answered' },
    { op: 'not_answered', label: 'is not answered' },
  ],
  number: [
    { op: 'gte', label: 'is at least' },
    { op: 'lte', label: 'is at most' },
    { op: 'eq', label: 'is' },
    { op: 'between', label: 'is between' },
    { op: 'answered', label: 'is answered' },
  ],
  text: [
    { op: 'text_contains', label: 'contains' },
    { op: 'eq', label: 'is exactly' },
    { op: 'answered', label: 'is answered' },
    { op: 'not_answered', label: 'is not answered' },
  ],
  date: [
    { op: 'gte', label: 'is on or after' },
    { op: 'lte', label: 'is on or before' },
    { op: 'between', label: 'is between' },
    { op: 'answered', label: 'is answered' },
  ],
  presence: [
    { op: 'answered', label: 'is answered' },
    { op: 'not_answered', label: 'is not answered' },
  ],
  hidden: [
    { op: 'eq', label: 'is' },
    { op: 'neq', label: 'is not' },
    { op: 'text_contains', label: 'contains' },
    { op: 'answered', label: 'is set' },
    { op: 'not_answered', label: 'is not set' },
  ],
  status: [{ op: 'in', label: 'is any of' }],
  device: [{ op: 'in', label: 'is any of' }],
  tag: [
    { op: 'in', label: 'has any of' },
    { op: 'not_in', label: 'has none of' },
  ],
  link: [{ op: 'in', label: 'is any of' }],
  started: [
    { op: 'gte', label: 'on or after' },
    { op: 'lte', label: 'on or before' },
  ],
};
const FIXED: Partial<Record<SourceKind, { key: string; label: string }[]>> = {
  status: [
    { key: 'completed', label: 'Completed' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'disqualified', label: 'Screened out' },
  ],
  device: [
    { key: 'desktop', label: 'Desktop' },
    { key: 'mobile', label: 'Mobile' },
    { key: 'tablet', label: 'Tablet' },
  ],
};

interface Row {
  source: string;
  op: string;
  value: string | string[];
  value2?: string;
}
export interface FilterState {
  mode: 'all' | 'any';
  rows: Row[];
}
export const emptyFilter = (): FilterState => ({ mode: 'all', rows: [] });

function rowToFilter(row: Row, source: Source): ResultFilter | null {
  const list = Array.isArray(row.value) ? row.value : row.value ? [row.value] : [];
  const needsValue = !['answered', 'not_answered'].includes(row.op);
  if (needsValue && !list.length) return null;
  const num = (v: string) => Number(v);
  switch (source.kind) {
    case 'choice':
    case 'multi':
    case 'presence':
      return { ...(source.ref as { question: string; sub?: string }), op: row.op as never, ...(needsValue ? { value: list } : {}) };
    case 'number':
      if (!needsValue) return { ...(source.ref as { question: string }), op: 'answered' };
      return { ...(source.ref as { question: string }), op: row.op as never, value: row.op === 'between' ? [num(list[0]!), num(row.value2 ?? '')] : num(list[0]!) };
    case 'text':
      return { ...(source.ref as { question: string }), op: row.op as never, ...(needsValue ? { value: list[0]! } : {}) };
    case 'date':
      if (!needsValue) return { ...(source.ref as { question: string }), op: 'answered' };
      if (row.op === 'between') return { ...(source.ref as { question: string }), op: 'between', value: [list[0]!, row.value2 ?? ''] };
      return { ...(source.ref as { question: string }), op: row.op === 'gte' ? 'gte' : 'lte', value: list[0]! } as ResultFilter;
    case 'hidden':
      return { ...(source.ref as { hidden: string }), op: row.op as never, ...(needsValue ? { value: list[0]! } : {}) };
    case 'status':
      return { field: 'status', op: 'in', value: list };
    case 'device':
      return { field: 'deviceType', op: 'in', value: list };
    case 'tag':
      return { field: 'tag', op: row.op === 'not_in' ? 'not_in' : 'in', value: list };
    case 'link':
      return { field: 'distributionId', op: 'in', value: list };
    case 'started': {
      const day = list[0]!;
      const iso = row.op === 'gte' ? new Date(`${day}T00:00:00`).toISOString() : new Date(new Date(`${day}T00:00:00`).getTime() + 86_400_000 - 1).toISOString();
      return { field: 'startedAt', op: row.op === 'gte' ? 'gte' : 'lte', value: iso };
    }
  }
}

export function toResultFilter(state: FilterState, sources: Source[]): ResultFilter | undefined {
  const parts = state.rows
    .map((r) => {
      const source = sources.find((s) => s.id === r.source);
      return source ? rowToFilter(r, source) : null;
    })
    .filter((f): f is ResultFilter => Boolean(f));
  if (!parts.length) return undefined;
  return state.mode === 'all' ? { all: parts } : { any: parts };
}

export function useFilterSources(ctx: FilterContext) {
  return useMemo(() => sourcesFor(ctx), [ctx]);
}

export function FilterBuilder({ state, onChange, sources, idPrefix }: { state: FilterState; onChange: (s: FilterState) => void; sources: Source[]; idPrefix: string }) {
  const setRow = (i: number, row: Row | null) => onChange({ ...state, rows: row ? state.rows.map((r, j) => (j === i ? row : r)) : state.rows.filter((_, j) => j !== i) });
  const add = () => {
    const first = sources[0];
    if (first) onChange({ ...state, rows: [...state.rows, { source: first.id, op: OPS[first.kind][0]!.op, value: [] }] });
  };
  return (
    <div className="flex flex-col gap-2">
      {state.rows.length > 1 ? (
        <label className="flex items-center gap-2 text-sm">
          Match
          <select className="rounded-md border border-line bg-white px-2 py-1 text-sm" value={state.mode} onChange={(e) => onChange({ ...state, mode: e.target.value as 'all' | 'any' })}>
            <option value="all">all conditions (AND)</option>
            <option value="any">any condition (OR)</option>
          </select>
        </label>
      ) : null}
      <ul className="flex flex-col gap-2">
        {state.rows.map((row, i) => {
          const source = sources.find((s) => s.id === row.source) ?? sources[0]!;
          const ops = OPS[source.kind];
          const options = source.options ?? FIXED[source.kind];
          const needsValue = !['answered', 'not_answered'].includes(row.op);
          const id = `${idPrefix}-${i}`;
          const list = Array.isArray(row.value) ? row.value : row.value ? [row.value] : [];
          return (
            <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-2">
              <label className="sr-only" htmlFor={`${id}-src`}>
                Field
              </label>
              <select
                id={`${id}-src`}
                className="w-full min-w-0 rounded-md border border-line bg-white px-2 py-1 text-sm sm:w-auto sm:max-w-xs"
                value={source.id}
                onChange={(e) => {
                  const next = sources.find((s) => s.id === e.target.value)!;
                  setRow(i, { source: next.id, op: OPS[next.kind][0]!.op, value: [] });
                }}
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor={`${id}-op`}>
                Comparison
              </label>
              <select id={`${id}-op`} className="rounded-md border border-line bg-white px-2 py-1 text-sm" value={row.op} onChange={(e) => setRow(i, { ...row, op: e.target.value })}>
                {ops.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </select>
              {needsValue && options ? (
                <fieldset className="flex w-full flex-wrap gap-x-3 gap-y-1">
                  <legend className="sr-only">Values</legend>
                  {options.map((o) => (
                    <label key={o.key} className="flex items-center gap-1 text-sm">
                      <input type="checkbox" checked={list.includes(o.key)} onChange={(e) => setRow(i, { ...row, value: e.target.checked ? [...list, o.key] : list.filter((k) => k !== o.key) })} />
                      {o.label}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {needsValue && !options ? (
                <>
                  <input
                    aria-label="Value"
                    className="w-40 rounded-md border border-line bg-white px-2 py-1 text-sm"
                    type={source.kind === 'number' ? 'number' : source.kind === 'date' || source.kind === 'started' ? 'date' : 'text'}
                    value={list[0] ?? ''}
                    onChange={(e) => setRow(i, { ...row, value: e.target.value ? [e.target.value] : [] })}
                  />
                  {row.op === 'between' ? (
                    <>
                      <span className="text-sm">and</span>
                      <input
                        aria-label="Upper value"
                        className="w-40 rounded-md border border-line bg-white px-2 py-1 text-sm"
                        type={source.kind === 'number' ? 'number' : 'date'}
                        value={row.value2 ?? ''}
                        onChange={(e) => setRow(i, { ...row, value2: e.target.value })}
                      />
                    </>
                  ) : null}
                </>
              ) : null}
              <Button size="sm" variant="ghost" aria-label="Remove condition" onClick={() => setRow(i, null)}>
                ✕
              </Button>
            </li>
          );
        })}
      </ul>
      <Button size="sm" className="self-start" onClick={add} disabled={!sources.length || state.rows.length >= 20}>
        + Condition
      </Button>
    </div>
  );
}

// ── Segments side by side ────────────────────────────────────────────────
export interface SegmentState {
  name: string;
  filter: FilterState;
}

export function SegmentComparison({ segments, names }: { segments: { name: string; summary: ResultsSummary | null; suppressed: boolean }[]; names: string[] }) {
  if (!segments.length) return null;
  const base = segments.find((s) => s.summary)?.summary;
  if (!base) return <Alert tone="info">Every segment is too small to show in this anonymous survey.</Alert>;
  const choice = base.questions.filter((q) => ['single_choice', 'dropdown', 'likert', 'multi_choice'].includes(q.type)) as Extract<QuestionSummary, { type: 'single_choice' | 'multi_choice' | 'dropdown' | 'likert' }>[];
  const numeric = base.questions.filter((q) => q.type === 'rating' || q.type === 'nps' || q.type === 'slider');
  const statOf = (s: ResultsSummary | null, key: string) => {
    const q = s?.questions.find((x) => x.questionKey === key);
    if (!q) return '—';
    if (q.type === 'nps') return q.score ?? '—';
    if (q.type === 'rating' || q.type === 'slider') return q.mean ?? '—';
    return '—';
  };
  return (
    <Card title="Segments side by side">
      <div className="flex flex-col gap-6">
        <DataTable
          caption="Responses per segment"
          columns={['', ...names]}
          rows={[
            ['Completed', ...segments.map((s) => (s.suppressed ? 'hidden' : formatNumber(s.summary!.totals.completed)))],
            ['Completion rate', ...segments.map((s) => (s.summary?.totals.completionRate == null ? '—' : `${Math.round(s.summary.totals.completionRate * 100)}%`))],
            ...numeric.map((q) => [`${q.title} (${q.type === 'nps' ? 'NPS' : 'average'})`, ...segments.map((s) => (s.suppressed ? 'hidden' : String(statOf(s.summary, q.questionKey))))]),
          ]}
        />
        {choice.map((q) => (
          <DataTable
            key={q.questionKey}
            caption={q.title}
            columns={['Option', ...names]}
            rows={q.options.map((o) => [
              o.label,
              ...segments.map((s) => {
                if (s.suppressed) return 'hidden';
                const sq = s.summary!.questions.find((x) => x.questionKey === q.questionKey) as typeof q | undefined;
                const opt = sq?.options.find((x) => x.key === o.key);
                return opt ? `${opt.pct}% (${formatNumber(opt.count)})` : '0%';
              }),
            ])}
          />
        ))}
        {segments.some((s) => s.suppressed) ? <p className="text-xs text-muted">"hidden": too few responses to show in an anonymous survey.</p> : null}
      </div>
    </Card>
  );
}

// ── Cross-tab ────────────────────────────────────────────────────────────
export function CrosstabCard({ surveyId, questions, scope }: { surveyId: string; questions: QuestionSummary[]; scope: Record<string, unknown> }) {
  const axes = useMemo(() => {
    const out: { id: string; label: string; ref: { questionKey: string; subKey?: string } }[] = [];
    questions.forEach((q, i) => {
      if (['single_choice', 'dropdown', 'likert', 'multi_choice'].includes(q.type)) out.push({ id: q.questionKey, label: `Q${i + 1}. ${q.title}`, ref: { questionKey: q.questionKey } });
      if (q.type === 'matrix') for (const r of q.rows) out.push({ id: `${q.questionKey}:${r.key}`, label: `Q${i + 1}. ${q.title} › ${r.label}`, ref: { questionKey: q.questionKey, subKey: r.key } });
    });
    return out;
  }, [questions]);
  const [rowsId, setRowsId] = useState('');
  const [colsId, setColsId] = useState('');
  const [view, setView] = useState<'count' | 'row' | 'col'>('row');
  const rows = axes.find((a) => a.id === rowsId);
  const cols = axes.find((a) => a.id === colsId);
  const result = useQuery({
    queryKey: ['crosstab', surveyId, rowsId, colsId, JSON.stringify(scope)],
    queryFn: () => post<CrosstabResult>(`/surveys/${surveyId}/results/crosstab`, { ...scope, rows: rows!.ref, columns: cols!.ref }),
    enabled: Boolean(rows && cols && rowsId !== colsId),
  });
  if (axes.length < 2) return null;
  const data = result.data;
  const cell = (i: number, j: number) => (view === 'count' ? formatNumber(data!.counts[i]![j]!) : `${(view === 'row' ? data!.rowPct : data!.columnPct)[i]![j]}%`);
  return (
    <Card title="Cross-tab">
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <SelectField label="Rows" value={rowsId} onChange={(e) => setRowsId(e.target.value)}>
            <option value="">Choose a question…</option>
            {axes.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </SelectField>
          <SelectField label="Columns" value={colsId} onChange={(e) => setColsId(e.target.value)}>
            <option value="">Choose a question…</option>
            {axes.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </SelectField>
          <SelectField label="Show" value={view} onChange={(e) => setView(e.target.value as typeof view)}>
            <option value="row">Row %</option>
            <option value="col">Column %</option>
            <option value="count">Counts</option>
          </SelectField>
        </div>
        {result.error ? <Alert tone="error">{errorMessage(result.error)}</Alert> : null}
        {rowsId && rowsId === colsId ? <p className="text-sm text-muted">Choose two different questions.</p> : null}
        {data && rows && cols ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  {rows.label} by {cols.label}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="px-2 py-1 text-left font-medium text-muted">
                      <span className="sr-only">Rows</span>
                    </th>
                    {data.columns.map((c) => (
                      <th key={c.key} scope="col" className="px-2 py-1 text-right font-medium">
                        {c.label}
                      </th>
                    ))}
                    <th scope="col" className="px-2 py-1 text-right font-medium text-muted">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={r.key} className="border-t border-line">
                      <th scope="row" className="px-2 py-1.5 text-left font-medium">
                        {r.label}
                      </th>
                      {data.columns.map((c, j) => (
                        <td key={c.key} className="tabular px-2 py-1.5 text-right" style={{ background: `color-mix(in srgb, #2a78d6 ${Math.round(((view === 'col' ? data.columnPct : data.rowPct)[i]![j]! / 100) * 40)}%, white)` }}>
                          {cell(i, j)}
                        </td>
                      ))}
                      <td className="tabular px-2 py-1.5 text-right text-muted">{formatNumber(data.rowTotals[i]!)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-line text-muted">
                    <th scope="row" className="px-2 py-1.5 text-left font-medium">
                      Total
                    </th>
                    {data.columnTotals.map((t, j) => (
                      <td key={j} className="tabular px-2 py-1.5 text-right">
                        {formatNumber(t)}
                      </td>
                    ))}
                    <td className="tabular px-2 py-1.5 text-right">{formatNumber(data.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {data.chiSquare ? (
              <p className="text-sm">
                Chi-square = {data.chiSquare.value}, {data.chiSquare.df} degree{data.chiSquare.df === 1 ? '' : 's'} of freedom, p ={' '}
                {data.chiSquare.p < 0.0001 ? '< 0.0001' : data.chiSquare.p}.{' '}
                <strong>{data.chiSquare.p < 0.05 ? 'The answers are related (significant at the 5% level).' : 'No significant relationship at the 5% level.'}</strong>
              </p>
            ) : null}
            {data.warnings.map((w) => (
              <p key={w} className="text-xs text-amber-800">
                ⓘ {w}
              </p>
            ))}
          </>
        ) : null}
      </div>
    </Card>
  );
}

// ── Drop-off by question ─────────────────────────────────────────────────
export function DropoffCard({ surveyId, scope }: { surveyId: string; scope: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const data = useQuery({
    queryKey: ['dropoff', surveyId, JSON.stringify(scope)],
    queryFn: () => post<DropoffByQuestion>(`/surveys/${surveyId}/results/dropoff`, scope),
    enabled: open,
  });
  const d = data.data;
  return (
    <Card
      title="Drop-off by question"
      actions={
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      }
    >
      {!open ? <p className="text-sm text-muted">Where people stop answering, question by question (current version).</p> : null}
      {open && data.error ? <Alert tone="error">{errorMessage(data.error)}</Alert> : null}
      {open && d ? (
        <div className="flex flex-col gap-3">
          <BarList
            ariaLabel="Responses that answered each question"
            rows={d.questions.map((q, i) => ({ key: q.questionKey, label: `${i + 1}. ${q.title}`, count: q.answered, pct: d.started ? Math.round((q.answered / d.started) * 1000) / 10 : 0 }))}
          />
          <DataTable
            caption="People who left right after each question"
            columns={['Question', 'Answered', 'Left after it']}
            rows={[
              ['(before answering anything)', '—', formatNumber(d.leftBeforeFirst)],
              ...d.questions.map((q, i) => [`${i + 1}. ${q.title}`, formatNumber(q.answered), formatNumber(q.leftAfter)]),
            ]}
          />
          <p className="text-xs text-muted">Bars: share of the {formatNumber(d.started)} people who started and answered each question.</p>
        </div>
      ) : null}
    </Card>
  );
}

// ── Word frequencies ─────────────────────────────────────────────────────
export function WordCloud({ surveyId, questionKey, filter }: { surveyId: string; questionKey: string; filter?: ResultFilter }) {
  const terms = useQuery({
    queryKey: ['terms', surveyId, questionKey, JSON.stringify(filter ?? null)],
    queryFn: () => get<TermsResult>(`/surveys/${surveyId}/results/questions/${questionKey}/terms${filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : ''}`),
  });
  if (terms.error) return <Alert tone="error">{errorMessage(terms.error)}</Alert>;
  if (!terms.data) return <p className="text-sm text-muted">Counting words…</p>;
  const list = terms.data.terms.slice(0, 50);
  if (!list.length) return <p className="text-sm text-muted">Not enough text yet.</p>;
  const max = list[0]!.count;
  const min = list.at(-1)!.count;
  const size = (n: number) => 0.85 + (max === min ? 0.5 : ((n - min) / (max - min)) * 1.4);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap items-baseline gap-x-3 gap-y-1" aria-label={`Most frequent words in ${formatNumber(terms.data.answered)} answers`}>
        {list.map((t) => (
          <li key={t.term} style={{ fontSize: `${size(t.count)}rem` }} className={cx('leading-tight', t.count === max ? 'font-semibold text-brand-700' : 'text-ink')} title={`${t.term}: ${t.count}`}>
            {t.term}
            <span className="sr-only">: {t.count} answers</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">Word size shows in how many of the {formatNumber(terms.data.answered)} answers a word appears. Common words are left out.</p>
    </div>
  );
}

// ── Live updates ─────────────────────────────────────────────────────────
/** Subscribes to the survey's live stream; returns whether it's connected (else the page polls). */
export function useLiveUpdates(surveyId: string, onUpdate: () => void): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource(`/api/v1/surveys/${surveyId}/live`);
    source.addEventListener('ready', () => setConnected(true));
    source.addEventListener('update', () => onUpdate());
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [surveyId]); // eslint-disable-line react-hooks/exhaustive-deps
  return connected;
}

// ── Exports ──────────────────────────────────────────────────────────────
export function ExportDialog({ open, onClose, surveyId, csvParams, scope }: { open: boolean; onClose: () => void; surveyId: string; csvParams: URLSearchParams; scope: Record<string, unknown> }) {
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [layout, setLayout] = useState<'compact' | 'expanded'>('compact');
  const [all, setAll] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const options = { layout, status: all ? 'all' : 'completed', includeTest: scope.includeTest, excludeFlagged: scope.excludeFlagged, from: scope.from, to: scope.to, versionId: scope.versionId, filter: scope.filter };
  const create = useMutation({
    mutationFn: () => post<ExportJob>(`/surveys/${surveyId}/exports`, { format, ...options }),
    onSuccess: (job) => {
      setJobId(job.id);
      void queryClient.invalidateQueries({ queryKey: ['exports', surveyId] });
    },
  });
  const job = useQuery({
    queryKey: ['export', jobId],
    queryFn: () => get<ExportJob>(`/exports/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'done' || q.state.data.status === 'failed') ? false : 1000),
  });
  const close = () => {
    setJobId(null);
    onClose();
  };
  const csvLink = new URLSearchParams(csvParams);
  csvLink.delete('includePartial');
  csvLink.set('layout', layout);
  csvLink.set('status', all ? 'all' : 'completed');
  const filtered = Boolean(scope.filter);
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Export responses"
      footer={
        <>
          <Button onClick={close}>{jobId ? 'Close' : 'Cancel'}</Button>
          {format === 'csv' && !filtered ? (
            <a
              href={`/api/v1/surveys/${surveyId}/export.csv?${csvLink}`}
              download
              onClick={() => setTimeout(close, 300)}
              className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
            >
              Download CSV
            </a>
          ) : !jobId ? (
            <Button variant="primary" busy={create.isPending} onClick={() => create.mutate()}>
              Create {format.toUpperCase()}
            </Button>
          ) : null}
        </>
      }
    >
      {jobId ? (
        <ExportStatus job={job.data} error={job.error} />
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">Uses the filters currently applied to the results{filtered ? ', including your answer filter' : ''}.</p>
          <SelectField label="Format" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            <option value="xlsx">Excel (XLSX): every response, one row each</option>
            <option value="csv">CSV: every response, one row each</option>
            <option value="pdf">PDF report: charts and key numbers</option>
          </SelectField>
          {format !== 'pdf' ? (
            <SelectField label="Layout" value={layout} onChange={(e) => setLayout(e.target.value as 'compact' | 'expanded')}>
              <option value="compact">Compact: one column per question</option>
              <option value="expanded">Expanded: one 0/1 column per multiple-choice option</option>
            </SelectField>
          ) : null}
          <Checkbox label="Include partial (unfinished) responses" checked={all} onChange={(e) => setAll(e.target.checked)} />
          {create.error ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
        </div>
      )}
    </Dialog>
  );
}

function ExportStatus({ job, error }: { job: ExportJob | undefined; error: unknown }) {
  if (error) return <Alert tone="error">{errorMessage(error)}</Alert>;
  if (!job || job.status === 'queued' || job.status === 'running')
    return (
      <p className="text-sm" role="status">
        Preparing the file… you can close this window; it will be listed under Recent exports.
      </p>
    );
  if (job.status === 'failed') return <Alert tone="error">The export failed: {job.failure}</Alert>;
  return (
    <div className="flex flex-col gap-2 text-sm" role="status">
      <Alert tone="success">
        Ready: {job.filename} ({formatNumber(job.rowCount ?? 0)} responses, {Math.max(1, Math.round((job.size ?? 0) / 1024))} KB).
      </Alert>
      <a className="font-medium text-brand-600 underline" href={job.downloadUrl ?? '#'} download>
        Download
      </a>
      <p className="text-xs text-muted">Available until {formatDateTime(job.expiresAt)}.</p>
    </div>
  );
}

export function RecentExports({ surveyId, highlight }: { surveyId: string; highlight?: string | null }) {
  const exports = useQuery({
    queryKey: ['exports', surveyId],
    queryFn: () => get<ExportJob[]>(`/surveys/${surveyId}/exports`),
    refetchInterval: (q) => (q.state.data?.some((e) => e.status === 'queued' || e.status === 'running') ? 2000 : false),
  });
  if (!exports.data?.length) return null;
  return (
    <Card title="Recent exports">
      <ul className="flex flex-col divide-y divide-line text-sm">
        {exports.data.map((e) => (
          <li key={e.id} className={cx('flex flex-wrap items-center gap-2 py-2', highlight === e.id && 'bg-brand-50')}>
            <Badge>{e.format.toUpperCase()}</Badge>
            <span className="text-muted">{formatDateTime(e.createdAt)}</span>
            <span className="ml-auto">
              {e.status === 'done' && e.downloadUrl ? (
                <a className="text-brand-600 underline" href={e.downloadUrl} download>
                  Download ({formatNumber(e.rowCount ?? 0)} responses)
                </a>
              ) : e.status === 'done' ? (
                <span className="text-muted">Expired</span>
              ) : e.status === 'failed' ? (
                <span className="text-red-700">Failed</span>
              ) : (
                <span className="text-muted">Preparing…</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Scheduled reports ────────────────────────────────────────────────────
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function ScheduledReportsCard({ surveyId, canManage }: { surveyId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const reports = useQuery({ queryKey: ['scheduled-reports', surveyId], queryFn: () => get<ScheduledReport[]>(`/surveys/${surveyId}/scheduled-reports`), enabled: canManage });
  const [editing, setEditing] = useState<ScheduledReport | 'new' | null>(null);
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['scheduled-reports', surveyId] });
  const remove = useMutation({ mutationFn: (id: string) => del(`/scheduled-reports/${id}`), onSuccess: reload });
  if (!canManage) return null;
  const describe = (r: ScheduledReport) =>
    `${r.frequency === 'daily' ? 'Every day' : r.frequency === 'weekly' ? `Every ${WEEKDAYS[(r.day ?? 1) - 1]}` : `Monthly on day ${r.day}`} at ${String(r.hour).padStart(2, '0')}:00 (${r.timezone})`;
  return (
    <Card
      title="Scheduled reports"
      actions={
        <Button size="sm" onClick={() => setEditing('new')}>
          New schedule
        </Button>
      }
    >
      {reports.data?.length === 0 ? <p className="text-sm text-muted">Email an export to your team on a schedule.</p> : null}
      <ul className="flex flex-col divide-y divide-line text-sm">
        {(reports.data ?? []).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {r.name} <Badge>{r.format.toUpperCase()}</Badge> {!r.active ? <Badge>Paused</Badge> : null}
              </div>
              <div className="text-xs text-muted">
                {describe(r)} · to {r.recipients.map((p) => p.name).join(', ')} · next {formatDateTime(r.nextRunAt)}
                {r.lastStatus ? ` · last: ${r.lastStatus}` : ''}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" busy={remove.isPending && remove.variables === r.id} onClick={() => remove.mutate(r.id)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <ReportDialog surveyId={surveyId} report={editing} onClose={() => setEditing(null)} onSaved={reload} />
    </Card>
  );
}

function ReportDialog({ surveyId, report, onClose, onSaved }: { surveyId: string; report: ScheduledReport | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const open = report !== null;
  const existing = report && report !== 'new' ? report : null;
  const members = useQuery({ queryKey: ['members'], queryFn: () => get<PageResult<Member>>('/org/members'), enabled: open });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const blank = { name: 'Weekly results', frequency: 'weekly' as 'daily' | 'weekly' | 'monthly', day: 1 as number | null, hour: 8, timezone: zone, format: 'pdf' as ExportFormat, recipientIds: [] as string[], active: true };
  const [form, setForm] = useState(blank);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const key = existing?.id ?? (open ? 'new' : null);
  if (open && loadedFor !== key) {
    setLoadedFor(key);
    setForm(existing ? { name: existing.name, frequency: existing.frequency, day: existing.day, hour: existing.hour, timezone: existing.timezone, format: existing.format, recipientIds: existing.recipients.map((r) => r.id), active: existing.active } : blank);
  }
  if (!open && loadedFor !== null) setLoadedFor(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, day: form.frequency === 'daily' ? null : form.day };
      return existing ? put(`/scheduled-reports/${existing.id}`, body) : post(`/surveys/${surveyId}/scheduled-reports`, body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={existing ? 'Edit scheduled report' : 'New scheduled report'}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={!form.recipientIds.length || !form.name.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <SelectField label="Format" value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value as ExportFormat })}>
            <option value="pdf">PDF report</option>
            <option value="xlsx">Excel (XLSX)</option>
            <option value="csv">CSV</option>
          </SelectField>
          <SelectField label="How often" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as 'daily' | 'weekly' | 'monthly', day: e.target.value === 'daily' ? null : 1 })}>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
          </SelectField>
          {form.frequency === 'weekly' ? (
            <SelectField label="On" value={form.day ?? 1} onChange={(e) => setForm({ ...form, day: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </SelectField>
          ) : form.frequency === 'monthly' ? (
            <SelectField label="On day" value={form.day ?? 1} onChange={(e) => setForm({ ...form, day: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => (
                <option key={i} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </SelectField>
          ) : (
            <span />
          )}
          <SelectField label="At" value={form.hour} onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </SelectField>
          <TextField label="Time zone" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} hint="For example Europe/London or America/New_York." />
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-semibold">Send to</legend>
          <p className="mb-2 text-xs text-muted">Members who can see this survey's responses. Their access is checked again before every send.</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {(members.data?.data ?? []).map((m) => (
              <Checkbox
                key={m.userId}
                label={`${m.name} (${m.email})`}
                checked={form.recipientIds.includes(m.userId)}
                onChange={(e) => setForm({ ...form, recipientIds: e.target.checked ? [...form.recipientIds, m.userId] : form.recipientIds.filter((id) => id !== m.userId) })}
              />
            ))}
          </div>
        </fieldset>
        <Checkbox label="Active" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      </div>
    </Dialog>
  );
}
