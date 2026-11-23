/**
 * Builder logic (Phase 2A): the condition editor (show/hide questions and pages), page rules
 * (skip to a page, end, screen out), the read-only logic map, and the piping menu.
 *
 * Only earlier answers can be used, so the source lists are built from what comes before the thing
 * being edited; validateDefinition re-checks everything (and the server re-checks on publish).
 */
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  LIMITS,
  OPERATORS_BY_KIND,
  QUESTION_TYPE_META,
  newKey,
  operandKind,
  type ChoiceOption,
  type Condition,
  type ConditionValue,
  type LeafCondition,
  type NavigationRule,
  type Operand,
  type Operator,
  type Question,
  type SurveyDefinition,
} from '@survey/core';
import { Button, Dialog, cx } from '../../../components/ui';

type Def = SurveyDefinition;

// ── Sources: what a condition can look at ─────────────────────────────────
export interface Source {
  id: string;
  operand: Operand;
  label: string;
  options?: ChoiceOption[];
}

const operandId = (o: Operand) => ('hidden' in o ? `h:${o.hidden}` : `q:${o.question}${o.sub ? `:${o.sub}` : ''}`);
const short = (text: string, n = 48) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * Answers available at a point in the survey: questions on earlier pages, and (for a question)
 * earlier questions on its own page. `throughPage` also includes the whole page (page rules).
 */
export function sourcesBefore(def: Def, at: { pageKey: string; elementKey?: string; throughPage?: boolean }): Source[] {
  const out: Source[] = [];
  let number = 0;
  outer: for (const page of def.pages) {
    for (const element of page.elements) {
      if (page.key === at.pageKey && !at.throughPage && (!at.elementKey || element.key === at.elementKey)) break outer;
      if (element.kind !== 'question') continue;
      number++;
      out.push(...questionSources(element, number));
    }
    if (page.key === at.pageKey) break;
  }
  for (const field of def.hiddenFields)
    if (field.key) out.push({ id: `h:${field.key}`, operand: { hidden: field.key }, label: `Hidden field "${field.key}"` });
  return out;
}

function questionSources(q: Question, number: number): Source[] {
  const label = `Q${number}. ${short(q.title || 'Untitled question')}`;
  if (q.type === 'matrix')
    return [
      { id: `q:${q.key}`, operand: { question: q.key }, label },
      ...q.rows.map((row) => ({
        id: `q:${q.key}:${row.key}`,
        operand: { question: q.key, sub: row.key },
        label: `${label} › ${short(row.label, 30)}`,
        options: q.options,
      })),
    ];
  if (q.type === 'ranking')
    return [
      { id: `q:${q.key}`, operand: { question: q.key }, label },
      ...q.options.map((o) => ({
        id: `q:${q.key}:${o.key}`,
        operand: { question: q.key, sub: o.key },
        label: `${label} › rank of "${short(o.label, 24)}"`,
      })),
    ];
  return [{ id: `q:${q.key}`, operand: { question: q.key }, label, options: 'options' in q ? q.options : undefined }];
}

// ── Describing conditions in words (logic map, summaries) ─────────────────
const OP_LABEL: Record<Operator, string> = {
  answered: 'is answered',
  not_answered: 'is not answered',
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is none of',
  contains_any: 'includes any of',
  contains_all: 'includes all of',
  contains_none: 'includes none of',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  text_contains: 'contains',
};
const opLabel = (op: Operator, kind: string | null) =>
  kind === 'date' && op === 'gt' ? 'is after' : kind === 'date' && op === 'lt' ? 'is before' : OP_LABEL[op];

function findQuestion(def: Def, key: string): Question | undefined {
  for (const p of def.pages) for (const e of p.elements) if (e.kind === 'question' && e.key === key) return e;
  return undefined;
}

export function describeOperand(def: Def, operand: Operand, numbers: Map<string, number>): string {
  if ('hidden' in operand) return `hidden field "${operand.hidden}"`;
  const q = findQuestion(def, operand.question);
  if (!q) return 'a deleted question';
  const base = `Q${numbers.get(q.key) ?? '?'}`;
  if (operand.sub && q.type === 'matrix') return `${base} › ${q.rows.find((r) => r.key === operand.sub)?.label ?? '?'}`;
  if (operand.sub && q.type === 'ranking') return `the rank of "${q.options.find((o) => o.key === operand.sub)?.label ?? '?'}" in ${base}`;
  return base;
}

