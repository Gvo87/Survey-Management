/**
 * Survey runtime: visibility, navigation, page validation and the server-side completion check.
 *
 * The builder preview, the respondent app and the API all call these functions, so logic behaves
 * identically everywhere (verified by the shared test vectors in ../test-vectors).
 *
 * Rules:
 * - An element's `visibleIf` may use answers from earlier pages and earlier elements on its page.
 * - A page's `visibleIf` may use answers from earlier pages. Hidden pages are skipped.
 * - Navigation rules run when leaving a page, in order; the first match wins. `goTo` only jumps
 *   forward (validator-enforced), so a walk always terminates.
 * - Answers to hidden questions, or on pages the respondent's path skips, don't count: they are
 *   ignored by conditions and dropped on completion.
 */
import type { Element, Page, Question, SurveyDefinition } from './schema';
import { validateAnswer, type AnswerErrorCode, type Answers, type AnswerValue } from './answers';
import { evaluate } from './logic';

export interface FieldError {
  questionKey: string;
  pageKey: string;
  code: AnswerErrorCode | 'unknown_question';
  message: string;
}

export interface RunContext {
  /** Answers given so far (raw or normalised). */
  answers: Answers;
  /** Hidden fields (URL parameters) of this response. */
  hidden?: Record<string, string>;
}

export type NextStep = { kind: 'page'; pageKey: string } | { kind: 'end' } | { kind: 'disqualify' };

export function isQuestion(element: Element): element is Question {
  return element.kind === 'question';
}

/** Every question in display order. */
export function listQuestions(def: SurveyDefinition): Question[] {
  return def.pages.flatMap((page) => page.elements.filter(isQuestion));
}

export function findQuestion(def: SurveyDefinition, key: string): Question | undefined {
  for (const page of def.pages) {
    for (const element of page.elements) {
      if (element.kind === 'question' && element.key === key) return element;
    }
  }
  return undefined;
}

export function findPageOfQuestion(def: SurveyDefinition, questionKey: string): Page | undefined {
  return def.pages.find((page) => page.elements.some((e) => e.key === questionKey));
}

export function pageIndex(def: SurveyDefinition, pageKey: string): number {
  return def.pages.findIndex((p) => p.key === pageKey);
}

export function isPageVisible(def: SurveyDefinition, page: Page, ctx: RunContext): boolean {
  return !page.visibleIf || evaluate(def, page.visibleIf, ctx);
}

/** The first page the respondent sees (null only if every page is hidden). */
export function firstPageKey(def: SurveyDefinition, ctx: RunContext = { answers: {} }): string {
  const first = def.pages.find((p) => isPageVisible(def, p, ctx)) ?? def.pages[0];
  if (!first) throw new Error('Survey has no pages');
  return first.key;
}

/**
 * Elements the respondent sees on a page. Evaluated in order: a hidden question's answer doesn't
 * count for the conditions of the elements after it.
 */
export function visibleElements(def: SurveyDefinition, page: Page, ctx: RunContext): Element[] {
  const answers = { ...ctx.answers };
  const visible: Element[] = [];
  for (const element of page.elements) {
    const shown = !element.visibleIf || evaluate(def, element.visibleIf, { answers, hidden: ctx.hidden });
    if (shown) visible.push(element);
    else if (element.kind === 'question') delete answers[element.key];
  }
  return visible;
}

/** Where to go after `pageKey`: the first matching rule, otherwise the next visible page, otherwise the end. */
export function nextStep(def: SurveyDefinition, pageKey: string, ctx: RunContext): NextStep {
  const from = pageIndex(def, pageKey);
  let startAt = from + 1;
  for (const rule of def.logic ?? []) {
    if (rule.afterPage !== pageKey || !evaluate(def, rule.when, ctx)) continue;
    if ('end' in rule.then) return { kind: 'end' };
    if ('disqualify' in rule.then) return { kind: 'disqualify' };
    const target = pageIndex(def, rule.then.goTo);
    if (target > from) {
      startAt = target;
      break;
    }
  }
  for (let i = Math.max(startAt, 0); i < def.pages.length; i++) {
    const page = def.pages[i]!;
    if (isPageVisible(def, page, ctx)) return { kind: 'page', pageKey: page.key };
  }
  return { kind: 'end' };
}

/** Convenience: the next page key, or null when the respondent should submit. */
export function nextPageKey(def: SurveyDefinition, pageKey: string, ctx: RunContext): string | null {
  const step = nextStep(def, pageKey, ctx);
  return step.kind === 'page' ? step.pageKey : null;
}

export function isLastPage(def: SurveyDefinition, pageKey: string, ctx: RunContext): boolean {
  return nextStep(def, pageKey, ctx).kind !== 'page';
}

export function progress(def: SurveyDefinition, pageKey: string): { index: number; total: number; percent: number } {
  const total = def.pages.length;
  const index = Math.max(0, pageIndex(def, pageKey));
  return { index, total, percent: total <= 1 ? 0 : Math.round((index / total) * 100) };
}

/**
 * Answers that count when the respondent is on `currentPageKey`: answers on the pages of their
 * path before it (only visible questions), plus whatever is on the current page.
 */
