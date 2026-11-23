import type { ChoiceOption, Question } from './schema';
import { ISO_DATE_PATTERN, LIMITS } from './constants';

/** Answer values as sent by clients and returned by the API (data model §2.5). */
export type AnswerValue =
  string | number | string[] | { option: string; other: string } | { options: string[]; other: string };

export type Answers = Record<string, AnswerValue>;

export type AnswerErrorCode =
  | 'required'
  | 'invalid_type'
  | 'invalid_option'
  | 'duplicate_option'
  | 'other_required'
  | 'exclusive_conflict'
  | 'too_few'
  | 'too_many'
  | 'too_short'
  | 'too_long'
  | 'out_of_range'
  | 'invalid_email'
  | 'invalid_date';

export interface AnswerError {
  code: AnswerErrorCode;
  message: string;
}

export type AnswerResult = { ok: true; value: AnswerValue | null } | { ok: false; error: AnswerError };

const ok = (value: AnswerValue | null): AnswerResult => ({ ok: true, value });
const fail = (code: AnswerErrorCode, message: string): AnswerResult => ({
  ok: false,
  error: { code, message },
});

/** null, undefined, blank strings and empty selections all count as "not answered". */
export function isEmptyAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const v = value as { option?: unknown; options?: unknown };
    if ('options' in v) return !Array.isArray(v.options) || v.options.length === 0;
    if ('option' in v) return typeof v.option !== 'string' || v.option === '';
  }
  return false;
}

/**
 * Validate and normalise one answer against its question.
 * Returns `{ ok: true, value: null }` for an empty, optional answer.
 * Never trusts client-side validation: the API runs this on every save and on completion.
 */
export function validateAnswer(question: Question, raw: unknown): AnswerResult {
  if (isEmptyAnswer(raw)) {
    return question.required ? fail('required', 'This question is required.') : ok(null);
  }

  switch (question.type) {
    case 'single_choice':
    case 'dropdown':
    case 'likert':
      return validateSingle(question.options, raw, question.type === 'single_choice');

    case 'multi_choice':
      return validateMulti(
        question.options,
        raw,
        question.config.minSelections,
        question.config.maxSelections,
      );

    case 'short_text':
    case 'long_text': {
      if (typeof raw !== 'string') return fail('invalid_type', 'Enter text.');
      const text = raw.trim();
      const { minLength, maxLength } = question.config;
      if (minLength !== undefined && text.length < minLength)
        return fail('too_short', `Enter at least ${minLength} characters.`);
      if (text.length > maxLength) return fail('too_long', `Enter no more than ${maxLength} characters.`);
      return ok(text);
    }

    case 'rating': {
      const n = toInteger(raw);
      if (n === null) return fail('invalid_type', 'Choose a rating.');
      if (n < 1 || n > question.config.scale)
        return fail('out_of_range', `Choose a rating from 1 to ${question.config.scale}.`);
      return ok(n);
    }

    case 'nps': {
      const n = toInteger(raw);
      if (n === null) return fail('invalid_type', 'Choose a score.');
      if (n < 0 || n > 10) return fail('out_of_range', 'Choose a score from 0 to 10.');
      return ok(n);
    }

    case 'email': {
      if (typeof raw !== 'string') return fail('invalid_type', 'Enter an email address.');
      const email = raw.trim().toLowerCase();
      if (email.length > 254 || !EMAIL_PATTERN.test(email))
        return fail('invalid_email', 'Enter a valid email address, like name@example.com.');
      return ok(email);
    }

    case 'date': {
      if (typeof raw !== 'string' || !isValidIsoDate(raw)) return fail('invalid_date', 'Enter a valid date.');
      const { minDate, maxDate } = question.config;
      if (minDate && raw < minDate) return fail('out_of_range', `Enter a date on or after ${minDate}.`);
      if (maxDate && raw > maxDate) return fail('out_of_range', `Enter a date on or before ${maxDate}.`);
      return ok(raw);
    }
  }
}

// Deliberately simple: one @, no spaces, a dot in the domain. Full RFC 5322 validation rejects real addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function toInteger(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

function validateSingle(options: ChoiceOption[], raw: unknown, allowOther: boolean): AnswerResult {
  let key: unknown = raw;
  let other: unknown;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'option' in raw) {
    key = (raw as { option: unknown }).option;
    other = (raw as { other?: unknown }).other;
  }
  if (typeof key !== 'string') return fail('invalid_type', 'Choose an option.');
  const option = options.find((o) => o.key === key);
  if (!option) return fail('invalid_option', 'Choose one of the listed options.');
  if (option.isOther && allowOther) {
    const text = typeof other === 'string' ? other.trim() : '';
    if (!text) return fail('other_required', 'Please specify your answer.');
    if (text.length > LIMITS.otherTextLength)
      return fail('too_long', `Enter no more than ${LIMITS.otherTextLength} characters.`);
    return ok({ option: option.key, other: text });
  }
  return ok(option.key);
}

function validateMulti(
  options: ChoiceOption[],
  raw: unknown,
  min: number | undefined,
  max: number | undefined,
): AnswerResult {
  let keys: unknown = raw;
  let other: unknown;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'options' in raw) {
    keys = (raw as { options: unknown }).options;
    other = (raw as { other?: unknown }).other;
  }
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string'))
    return fail('invalid_type', 'Choose one or more options.');
  const selected = new Set(keys as string[]);
  if (selected.size !== keys.length) return fail('duplicate_option', 'Each option can only be chosen once.');
  for (const key of selected) {
    if (!options.some((o) => o.key === key)) return fail('invalid_option', 'Choose from the listed options.');
  }
  const exclusive = options.find((o) => o.exclusive && selected.has(o.key));
  if (exclusive && selected.size > 1)
    return fail('exclusive_conflict', `"${exclusive.label}" can't be combined with other options.`);
  if (!exclusive) {
    if (min !== undefined && selected.size < min) return fail('too_few', `Choose at least ${min} options.`);
    if (max !== undefined && selected.size > max)
      return fail('too_many', `Choose no more than ${max} options.`);
  }
  // Normalise to definition order so storage and exports are deterministic.
  const ordered = options.filter((o) => selected.has(o.key)).map((o) => o.key);
  const otherOption = options.find((o) => o.isOther && selected.has(o.key));
  if (otherOption) {
    const text = typeof other === 'string' ? other.trim() : '';
    if (!text) return fail('other_required', 'Please specify your answer.');
    if (text.length > LIMITS.otherTextLength)
      return fail('too_long', `Enter no more than ${LIMITS.otherTextLength} characters.`);
    return ok({ options: ordered, other: text });
  }
  return ok(ordered);
}

/** The selected option keys of a choice answer, whatever its shape. */
export function selectedOptionKeys(value: AnswerValue | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && 'options' in value) return value.options;
  if (typeof value === 'object' && 'option' in value) return [value.option];
  return [];
}

/** The "Other" free text of a choice answer, if any. */
export function otherText(value: AnswerValue | null | undefined): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'other' in value) return value.other;
  return null;
}
