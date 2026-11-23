/**
 * Results filters (Phase 2B) compiled to SQL. The grammar is the survey-logic condition grammar
 * (AND / OR / NOT, the same operators) plus response fields, so "show only respondents who…" reads
 * the same in the builder and in results. Every value is a bound parameter; keys are validated.
 *
 * The compiled condition applies to `responses r`; answers are checked with EXISTS on the answers
 * primary key (survey_id, response_id, question_key, sub_key).
 */
import type { ResultFilter } from '@survey/contracts';
import { QUESTION_TYPE_META, type Question } from '@survey/core';
import { unprocessable } from './errors';

export interface SqlParams {
  add(value: unknown): string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message: string) => unprocessable('invalid_filter', message);
const list = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(String);
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

type Kind = 'choice' | 'multi' | 'number' | 'text' | 'date' | 'presence';

function kindOf(q: Question, sub: string | undefined): Kind {
  if (q.type === 'matrix') {
    if (!sub) return 'presence';
    if (!q.rows.some((r) => r.key === sub)) throw invalid(`"${q.title}" has no such row.`);
    return q.config.multiplePerRow ? 'multi' : 'choice';
  }
  if (q.type === 'ranking') {
    if (!sub) return 'presence';
    if (!q.options.some((o) => o.key === sub)) throw invalid(`"${q.title}" has no such option.`);
    return 'number';
  }
  if (q.type === 'short_text' && (q.config.format === 'number' || q.config.format === 'integer')) return 'number';
  const kind = QUESTION_TYPE_META[q.type].kind;
  if (kind === 'choice' || kind === 'multi' || kind === 'number' || kind === 'text' || kind === 'date') return kind;
  return 'presence';
}

function compileAnswer(p: SqlParams, node: Extract<ResultFilter, { question: string }>, questions: Map<string, Question>): string {
  const q = questions.get(node.question);
  if (!q) throw invalid('The filter uses a question that is not in this survey.');
  const kind = kindOf(q, node.sub);
  const cell = `a.survey_id = r.survey_id and a.response_id = r.id and a.question_key = ${p.add(q.key)}::text and a.sub_key = ${p.add(node.sub ?? '')}::text`;
  const has = (cond?: string) => `exists (select 1 from answers a where ${cell}${cond ? ` and (${cond})` : ''})`;
  const { op, value } = node;
  if (op === 'answered') return has();
  if (op === 'not_answered') return `not ${has()}`;
  if (value === undefined) throw invalid('A filter condition is missing its value.');
  const bad = () => invalid(`"${op}" can't be used with "${q.title}".`);

  switch (kind) {
    case 'choice':
    case 'multi': {
      // Only add the list parameter when it's used: Postgres can't type unused parameters.
      const values = () => p.add(list(value));
      if (op === 'eq') return has(`${p.add(String(value))}::text = any(a.value_choices)`);
      if (op === 'neq') return has(`not (${p.add(String(value))}::text = any(a.value_choices))`);
      if (op === 'in' || op === 'contains_any') return has(`a.value_choices && ${values()}::text[]`);
      if (op === 'not_in' || op === 'contains_none') return has(`not (a.value_choices && ${values()}::text[])`);
      if (op === 'contains_all') return has(`a.value_choices @> ${values()}::text[]`);
      throw bad();
    }
    case 'number': {
      const num = (v: unknown) => {
        const n = Number(v);
        if (!Number.isFinite(n)) throw invalid('Use a number.');
        return `${p.add(n)}::numeric`;
      };
      const ops: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
      if (ops[op]) return has(`a.value_number ${ops[op]} ${num(value)}`);
      if (op === 'between') {
        const [lo, hi] = list(value);
        return has(`a.value_number between ${num(lo)} and ${num(hi)}`);
      }
      throw bad();
    }
    case 'text': {
      if (op === 'eq') return has(`lower(a.value_text) = lower(${p.add(String(value))}::text)`);
      if (op === 'neq') return has(`lower(a.value_text) <> lower(${p.add(String(value))}::text)`);
      if (op === 'text_contains') return has(`a.value_text ilike ${p.add(`%${escapeLike(String(value))}%`)}::text`);
      throw bad();
    }
    case 'date': {
      // Compare the stored text (date, time or date-time) with a bound of the same precision.
      const v = `coalesce(a.value_text, a.value_date::text)`;
      const cut = (bound: string) => `left(${v}, length(${bound}))`;
      if (op === 'eq' || op === 'gt' || op === 'lt' || op === 'gte' || op === 'lte') {
        const b = `${p.add(String(value))}::text`;
        return has(`${cut(b)} ${{ eq: '=', gt: '>', lt: '<', gte: '>=', lte: '<=' }[op]} ${b}`);
      }
      if (op === 'between') {
        const [lo, hi] = list(value).map((x) => `${p.add(x)}::text`);
        return has(`${cut(lo!)} >= ${lo} and ${cut(hi!)} <= ${hi}`);
      }
      throw bad();
    }
    default:
      throw bad();
  }
}