function describeValue(def: Def, leaf: LeafCondition): string {
  if (leaf.value === undefined) return '';
  const q = 'question' in leaf.source ? findQuestion(def, leaf.source.question) : undefined;
  const label = (v: string | number | boolean) => {
    const options = q && 'options' in q ? q.options : [];
    return options.find((o) => o.key === v)?.label ?? String(v);
  };
  const values = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
  if (leaf.op === 'between') return `${values[0]} and ${values[1]}`;
  return values.map((v) => `"${label(v)}"`).join(leaf.op === 'contains_all' ? ' and ' : ' or ');
}

export function describeCondition(def: Def, c: Condition, numbers: Map<string, number>): string {
  if ('all' in c) return c.all.length === 1 ? describeCondition(def, c.all[0]!, numbers) : c.all.map((x) => wrap(def, x, numbers)).join(' and ');
  if ('any' in c) return c.any.length === 1 ? describeCondition(def, c.any[0]!, numbers) : c.any.map((x) => wrap(def, x, numbers)).join(' or ');
  if ('not' in c) return `not (${describeCondition(def, c.not, numbers)})`;
  const kind = operandKind(def, c.source);
  const value = describeValue(def, c);
  return `${describeOperand(def, c.source, numbers)} ${opLabel(c.op, kind)}${value ? ` ${value}` : ''}`;
}
const wrap = (def: Def, c: Condition, numbers: Map<string, number>) =>
  'source' in c ? describeCondition(def, c, numbers) : `(${describeCondition(def, c, numbers)})`;

// ── Condition editor ──────────────────────────────────────────────────────
type Mode = 'all' | 'any' | 'none';
interface Group {
  mode: Mode;
  items: Condition[];
}

function toGroup(c: Condition): Group {
  if ('all' in c) return { mode: 'all', items: c.all };
  if ('any' in c) return { mode: 'any', items: c.any };
  if ('not' in c) return { mode: 'none', items: 'any' in c.not ? c.not.any : [c.not] };
  return { mode: 'all', items: [c] };
}
function fromGroup(g: Group): Condition {
  if (g.mode === 'all') return { all: g.items };
  if (g.mode === 'any') return { any: g.items };
  return { not: { any: g.items } };
}

function defaultValue(kind: string | null, op: Operator, source?: Source): ConditionValue | undefined {
  if (op === 'answered' || op === 'not_answered') return undefined;
  const first = source?.options?.[0]?.key;
  if (op === 'between') return kind === 'date' ? ['', ''] : [0, 10];
  if (op === 'in' || op === 'not_in' || op.startsWith('contains_')) return kind === 'hidden' || !first ? [] : [first];
  if (kind === 'choice') return first ?? '';
  if (kind === 'number') return 0;
  return '';
}

export function newLeaf(def: Def, sources: Source[]): LeafCondition | null {
  const source = sources[0];
  if (!source) return null;
  const kind = operandKind(def, source.operand);
  const op = (kind ? OPERATORS_BY_KIND[kind][0] : 'answered') ?? 'answered';
  const value = defaultValue(kind, op, source);
  return { source: source.operand, op, ...(value !== undefined ? { value } : {}) };
}

