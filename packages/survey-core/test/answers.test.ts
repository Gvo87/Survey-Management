import { describe, expect, it } from 'vitest';
import {
  findQuestion,
  isEmptyAnswer,
  selectedOptionKeys,
  otherText,
  validateAnswer,
  isValidIsoDate,
} from '../src';
import type { Question } from '../src';
import { allTypesSurvey } from './fixtures';

const def = allTypesSurvey();
const q = (key: string): Question => {
  const found = findQuestion(def, key);
  if (!found) throw new Error(`missing ${key}`);
  return found;
};

type Case = [label: string, question: string, input: unknown, expected: unknown | { error: string }];

const cases: Case[] = [
  // single choice
  ['single: valid option', 'q_single01', 'o_red00001', 'o_red00001'],
  ['single: required and empty', 'q_single01', '', { error: 'required' }],
  ['single: unknown option', 'q_single01', 'o_nope0001', { error: 'invalid_option' }],
  ['single: wrong type', 'q_single01', 42, { error: 'invalid_type' }],
  [
    'single: other with text',
    'q_single01',
    { option: 'o_other001', other: '  Teal ' },
    { option: 'o_other001', other: 'Teal' },
  ],
  ['single: other without text', 'q_single01', 'o_other001', { error: 'other_required' }],
  [
    'single: other with blank text',
    'q_single01',
    { option: 'o_other001', other: '   ' },
    { error: 'other_required' },
  ],
  // multi choice (min 2, max 3, exclusive "none", other)
  ['multi: empty optional', 'q_multi001', [], null],
  [
    'multi: normalised to definition order',
    'q_multi001',
    ['o_c0000001', 'o_a0000001'],
    ['o_a0000001', 'o_c0000001'],
  ],
  ['multi: below min', 'q_multi001', ['o_a0000001'], { error: 'too_few' }],
  [
    'multi: above max',
    'q_multi001',
    ['o_a0000001', 'o_b0000001', 'o_c0000001', 'o_moth0001'],
    { error: 'too_many' },
  ],
  [
    'multi: above max (no other)',
    'q_multi001',
    ['o_a0000001', 'o_b0000001', 'o_c0000001', 'o_none0001'],
    { error: 'exclusive_conflict' },
  ],
  ['multi: exclusive alone ignores min', 'q_multi001', ['o_none0001'], ['o_none0001']],
  ['multi: duplicates', 'q_multi001', ['o_a0000001', 'o_a0000001'], { error: 'duplicate_option' }],
  ['multi: unknown option', 'q_multi001', ['o_a0000001', 'o_zzz00001'], { error: 'invalid_option' }],
  [
    'multi: other with text',
    'q_multi001',
    { options: ['o_moth0001', 'o_a0000001'], other: 'x' },
    { options: ['o_a0000001', 'o_moth0001'], other: 'x' },
  ],
  ['multi: not an array', 'q_multi001', 'o_a0000001', { error: 'invalid_type' }],
  // dropdown
  ['dropdown: valid', 'q_drop0001', 'o_fr000001', 'o_fr000001'],
  [
    'dropdown: other shape not accepted for unknown',
    'q_drop0001',
    { option: 'o_xx000001', other: 'x' },
    { error: 'invalid_option' },
  ],
  // short text (min 2, max 10)
  ['short: trimmed', 'q_short001', '  Ana  ', 'Ana'],
  ['short: too short', 'q_short001', 'A', { error: 'too_short' }],
  ['short: too long', 'q_short001', 'Alexandrina!', { error: 'too_long' }],
  ['short: whitespace is empty', 'q_short001', '    ', null],
  ['short: wrong type', 'q_short001', 5, { error: 'invalid_type' }],
  // long text
  ['long: max 100', 'q_long0001', 'x'.repeat(101), { error: 'too_long' }],
  // rating 1–5
  ['rating: valid', 'q_rate0001', 4, 4],
  ['rating: numeric string accepted', 'q_rate0001', '3', 3],
  ['rating: zero', 'q_rate0001', 0, { error: 'out_of_range' }],
  ['rating: above scale', 'q_rate0001', 6, { error: 'out_of_range' }],
  ['rating: fractional', 'q_rate0001', 2.5, { error: 'invalid_type' }],
  ['rating: required', 'q_rate0001', null, { error: 'required' }],
  // nps 0–10
  ['nps: zero allowed', 'q_nps00001', 0, 0],
  ['nps: ten', 'q_nps00001', 10, 10],
  ['nps: eleven', 'q_nps00001', 11, { error: 'out_of_range' }],
  ['nps: negative', 'q_nps00001', -1, { error: 'out_of_range' }],
  // likert
  ['likert: valid', 'q_like0001', 'o_l3000001', 'o_l3000001'],
  ['likert: invalid', 'q_like0001', 'o_l9000001', { error: 'invalid_option' }],
  // email
  ['email: normalised', 'q_mail0001', '  Ana@Example.COM ', 'ana@example.com'],
  ['email: missing domain dot', 'q_mail0001', 'ana@example', { error: 'invalid_email' }],
  ['email: spaces', 'q_mail0001', 'ana smith@example.com', { error: 'invalid_email' }],
  ['email: too long', 'q_mail0001', `${'a'.repeat(250)}@x.io`, { error: 'invalid_email' }],
  // date (2026)
  ['date: valid', 'q_date0001', '2026-06-15', '2026-06-15'],
  ['date: impossible day', 'q_date0001', '2026-02-30', { error: 'invalid_date' }],
  ['date: wrong format', 'q_date0001', '15/06/2026', { error: 'invalid_date' }],
  ['date: before min', 'q_date0001', '2025-12-31', { error: 'out_of_range' }],
  ['date: after max', 'q_date0001', '2027-01-01', { error: 'out_of_range' }],
];

describe('validateAnswer', () => {
  it.each(cases)('%s', (_label, key, input, expected) => {
    const result = validateAnswer(q(key), input);
    if (expected && typeof expected === 'object' && 'error' in expected) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(expected.error);
        expect(result.error.message.length).toBeGreaterThan(5);
      }
    } else {
      expect(result).toEqual({ ok: true, value: expected });
    }
  });
});

describe('helpers', () => {
  it('isEmptyAnswer', () => {
    expect(isEmptyAnswer(undefined)).toBe(true);
    expect(isEmptyAnswer('  ')).toBe(true);
    expect(isEmptyAnswer([])).toBe(true);
    expect(isEmptyAnswer({ options: [], other: 'x' })).toBe(true);
    expect(isEmptyAnswer({ option: '', other: 'x' })).toBe(true);
    expect(isEmptyAnswer(0)).toBe(false);
    expect(isEmptyAnswer('a')).toBe(false);
  });

  it('selectedOptionKeys and otherText handle every shape', () => {
    expect(selectedOptionKeys('a')).toEqual(['a']);
    expect(selectedOptionKeys(['a', 'b'])).toEqual(['a', 'b']);
    expect(selectedOptionKeys({ option: 'a', other: 'x' })).toEqual(['a']);
    expect(selectedOptionKeys({ options: ['a'], other: 'x' })).toEqual(['a']);
    expect(selectedOptionKeys(null)).toEqual([]);
    expect(otherText({ option: 'a', other: 'x' })).toBe('x');
    expect(otherText('a')).toBeNull();
  });

  it('isValidIsoDate handles leap years', () => {
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
  });
});