export function pathAnswers(def: SurveyDefinition, raw: Answers, currentPageKey: string, hidden?: Record<string, string>): Answers {
  const counted: Answers = {};
  const visited = new Set<string>();
  let key: string | null = firstPageKey(def, { answers: counted, hidden });
  while (key !== null && key !== currentPageKey && !visited.has(key)) {
    visited.add(key);
    const page = def.pages.find((p) => p.key === key);
    if (!page) break;
    for (const element of visibleElements(def, page, { answers: { ...counted, ...pick(raw, page) }, hidden })) {
      if (element.kind === 'question' && raw[element.key] !== undefined) counted[element.key] = raw[element.key]!;
    }
    const step = nextStep(def, page.key, { answers: counted, hidden });
    key = step.kind === 'page' ? step.pageKey : null;
  }
  const current = def.pages.find((p) => p.key === currentPageKey);
  return current ? { ...counted, ...pick(raw, current) } : counted;
}

function pick(raw: Answers, page: Page): Answers {
  const out: Answers = {};
  for (const element of page.elements) if (element.kind === 'question' && raw[element.key] !== undefined) out[element.key] = raw[element.key]!;
  return out;
}

/** Validate the visible questions on one page (used by the respondent app on "Next"). */
export function validatePage(def: SurveyDefinition, pageKey: string, answers: Record<string, unknown>, hidden?: Record<string, string>): FieldError[] {
  const page = def.pages.find((p) => p.key === pageKey);
  if (!page) return [];
  const ctx = { answers: pathAnswers(def, answers as Answers, pageKey, hidden), hidden };
  const errors: FieldError[] = [];
  for (const element of visibleElements(def, page, ctx)) {
    if (element.kind !== 'question') continue;
    const result = validateAnswer(element, answers[element.key]);
    if (!result.ok) errors.push({ questionKey: element.key, pageKey: page.key, ...result.error });
  }
  return errors;
}

export interface CompletionResult {
  ok: boolean;
  errors: FieldError[];
  /** Normalised answers for visible questions on the respondent's path. Everything else is dropped. */
  answers: Answers;
  /** `disqualified` when a rule screened the respondent out. */
  outcome: 'completed' | 'disqualified';
  /** Page keys in the order the respondent saw them. */
  path: string[];
}

/**
 * The authoritative completion check, run by the API before a response is marked completed.
 * Walks the path the respondent took, validates every visible question and drops everything else.
 */
export function checkCompletion(def: SurveyDefinition, raw: Record<string, unknown>, hidden?: Record<string, string>): CompletionResult {
  const errors: FieldError[] = [];
  const answers: Answers = {};
  const path: string[] = [];
  let outcome: CompletionResult['outcome'] = 'completed';
  let pageKey: string | null = firstPageKey(def, { answers, hidden });

  while (pageKey !== null && !path.includes(pageKey)) {
    path.push(pageKey);
    const page = def.pages.find((p) => p.key === pageKey);
    if (!page) break;
    // Evaluate visibility element by element against the normalised answers collected so far.
    const pageAnswers: Answers = {};
    for (const element of page.elements) {
      const ctx = { answers: { ...answers, ...pageAnswers }, hidden };
      if (element.visibleIf && !evaluate(def, element.visibleIf, ctx)) continue;
      if (element.kind !== 'question') continue;
      const result = validateAnswer(element, raw[element.key]);
      if (!result.ok) errors.push({ questionKey: element.key, pageKey: page.key, ...result.error });
      else if (result.value !== null) pageAnswers[element.key] = result.value;
    }
    Object.assign(answers, pageAnswers);
    const step = nextStep(def, page.key, { answers, hidden });
    if (step.kind === 'disqualify') outcome = 'disqualified';
    pageKey = step.kind === 'page' ? step.pageKey : null;
  }

  return { ok: errors.length === 0, errors, answers, outcome, path };
}

/**
 * Validate a partial save. Unknown question keys are reported; empty required answers are
 * allowed (the respondent hasn't finished), but present answers must be well-formed.
 */
export function validatePartialAnswers(
  def: SurveyDefinition,
  raw: Record<string, unknown>,
): { answers: Answers; errors: FieldError[] } {
  const answers: Answers = {};
  const errors: FieldError[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const question = findQuestion(def, key);
    const pageKey = findPageOfQuestion(def, key)?.key ?? '';
    if (!question) {
      errors.push({ questionKey: key, pageKey, code: 'unknown_question', message: 'Unknown question.' });
      continue;
    }
    // Shape and range checks only: "required" and cross-row completeness are checked on completion.
    const lenient = question.type === 'ranking' || question.type === 'matrix' ? null : { ...question, required: false };
    const result = lenient ? validateAnswer(lenient as Question, value) : validatePartialStructured(question, value);
    if (!result.ok) errors.push({ questionKey: key, pageKey, ...result.error });
    else if (result.value !== null) answers[key] = result.value as AnswerValue;
  }
  return { answers, errors };
}

/** Partial matrices and rankings are fine while the respondent is still working. */
function validatePartialStructured(question: Question, value: unknown) {
  const relaxed = { ...question, required: false } as Question;
  if (relaxed.type === 'ranking') relaxed.config = { ...relaxed.config, rankCount: Array.isArray(value) ? value.length || 1 : 1 };
  return validateAnswer(relaxed, value);
}