function compileHidden(p: SqlParams, node: Extract<ResultFilter, { hidden: string }>): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(node.hidden)) throw invalid('Unknown hidden field.');
  const v = `(r.hidden_fields ->> ${p.add(node.hidden)}::text)`;
  switch (node.op) {
    case 'answered':
      return `coalesce(${v}, '') <> ''`;
    case 'not_answered':
      return `coalesce(${v}, '') = ''`;
    case 'eq':
      return `lower(${v}) = lower(${p.add(String(node.value ?? ''))}::text)`;
    case 'neq':
      return `${v} is not null and lower(${v}) <> lower(${p.add(String(node.value ?? ''))}::text)`;
    case 'in':
      return `lower(${v}) = any(${p.add(list(node.value).map((s) => s.toLowerCase()))}::text[])`;
    case 'not_in':
      return `${v} is not null and not (lower(${v}) = any(${p.add(list(node.value).map((s) => s.toLowerCase()))}::text[]))`;
    case 'text_contains':
      return `${v} ilike ${p.add(`%${escapeLike(String(node.value ?? ''))}%`)}::text`;
  }
}

function compileField(p: SqlParams, node: Extract<ResultFilter, { field: string }>): string {
  const { op, value } = node;
  const values = list(value);
  const setOp = (column: string, cast: string) => {
    if (op === 'eq') return `${column} = ${p.add(values[0])}${cast}`;
    if (op === 'neq') return `${column} is distinct from ${p.add(values[0])}${cast}`;
    if (op === 'in') return `${column} = any(${p.add(values)}${cast}[])`;
    if (op === 'not_in') return `not (${column} = any(${p.add(values)}${cast}[]))`;
    throw invalid(`"${op}" can't be used with ${node.field}.`);
  };
  switch (node.field) {
    case 'status':
      if (values.some((v) => !['in_progress', 'completed', 'disqualified'].includes(v))) throw invalid('Unknown status.');
      return setOp('r.status', '::text');
    case 'deviceType':
      if (values.some((v) => !['mobile', 'tablet', 'desktop'].includes(v))) throw invalid('Unknown device type.');
      return setOp('r.device_type', '::text');
    case 'versionId':
    case 'distributionId': {
      if (values.some((v) => !UUID.test(v))) throw invalid('Unknown version or link.');
      return setOp(node.field === 'versionId' ? 'r.version_id' : 'r.distribution_id', '::uuid');
    }
    case 'tag': {
      if (values.some((v) => !UUID.test(v))) throw invalid('Unknown tag.');
      const tagged = `exists (select 1 from response_tags t where t.response_id = r.id and t.tag_id = any(${p.add(values)}::uuid[]))`;
      if (op === 'eq' || op === 'in') return tagged;
      if (op === 'neq' || op === 'not_in') return `not ${tagged}`;
      throw invalid(`"${op}" can't be used with tags.`);
    }
    case 'startedAt':
    case 'completedAt': {
      const column = node.field === 'startedAt' ? 'r.started_at' : 'r.completed_at';
      const time = (v: string | undefined) => {
        if (!v || Number.isNaN(Date.parse(v))) throw invalid('Use a valid date.');
        return `${p.add(v)}::timestamptz`;
      };
      if (op === 'gte') return `${column} >= ${time(values[0])}`;
      if (op === 'lte') return `${column} <= ${time(values[0])}`;
      if (op === 'between') return `${column} between ${time(values[0])} and ${time(values[1])}`;
      throw invalid(`"${op}" can't be used with dates.`);
    }
  }
}

export function compileResultFilter(p: SqlParams, node: ResultFilter, questions: Map<string, Question>, depth = 0): string {
  if (depth > 4) throw invalid('Filters can be nested at most 4 levels deep.');
  if ('all' in node) return `(${node.all.map((c) => compileResultFilter(p, c, questions, depth + 1)).join(' and ')})`;
  if ('any' in node) return `(${node.any.map((c) => compileResultFilter(p, c, questions, depth + 1)).join(' or ')})`;
  if ('not' in node) return `not (${compileResultFilter(p, node.not, questions, depth + 1)})`;
  if ('question' in node) return compileAnswer(p, node, questions);
  if ('hidden' in node) return compileHidden(p, node);
  return compileField(p, node);
}
