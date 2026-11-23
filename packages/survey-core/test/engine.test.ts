import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  checkCompletion,
  createDefinition,
  createPage,
  createQuestion,
  firstPageKey,
  isLastPage,
  listQuestions,
  nextPageKey,
  progress,
  validatePage,
  validatePartialAnswers,
  QUESTION_TYPES,
} from '../src';
import { allTypesSurvey } from './fixtures';

describe('navigation', () => {
  const def = allTypesSurvey();

  it('walks pages in order and ends after the last page', () => {
    expect(firstPageKey(def)).toBe('p_page0001');
    expect(nextPageKey(def, 'p_page0001', {})).toBe('p_page0002');
    expect(nextPageKey(def, 'p_page0002', {})).toBeNull();
    expect(isLastPage(def, 'p_page0002', {})).toBe(true);
  });

  it('restarts at the first page for an unknown page key', () => {
    expect(nextPageKey(def, 'p_gone0001', {})).toBe('p_page0001');
  });

  it('reports progress', () => {
    expect(progress(def, 'p_page0001')).toEqual({ index: 0, total: 2, percent: 0 });
    expect(progress(def, 'p_page0002')).toEqual({ index: 1, total: 2, percent: 50 });
  });

  it('navigation terminates for any number of pages', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (pages) => {
        const d = createDefinition();
        d.pages = Array.from({ length: pages }, () => createPage());
        let key: string | null = firstPageKey(d);
        let steps = 0;
        while (key !== null && steps <= pages) {
          key = nextPageKey(d, key, {});
          steps++;
        }
        return key === null && steps === pages;
      }),
    );
  });
});

describe('validatePage', () => {
  it('only validates questions on the given page', () => {
    const def = allTypesSurvey();
    const errors = validatePage(def, 'p_page0001', {});
    expect(errors.map((e) => e.questionKey)).toEqual(['q_single01']);
    expect(errors[0]).toMatchObject({ code: 'required', pageKey: 'p_page0001' });
  });

  it('passes when required answers are present and valid', () => {
    const def = allTypesSurvey();
    expect(validatePage(def, 'p_page0001', { q_single01: 'o_red00001' })).toEqual([]);
  });
});

describe('checkCompletion', () => {
  const def = allTypesSurvey();
  const valid = {
    q_single01: 'o_blue0001',
    q_multi001: ['o_b0000001', 'o_a0000001'],
    q_short001: ' Ana ',
    q_rate0001: 5,
    q_nps00001: 9,
    q_mail0001: 'ANA@EXAMPLE.COM',
  };

  it('accepts a complete response and normalises answers', () => {
    const result = checkCompletion(def, valid);
    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({
      q_single01: 'o_blue0001',
      q_multi001: ['o_a0000001', 'o_b0000001'],
      q_short001: 'Ana',
      q_rate0001: 5,
      q_nps00001: 9,
      q_mail0001: 'ana@example.com',
    });
  });

  it('rejects missing required answers on any page, with the page to return to', () => {
    const { q_rate0001: _, ...missing } = valid;
    const result = checkCompletion(def, missing);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ questionKey: 'q_rate0001', pageKey: 'p_page0002', code: 'required' }),
    ]);
  });

  it('drops answers to questions that do not exist (tampering)', () => {
    const result = checkCompletion(def, { ...valid, q_injected: 'hello', t_intro001: 'x' });
    expect(result.ok).toBe(true);
    expect(result.answers).not.toHaveProperty('q_injected');
    expect(result.answers).not.toHaveProperty('t_intro001');
  });

  it('property: completion output only contains known question keys', () => {
    const known = new Set(listQuestions(def).map((q) => q.key));
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.jsonValue()), (raw) => {
        const result = checkCompletion(def, { ...valid, ...raw });
        return Object.keys(result.answers).every((k) => known.has(k));
      }),
    );
  });

  it('property: an optional question never produces a "required" error', () => {
    const optionalTypes = fc.constantFrom(...QUESTION_TYPES);
    fc.assert(
      fc.property(optionalTypes, (type) => {
        const d = createDefinition();
        d.pages[0]!.elements.push(createQuestion(type, 'Q'));
        return checkCompletion(d, {}).ok;
      }),
    );
  });
});

describe('validatePartialAnswers', () => {
  it('allows missing required answers but flags malformed and unknown ones', () => {
    const def = allTypesSurvey();
    const { answers, errors } = validatePartialAnswers(def, {
      q_single01: 'o_red00001',
      q_rate0001: 99,
      q_unknown1: 'x',
    });
    expect(answers).toEqual({ q_single01: 'o_red00001' });
    expect(errors.map((e) => [e.questionKey, e.code])).toEqual([
      ['q_rate0001', 'out_of_range'],
      ['q_unknown1', 'unknown_question'],
    ]);
  });
});
