/**
 * Condition evaluation, shared by the builder preview, the respondent app and the server.
 *
 * Semantics:
 * - A question that wasn't answered (or was hidden) is "not answered"; every comparison on it is
 *   false, so only `not_answered` matches. This keeps "Q is not X" from matching people who skipped Q.
 * - Text comparisons ignore case and surrounding spaces. Dates compare as ISO strings.
 * - `sub` picks one matrix row (its column choice) or one ranked option (its rank, 1 = top).
 */
import { QUESTION_TYPE_META, type Operator, type ValueKind } from './constants';
import { isEmptyAnswer, selectedOptionKeys, type Answers, type AnswerValue } from './answers';
import type { Question, SurveyDefinition } from './schema';
import type { Condition, LeafCondition, Operand } from './types';

export interface LogicContext {
  answers: Answers;
  hidden?: Record<string, string>;
}

const findQuestionIn = (def: SurveyDefinition, key: string): Question | undefined => {
  for (const page of def.pages)
    for (const element of page.elements) if (element.kind === 'question' && element.key === key) return element;
  return undefined;
};

/** The kind of value an operand produces, which decides the operators that apply. */
export function operandKind(def: SurveyDefinition, operand: Operand): ValueKind | 'hidden' | null {
  if ('hidden' in operand) return 'hidden';
  const question = findQuestionIn(def, operand.question);
  if (!question) return null;
  if (question.type === 'matrix' && operand.sub) return question.config.multiplePerRow ? 'multi' : 'choice';
  if (question.type === 'ranking' && operand.sub) return 'number';
  if (question.type === 'short_text' && (question.config.format === 'number' || question.config.format === 'integer'))
    return 'number';
  return QUESTION_TYPE_META[question.type].kind;
}

/** Resolve an operand to its current value (undefined when unanswered). */
function operandValue(def: SurveyDefinition, operand: Operand, ctx: LogicContext): AnswerValue | undefined {
  if ('hidden' in operand) {
    const v = ctx.hidden?.[operand.hidden];
    return v === undefined || v === '' ? undefined : v;
  }
  const value = ctx.answers[operand.question];
  if (value === undefined || isEmptyAnswer(value)) return undefined;
  if (!operand.sub) return value;
  const question = findQuestionIn(def, operand.question);
  if (question?.type === 'matrix' && typeof value === 'object' && !Array.isArray(value)) {
    const row = (value as Record<string, string | string[]>)[operand.sub];
    return row === undefined || isEmptyAnswer(row) ? undefined : row;
  }
  if (question?.type === 'ranking' && Array.isArray(value)) {
    const rank = value.indexOf(operand.sub);
    return rank === -1 ? undefined : rank + 1;
  }
  return undefined;
}

const asArray = (v: unknown): (string | number)[] => (Array.isArray(v) ? v : v === undefined ? [] : [v as string | number]);
const norm = (v: unknown) => String(v).trim().toLowerCase();
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

function compare(op: Operator, kind: ValueKind | 'hidden', actual: AnswerValue, expected: unknown): boolean {
  switch (kind) {
    case 'choice':
    case 'hidden': {
      const value = kind === 'choice' ? (selectedOptionKeys(actual)[0] ?? '') : String(actual);
      const eq = (x: unknown) => (kind === 'hidden' ? norm(x) === norm(value) : String(x) === value);
      if (op === 'eq') return eq(expected);
      if (op === 'neq') return !eq(expected);
      if (op === 'in') return asArray(expected).some(eq);
      if (op === 'not_in') return !asArray(expected).some(eq);
      if (op === 'text_contains') return norm(value).includes(norm(expected));
      return false;
    }
    case 'multi': {
      const selected = new Set(selectedOptionKeys(actual));
      const wanted = asArray(expected).map(String);
      if (op === 'contains_any') return wanted.some((w) => selected.has(w));
      if (op === 'contains_all') return wanted.length > 0 && wanted.every((w) => selected.has(w));
      if (op === 'contains_none') return !wanted.some((w) => selected.has(w));
      return false;
    }
    case 'number': {
      const n = num(actual);
      if (!Number.isFinite(n)) return false;
      if (op === 'between') {
        const [lo, hi] = asArray(expected).map(num);
        return lo !== undefined && hi !== undefined && n >= lo && n <= hi;
      }
      const e = num(expected);
      if (!Number.isFinite(e)) return false;
      return op === 'eq' ? n === e : op === 'neq' ? n !== e : op === 'gt' ? n > e : op === 'gte' ? n >= e : op === 'lt' ? n < e : op === 'lte' ? n <= e : false;
    }
    case 'text': {
      const text = norm(actual);
      if (op === 'eq') return text === norm(expected);
      if (op === 'neq') return text !== norm(expected);
      if (op === 'text_contains') return text.includes(norm(expected));
      return false;
    }
    case 'date': {
      const value = String(actual);
      // A date-only bound compares with the date part of a datetime answer.
      const cut = (bound: unknown) => value.slice(0, String(bound).length);
      if (op === 'between') {
        const [lo, hi] = asArray(expected).map(String);
        return lo !== undefined && hi !== undefined && cut(lo) >= lo && cut(hi) <= hi;
      }
      const e = String(expected);
      return op === 'eq' ? cut(e) === e : op === 'gt' ? cut(e) > e : op === 'lt' ? cut(e) < e : false;
    }
    default:
      return false;
  }
}

function evaluateLeaf(def: SurveyDefinition, cond: LeafCondition, ctx: LogicContext): boolean {
  const value = operandValue(def, cond.source, ctx);
  if (cond.op === 'answered') return value !== undefined;
  if (cond.op === 'not_answered') return value === undefined;
  if (value === undefined) return false;
  const kind = operandKind(def, cond.source);
  return kind ? compare(cond.op, kind, value, cond.value) : false;
}

export function evaluate(def: SurveyDefinition, condition: Condition, ctx: LogicContext): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluate(def, c, ctx));
  if ('any' in condition) return condition.any.some((c) => evaluate(def, c, ctx));
  if ('not' in condition) return !evaluate(def, condition.not, ctx);
  return evaluateLeaf(def, condition, ctx);
}

/** Every leaf in a condition (for validation and key remapping). */
export function leaves(condition: Condition): LeafCondition[] {
  if ('all' in condition) return condition.all.flatMap(leaves);
  if ('any' in condition) return condition.any.flatMap(leaves);
  if ('not' in condition) return leaves(condition.not);
  return [condition];
}

/** Nesting depth: a leaf is 0, each all/any/not group adds 1. */
export function conditionDepth(condition: Condition): number {
  if ('all' in condition) return 1 + Math.max(0, ...condition.all.map(conditionDepth));
  if ('any' in condition) return 1 + Math.max(0, ...condition.any.map(conditionDepth));
  if ('not' in condition) return 1 + conditionDepth(condition.not);
  return 0;
}
