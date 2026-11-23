import type { ChoiceOption, Question } from './schema';
import { DATETIME_PATTERN, ISO_DATE_PATTERN, LIMITS, TIME_PATTERN, UUID_PATTERN } from './constants';

/** Answer values as sent by clients and returned by the API (data model §2.5). */
export type AnswerValue =
  | string
  | number
  | boolean
  | string[]
  | { option: string; other: string }
  | { options: string[]; other: string }
  /** Matrix: row key → column key (or keys when several are allowed per row). */
  | Record<string, string | string[]>;

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
  | 'invalid_phone'
  | 'invalid_date'
  | 'invalid_number'
  | 'pattern_mismatch'
  | 'incomplete';

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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** null, undefined, false, blank strings and empty selections all count as "not answered". */
export function isEmptyAnswer(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) {
    if ('options' in value) return !Array.isArray(value.options) || value.options.length === 0;
    if ('option' in value) return typeof value.option !== 'string' || value.option === '';
    // Matrix: empty when no row has an answer.
    return Object.values(value).every((v) => isEmptyAnswer(v));
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
    return question.required ? fail('required', question.type === 'consent' ? 'Tick the box to agree.' : 'This question is required.') : ok(null);
  }

  switch (question.type) {
    case 'single_choice':
    case 'dropdown':
    case 'likert':
      return validateSingle(question.options, raw, question.type === 'single_choice');

    case 'multi_choice':
      return validateMulti(question.options, raw, question.config.minSelections, question.config.maxSelections);

    case 'matrix':
      return validateMatrix(question, raw);

    case 'ranking': {
      if (!Array.isArray(raw) || raw.some((k) => typeof k !== 'string')) return fail('invalid_type', 'Rank the options.');
      const keys = raw as string[];
      if (new Set(keys).size !== keys.length) return fail('duplicate_option', 'Each option can only be ranked once.');
      if (keys.some((k) => !question.options.some((o) => o.key === k)))
        return fail('invalid_option', 'Rank the listed options.');
      const needed = Math.min(question.config.rankCount ?? question.options.length, question.options.length);
      if (keys.length !== needed)
        return fail('incomplete', needed === question.options.length ? 'Rank every option.' : `Rank your top ${needed}.`);
      return ok(keys);
    }

    case 'short_text': {
      if (typeof raw !== 'string') return fail('invalid_type', 'Enter text.');
      const text = raw.trim();
      const { minLength, maxLength, format, minValue, maxValue, pattern, patternMessage } = question.config;
      if (minLength !== undefined && text.length < minLength)
        return fail('too_short', `Enter at least ${minLength} characters.`);
      if (text.length > maxLength) return fail('too_long', `Enter no more than ${maxLength} characters.`);
      let normalised = text;
      if (format === 'number' || format === 'integer') {
        const n = Number(text.replace(',', '.'));
        if (text === '' || !Number.isFinite(n)) return fail('invalid_number', 'Enter a number.');
        if (format === 'integer' && !Number.isInteger(n)) return fail('invalid_number', 'Enter a whole number.');
        if (minValue !== undefined && n < minValue) return fail('out_of_range', `Enter ${minValue} or more.`);
        if (maxValue !== undefined && n > maxValue) return fail('out_of_range', `Enter ${maxValue} or less.`);
        normalised = String(n);
      }
      if (pattern && !matchesPattern(pattern, text))
        return fail('pattern_mismatch', patternMessage || 'Enter a value in the expected format.');
      return ok(normalised);
    }

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

    case 'slider': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) return fail('invalid_type', 'Choose a value.');
      const { min, max, step } = question.config;
      if (n < min || n > max) return fail('out_of_range', `Choose a value from ${min} to ${max}.`);
      const steps = (n - min) / step;
      if (Math.abs(steps - Math.round(steps)) > 1e-6) return fail('out_of_range', `Choose a value in steps of ${step}.`);
      return ok(Math.round((min + Math.round(steps) * step) * 1e6) / 1e6);
    }

    case 'email': {
      if (typeof raw !== 'string') return fail('invalid_type', 'Enter an email address.');
      const email = raw.trim().toLowerCase();
      if (email.length > 254 || !EMAIL_PATTERN.test(email))
        return fail('invalid_email', 'Enter a valid email address, like name@example.com.');
      return ok(email);
    }

    case 'phone': {
      if (typeof raw !== 'string') return fail('invalid_type', 'Enter a phone number.');
      const phone = normalisePhone(raw);
      if (!phone) return fail('invalid_phone', 'Enter the number with its country code, like +44 20 7946 0958.');
      return ok(phone);
    }

    case 'date': {
      const mode = question.config.mode ?? 'date';
      if (typeof raw !== 'string') return fail('invalid_date', 'Enter a valid date.');
      if (mode === 'time') {
        if (!TIME_PATTERN.test(raw)) return fail('invalid_date', 'Enter a valid time.');
        const { minTime, maxTime } = question.config;
        if (minTime && raw < minTime) return fail('out_of_range', `Enter a time at or after ${minTime}.`);
        if (maxTime && raw > maxTime) return fail('out_of_range', `Enter a time at or before ${maxTime}.`);
        return ok(raw);
      }
      const valid = mode === 'datetime' ? DATETIME_PATTERN.test(raw) && isValidIsoDate(raw.slice(0, 10)) : isValidIsoDate(raw);
      if (!valid) return fail('invalid_date', mode === 'datetime' ? 'Enter a valid date and time.' : 'Enter a valid date.');
      const day = raw.slice(0, 10);
      const { minDate, maxDate } = question.config;
      if (minDate && day < minDate) return fail('out_of_range', `Enter a date on or after ${minDate}.`);
      if (maxDate && day > maxDate) return fail('out_of_range', `Enter a date on or before ${maxDate}.`);
      return ok(raw);
    }

    case 'file_upload': {
      if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id)))
        return fail('invalid_type', 'Upload a file.');
      const ids = [...new Set(raw as string[])];
      if (ids.length > question.config.maxFiles)
        return fail('too_many', `Upload no more than ${question.config.maxFiles} file${question.config.maxFiles > 1 ? 's' : ''}.`);
      return ok(ids);
    }

    case 'consent':
      return raw === true ? ok(true) : fail('invalid_type', 'Tick the box to agree.');
  }
}

