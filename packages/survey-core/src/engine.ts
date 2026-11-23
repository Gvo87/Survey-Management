/**
 * Survey runtime: navigation, page validation and the server-side completion check.
 *
 * Phase 1 navigation is linear and every element is visible. Phase 2A adds `visibleIf` and
 * navigation rules here, and because builder preview, respondent app and API all call these
 * functions, the behaviour stays identical everywhere.
 */
import type { Page, Question, SurveyDefinition } from './schema';
import { validateAnswer, type AnswerErrorCode, type Answers, type AnswerValue } from './answers';

export interface FieldError {
  questionKey: string;
  pageKey: string;
  code: AnswerErrorCode | 'unknown_question';
  message: string;
}

export function isQuestion(element: Page['elements'][number]): element is Question {
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

export function firstPageKey(def: SurveyDefinition): string {
  const first = def.pages[0];
  if (!first) throw new Error('Survey has no pages');
  return first.key;
}

/** The page after `pageKey`, or null when the respondent should submit. */
export function nextPageKey(def: SurveyDefinition, pageKey: string, _answers: Answers): string | null {
  const i = pageIndex(def, pageKey);
  if (i === -1) return firstPageKey(def);
  return def.pages[i + 1]?.key ?? null;
}

export function isLastPage(def: SurveyDefinition, pageKey: string, answers: Answers): boolean {
  return nextPageKey(def, pageKey, answers) === null;
}

/** Elements the respondent sees on a page. Phase 1: all of them. */
export function visibleElements(page: Page, _answers: Answers): Page['elements'] {
  return page.elements;
}

export function progress(
  def: SurveyDefinition,
  pageKey: string,
): { index: number; total: number; percent: number } {
  const total = def.pages.length;
  const index = Math.max(0, pageIndex(def, pageKey));
  return { index, total, percent: total <= 1 ? 0 : Math.round((index / total) * 100) };
}

/** Validate the questions on one page (used by the respondent app on "Next"). */
export function validatePage(
  def: SurveyDefinition,
  pageKey: string,
  answers: Record<string, unknown>,
): FieldError[] {
  const page = def.pages.find((p) => p.key === pageKey);
  if (!page) return [];
  const errors: FieldError[] = [];
  for (const element of visibleElements(page, answers as Answers)) {
    if (element.kind !== 'question') continue;
    const result = validateAnswer(element, answers[element.key]);
    if (!result.ok) errors.push({ questionKey: element.key, pageKey: page.key, ...result.error });
  }
  return errors;
}

export interface CompletionResult {
  ok: boolean;
  errors: FieldError[];
  /** Normalised answers for visible questions only. Answers to unknown or hidden questions are dropped. */
  answers: Answers;
}

/**
 * The authoritative completion check, run by the API before a response is marked completed.
 * Walks the path the respondent would take, validates every visible question and drops
 * everything else.
 */
export function checkCompletion(def: SurveyDefinition, raw: Record<string, unknown>): CompletionResult {
  const errors: FieldError[] = [];
  const answers: Answers = {};
  const visited = new Set<string>();
  let pageKey: string | null = firstPageKey(def);

  while (pageKey !== null && !visited.has(pageKey)) {
    visited.add(pageKey);
    const page = def.pages.find((p) => p.key === pageKey);
    if (!page) break;
    for (const element of visibleElements(page, answers)) {
      if (element.kind !== 'question') continue;
      const result = validateAnswer(element, raw[element.key]);
      if (!result.ok) errors.push({ questionKey: element.key, pageKey: page.key, ...result.error });
      else if (result.value !== null) answers[element.key] = result.value;
    }
    pageKey = nextPageKey(def, page.key, answers);
  }

  return { ok: errors.length === 0, errors, answers };
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
    const result = validateAnswer({ ...question, required: false }, value);
    if (!result.ok) errors.push({ questionKey: key, pageKey, ...result.error });
    else if (result.value !== null) answers[key] = result.value as AnswerValue;
  }
  return { answers, errors };
}