export function ConditionEditor({
  def,
  condition,
  sources,
  onChange,
  depth = 1,
}: {
  def: Def;
  condition: Condition;
  sources: Source[];
  onChange: (c: Condition | null) => void;
  depth?: number;
}) {
  const group = toGroup(condition);
  const set = (patch: Partial<Group>) => {
    const next = { ...group, ...patch };
    onChange(next.items.length ? fromGroup(next) : null);
  };
  const setItem = (i: number, c: Condition | null) =>
    set({ items: c ? group.items.map((x, j) => (j === i ? c : x)) : group.items.filter((_, j) => j !== i) });
  const add = (c: Condition | null) => c && set({ items: [...group.items, c] });
  const id = useId();
  const tooMany = group.items.length >= LIMITS.conditionItems;

  return (
    <div className={cx('flex flex-col gap-2', depth > 1 && 'rounded-lg border border-dashed border-line p-3')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor={id}>{depth > 1 ? 'Group: match' : 'Match'}</label>
        <select
          id={id}
          className="rounded-md border border-line bg-white px-2 py-1 text-sm"
          value={group.mode}
          onChange={(e) => set({ mode: e.target.value as Mode })}
        >
          <option value="all">all of these (AND)</option>
          <option value="any">any of these (OR)</option>
          <option value="none">none of these (NOT)</option>
        </select>
        {depth > 1 ? (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Remove group
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-2">
        {group.items.map((item, i) => (
          <li key={i}>
            {'source' in item ? (
              <LeafEditor def={def} leaf={item} sources={sources} onChange={(c) => setItem(i, c)} />
            ) : (
              <ConditionEditor def={def} condition={item} sources={sources} depth={depth + 1} onChange={(c) => setItem(i, c)} />
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={tooMany} onClick={() => add(newLeaf(def, sources))}>
          + Condition
        </Button>
        {depth < LIMITS.conditionDepth - 1 ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={tooMany}
            onClick={() => {
              const leaf = newLeaf(def, sources);
              if (leaf) add({ [group.mode === 'any' ? 'all' : 'any']: [leaf] } as Condition);
            }}
          >
            + Group
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function LeafEditor({
  def,
  leaf,
  sources,
  onChange,
}: {
  def: Def;
  leaf: LeafCondition;
  sources: Source[];
  onChange: (c: LeafCondition | null) => void;
}) {
  const current = operandId(leaf.source);
  const source = sources.find((s) => s.id === current);
  const kind = operandKind(def, leaf.source);
  const ops = kind ? OPERATORS_BY_KIND[kind] : (['answered', 'not_answered'] as const);
  const set = (patch: Partial<LeafCondition>) => {
    const next = { ...leaf, ...patch };
    if (next.value === undefined) delete next.value;
    onChange(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-2">
      <label className="sr-only" htmlFor={`${current}-src`}>
        Answer or field
      </label>
      <select
        id={`${current}-src`}
        className="w-full min-w-0 rounded-md border border-line bg-white px-2 py-1 text-sm"
        value={source ? current : ''}
        onChange={(e) => {
          const s = sources.find((x) => x.id === e.target.value);
          if (!s) return;
          const k = operandKind(def, s.operand);
          const op = (k ? OPERATORS_BY_KIND[k][0] : 'answered') ?? 'answered';
          const value = defaultValue(k, op, s);
          onChange({ source: s.operand, op, ...(value !== undefined ? { value } : {}) });
        }}
      >
        {!source ? <option value="">(not available here: pick another)</option> : null}
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor={`${current}-op`}>
        Comparison
      </label>
      <select
        id={`${current}-op`}
        className="rounded-md border border-line bg-white px-2 py-1 text-sm"
        value={leaf.op}
        onChange={(e) => {
          const op = e.target.value as Operator;
          const keep = leaf.value !== undefined && Array.isArray(leaf.value) === Array.isArray(defaultValue(kind, op, source));
          set({ op, value: keep && op !== 'between' ? leaf.value : defaultValue(kind, op, source) });
        }}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {opLabel(op, kind)}
          </option>
        ))}
      </select>
      <ValueInput kind={kind} leaf={leaf} source={source} onChange={(value) => set({ value })} />
      <Button size="sm" variant="ghost" aria-label="Remove condition" onClick={() => onChange(null)}>
        ✕
      </Button>
    </div>
  );
}

function ValueInput({
  kind,
  leaf,
  source,
  onChange,
}: {
  kind: string | null;
  leaf: LeafCondition;
  source?: Source;
  onChange: (v: ConditionValue | undefined) => void;
}) {
  const { op, value } = leaf;
  const input = 'rounded-md border border-line bg-white px-2 py-1 text-sm';
  if (op === 'answered' || op === 'not_answered') return null;
  const options = source?.options;
  const list = Array.isArray(value) ? value.map(String) : [];

  if (options && (op === 'in' || op === 'not_in' || op.startsWith('contains_')))
    return (
      <fieldset className="flex w-full flex-wrap gap-x-3 gap-y-1 pl-1">
        <legend className="sr-only">Options</legend>
        {options.map((o) => (
          <label key={o.key} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={list.includes(o.key)}
              onChange={(e) => onChange(e.target.checked ? [...list, o.key] : list.filter((k) => k !== o.key))}
            />
            {o.label || 'Untitled option'}
          </label>
        ))}
      </fieldset>
    );
  if (options && (op === 'eq' || op === 'neq'))
    return (
      <select aria-label="Option" className={input} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label || 'Untitled option'}
          </option>
        ))}
      </select>
    );
  const type = kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text';
  const parse = (v: string) => (kind === 'number' ? (v === '' ? '' : Number(v)) : v);
  if (op === 'between') {
    const [lo, hi] = Array.isArray(value) ? value : ['', ''];
    return (
      <span className="flex items-center gap-1 text-sm">
        <input aria-label="From" type={type} className={cx(input, 'w-32')} value={String(lo ?? '')} onChange={(e) => onChange([parse(e.target.value) as string, hi as string])} />
        and
        <input aria-label="To" type={type} className={cx(input, 'w-32')} value={String(hi ?? '')} onChange={(e) => onChange([lo as string, parse(e.target.value) as string])} />
      </span>
    );
  }
  if (op === 'in' || op === 'not_in')
    return (
      <input
        aria-label="Values, separated by commas"
        placeholder="a, b, c"
        className={cx(input, 'w-48')}
        value={list.join(', ')}
        onChange={(e) => onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
      />
    );
  return (
    <input
      aria-label="Value"
      type={type}
      className={cx(input, type === 'number' ? 'w-24' : 'w-48')}
      value={String(value ?? '')}
      onChange={(e) => onChange(parse(e.target.value) as ConditionValue)}
    />
  );
}

/** "Show this question/page only if…" with an on/off switch. */
export function VisibilityEditor({
  def,
  condition,
  sources,
  what,
  onChange,
}: {
  def: Def;
  condition: Condition | undefined;
  sources: Source[];
  what: 'question' | 'page' | 'text';
  onChange: (c: Condition | undefined) => void;
}) {
  const leaf = useMemo(() => newLeaf(def, sources), [def, sources]);
  const noun = what === 'page' ? 'page' : what === 'text' ? 'text' : 'question';
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 rounded-lg border border-line p-3">
      <legend className="px-1 text-sm font-semibold">Display logic</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(condition)}
          disabled={!condition && !leaf}
          onChange={(e) => onChange(e.target.checked && leaf ? { all: [leaf] } : undefined)}
        />
        Show this {noun} only when…
      </label>
      {!condition && !leaf ? (
        <p className="text-xs text-muted">
          Conditions can only use earlier answers or hidden fields, and there are none before this {noun}.
        </p>
      ) : null}
      {condition ? (
        <>
          <ConditionEditor def={def} condition={condition} sources={sources} onChange={(c) => onChange(c ?? undefined)} />
          <p className="text-xs text-muted">
            Hidden {noun === 'page' ? 'pages are skipped' : `${noun}s aren't shown`}, and{' '}
            {noun === 'text' ? 'nothing is asked' : 'any answer they had is discarded when the response is submitted'}.
          </p>
        </>
      ) : null}
    </fieldset>
  );
}

// ── Page rules ────────────────────────────────────────────────────────────
type Then = 'goTo' | 'end' | 'disqualify';
const thenKind = (r: NavigationRule): Then => ('goTo' in r.then ? 'goTo' : 'end' in r.then ? 'end' : 'disqualify');

export function PageRulesEditor({
  def,
  pageKey,
  onChange,
}: {
  def: Def;
  pageKey: string;
  onChange: (rules: NavigationRule[]) => void;
}) {
  const all = def.logic ?? [];
  const mine = all.filter((r) => r.afterPage === pageKey);
  const sources = useMemo(() => sourcesBefore(def, { pageKey, throughPage: true }), [def, pageKey]);
  const pageIndex = def.pages.findIndex((p) => p.key === pageKey);
  const later = def.pages.slice(pageIndex + 1);
  const replace = (next: NavigationRule[]) => onChange([...all.filter((r) => r.afterPage !== pageKey), ...next]);
  const update = (id: string, patch: Partial<NavigationRule>) => replace(mine.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (i: number, delta: number) => {
    const next = [...mine];
    const j = i + delta;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    replace(next);
  };
  const leaf = newLeaf(def, sources);

  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border border-line p-3">
      <legend className="px-1 text-sm font-semibold">After this page</legend>
      {mine.length === 0 ? <p className="text-sm text-muted">Respondents continue to the next page.</p> : null}
      <ol className="flex flex-col gap-3">
        {mine.map((rule, i) => (
          <li key={rule.id} className="flex flex-col gap-2 rounded-lg border border-line bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">
                Rule {i + 1}
                {i > 0 ? <span className="font-normal text-muted"> (if rule {i} didn't match)</span> : null}
              </span>
              <span className="flex">
                <Button size="sm" variant="ghost" aria-label={`Move rule ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Move rule ${i + 1} down`} disabled={i === mine.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Delete rule ${i + 1}`} onClick={() => replace(mine.filter((r) => r.id !== rule.id))}>
                  ✕
                </Button>
              </span>
            </div>
            <ConditionEditor
              def={def}
              condition={rule.when}
              sources={sources}
              onChange={(c) => (c ? update(rule.id, { when: c }) : replace(mine.filter((r) => r.id !== rule.id)))}
            />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor={`${rule.id}-then`}>then</label>
              <select
                id={`${rule.id}-then`}
                className="min-w-0 max-w-full rounded-md border border-line bg-white px-2 py-1 text-sm"
                value={thenKind(rule) === 'goTo' ? `goTo:${(rule.then as { goTo: string }).goTo}` : thenKind(rule)}
                onChange={(e) => {
                  const v = e.target.value;
                  update(rule.id, {
                    then: v.startsWith('goTo:') ? { goTo: v.slice(5) } : v === 'end' ? { end: true } : { disqualify: true },
                  });
                }}
              >
                {later.map((p) => (
                  <option key={p.key} value={`goTo:${p.key}`}>
                    skip to page {def.pages.indexOf(p) + 1}
                    {p.title ? `: ${short(p.title, 30)}` : ''}
                  </option>
                ))}
                {'goTo' in rule.then && !later.some((p) => p.key === (rule.then as { goTo: string }).goTo) ? (
                  <option value={`goTo:${rule.then.goTo}`}>(a page that isn't after this one)</option>
                ) : null}
                <option value="end">end the survey (completed)</option>
                <option value="disqualify">screen out (disqualified)</option>
              </select>
            </div>
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        className="self-start"
        disabled={!leaf || all.length >= LIMITS.logicRules}
        onClick={() =>
          leaf &&
          replace([
            ...mine,
            { id: newKey('r'), afterPage: pageKey, when: { all: [leaf] }, then: later[0] ? { goTo: later[0].key } : { end: true } },
          ])
        }
      >
        + Add rule
      </Button>
      <p className="text-xs text-muted">
        Rules are checked in order when respondents leave this page; the first that matches wins. Screened-out responses aren't
        counted as completed and see the screen-out message from Survey settings.
      </p>
    </fieldset>
  );
}

// ── Logic map ─────────────────────────────────────────────────────────────
export function LogicMapDialog({
  open,
  onClose,
  def,
  numbers,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  def: Def;
  numbers: Map<string, number>;
  onPick: (key: string) => void;
}) {
  const rules = def.logic ?? [];
  const hasLogic = rules.length > 0 || def.pages.some((p) => p.visibleIf || p.elements.some((e) => e.visibleIf));
  return (
    <Dialog open={open} onClose={onClose} title="Logic map" wide>
      {!hasLogic ? (
        <p className="text-sm">
          This survey has no logic yet: everyone sees every page in order. Add display logic to a question or page, or rules
          under a page's <em>Logic</em> button.
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {def.pages.map((page, i) => {
            const pageRules = rules.filter((r) => r.afterPage === page.key);
            const conditional = page.elements.filter((e) => e.visibleIf);
            const next = def.pages[i + 1];
            return (
              <li key={page.key} className="rounded-lg border border-line p-3">
                <button type="button" className="text-left text-sm font-semibold hover:underline" onClick={() => onPick(page.key)}>
                  Page {i + 1}
                  {page.title ? `: ${readableTokens(page.title, numbers)}` : ''}
                </button>
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {page.visibleIf ? (
                    <MapLine tone="show">Shown only when {describeCondition(def, page.visibleIf, numbers)}.</MapLine>
                  ) : null}
                  {conditional.map((e) => (
                    <MapLine key={e.key} tone="show">
                      <button type="button" className="hover:underline" onClick={() => onPick(e.key)}>
                        {e.kind === 'question' ? `Q${numbers.get(e.key)}` : 'Text block'}
                      </button>{' '}
                      is shown only when {describeCondition(def, e.visibleIf!, numbers)}.
                    </MapLine>
                  ))}
                  {pageRules.map((r, j) => (
                    <MapLine key={r.id} tone={thenKind(r) === 'disqualify' ? 'out' : 'jump'}>
                      {j === 0 ? 'Then, if' : 'Otherwise, if'} {describeCondition(def, r.when, numbers)}:{' '}
                      <strong>
                        {'goTo' in r.then
                          ? `skip to page ${def.pages.findIndex((p) => p.key === (r.then as { goTo: string }).goTo) + 1}`
                          : 'end' in r.then
                            ? 'end the survey'
                            : 'screen out'}
                      </strong>
                      .
                    </MapLine>
                  ))}
                  <MapLine tone="next">
                    {pageRules.length ? 'Otherwise' : 'Then'}: {next ? `page ${i + 2}${next.visibleIf ? ' (if shown)' : ''}` : 'submit'}.
                  </MapLine>
                </ul>
              </li>
            );
          })}
        </ol>
      )}
    </Dialog>
  );
}

function MapLine({ tone, children }: { tone: 'show' | 'jump' | 'out' | 'next'; children: ReactNode }) {
  const icon = { show: '👁', jump: '↪', out: '⛔', next: '↓' }[tone];
  return (
    <li className={cx('flex gap-2', tone === 'next' && 'text-muted')}>
      <span aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

// ── Piping ────────────────────────────────────────────────────────────────
/** A text area that remembers where the cursor was, plus a menu that inserts {{…}} tokens there. */
export function usePipeTarget(value: string, onChange: (v: string) => void) {
  const caret = useRef<number | null>(null);
  const track = (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    caret.current = e.currentTarget.selectionStart;
  };
  const insert = (token: string) => {
    const at = caret.current ?? value.length;
    onChange(value.slice(0, at) + token + value.slice(at));
    caret.current = at + token.length;
  };
  return { trackProps: { onSelect: track, onKeyUp: track, onClick: track }, insert };
}

export function PipeMenu({ sources, onInsert, label = 'Insert answer' }: { sources: Source[]; onInsert: (token: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const pipeable = sources.filter((s) => !('question' in s.operand && s.operand.sub));
  return (
    <div className="relative inline-block">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={pipeable.length === 0}>
        {`{ } ${label}`}
      </Button>
      {open ? (
        <ul className="absolute right-0 z-20 mt-1 max-h-64 w-72 overflow-auto rounded-lg border border-line bg-white p-1 shadow-lg">
          {pipeable.map((s) => {
            const token = 'hidden' in s.operand ? `{{param.${s.operand.hidden}}}` : `{{q.${s.operand.question}|}}`;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-gray-100"
                  onClick={() => {
                    onInsert(token);
                    setOpen(false);
                  }}
                >
                  {s.label}
                </button>
              </li>
            );
          })}
          <li className="px-2 py-1.5 text-xs text-muted">
            Add a fallback after the bar, e.g. <code>{'{{q.…|there}}'}</code>, shown when there's no answer.
          </li>
        </ul>
      ) : null}
    </div>
  );
}

export const typeLabel = (q: Question) => QUESTION_TYPE_META[q.type].label;

/** Text with piping tokens shown readably for builders: {{q.KEY|x}} → [Q3], {{param.src}} → [src]. */
export function readableTokens(text: string, numbers: Map<string, number>): string {
  return text.replace(/\{\{\s*(q|param|contact)\.([A-Za-z0-9_]+)\s*(?:\|[^}]*)?\}\}/g, (_, ns: string, key: string) =>
    ns === 'q' ? `[Q${numbers.get(key) ?? '?'}]` : `[${key}]`,
  );
}