// Deliberately simple: one @, no spaces, a dot in the domain. Full RFC 5322 validation rejects real addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** E.164: "+", country code and number, 8–15 digits in total. Separators are ignored; "00" means "+". */
export function normalisePhone(raw: string): string | null {
  let value = raw.trim().replace(/[\s().\-/]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

/** Full-match test of a creator-supplied pattern. Patterns are checked for safety when published. */
export function matchesPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u').test(text.slice(0, LIMITS.shortTextMax));
  } catch {
    return false;
  }
}

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
  if (isPlainObject(raw) && 'option' in raw) {
    key = raw.option;
    other = raw.other;
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

function validateMulti(options: ChoiceOption[], raw: unknown, min: number | undefined, max: number | undefined): AnswerResult {
  let keys: unknown = raw;
  let other: unknown;
  if (isPlainObject(raw) && 'options' in raw) {
    keys = raw.options;
    other = raw.other;
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
    if (max !== undefined && selected.size > max) return fail('too_many', `Choose no more than ${max} options.`);
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

function validateMatrix(question: Extract<Question, { type: 'matrix' }>, raw: unknown): AnswerResult {
  if (!isPlainObject(raw)) return fail('invalid_type', 'Answer each row.');
  const columns = new Set(question.options.map((o) => o.key));
  const result: Record<string, string | string[]> = {};
  for (const [rowKey, value] of Object.entries(raw)) {
    if (!question.rows.some((r) => r.key === rowKey)) return fail('invalid_option', 'Answer the listed rows.');
    if (isEmptyAnswer(value)) continue;
    if (question.config.multiplePerRow) {
      if (!Array.isArray(value) || value.some((c) => typeof c !== 'string' || !columns.has(c)))
        return fail('invalid_option', 'Choose from the listed columns.');
      const set = new Set(value as string[]);
      result[rowKey] = question.options.filter((o) => set.has(o.key)).map((o) => o.key);
    } else {
      if (typeof value !== 'string' || !columns.has(value)) return fail('invalid_option', 'Choose one column per row.');
      result[rowKey] = value;
    }
  }
  if (question.required && question.rows.some((r) => !(r.key in result)))
    return fail('incomplete', 'Answer every row.');
  // Definition order, so storage and exports are deterministic.
  const ordered: Record<string, string | string[]> = {};
  for (const row of question.rows) if (row.key in result) ordered[row.key] = result[row.key]!;
  return Object.keys(ordered).length ? ok(ordered) : question.required ? fail('required', 'This question is required.') : ok(null);
}

/** The selected option keys of a choice answer, whatever its shape. */
export function selectedOptionKeys(value: AnswerValue | null | undefined): string[] {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  if ('options' in value && Array.isArray(value.options)) return value.options;
  if ('option' in value && typeof value.option === 'string') return [value.option];
  return [];
}

/** The "Other" free text of a choice answer, if any. */
export function otherText(value: AnswerValue | null | undefined): string | null {
  if (isPlainObject(value) && 'other' in value && typeof value.other === 'string') return value.other;
  return null;
}
