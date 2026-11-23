import { describe, expect, it } from 'vitest';
import {
  checkCompletion,
  conditionDepth,
  createDefinition,
  createQuestion,
  evaluate,
  firstPageKey,
  nextStep,
  pathAnswers,
  validateDefinition,
  validatePage,
  visibleElements,
  type Condition,
  type SurveyDefinition,
} from '../src';
import { parseDefinition } from '../src/schema';
import vectors from '../test-vectors/logic.json';

const def = vectors.definition as unknown as SurveyDefinition;

describe('shared logic test vectors', () => {
  it('the vector definition is valid', () => {
    expect(parseDefinition(def)).toMatchObject({ ok: true });
    expect(validateDefinition(def).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it.each(vectors.cases)('$name', (c) => {
    const result = checkCompletion(def, c.answers, (c as { hidden?: Record<string, string> }).hidden);
    expect({
      ok: result.ok,
      outcome: result.outcome,
      path: result.path,
      answeredKeys: Object.keys(result.answers).sort(),
      errors: result.errors.map((e) => e.questionKey),
    }).toEqual(c.expect);
  });
});

describe('condition operators', () => {
  const d = createDefinition();
  const single = createQuestion('single_choice', 'S');
  const multi = createQuestion('multi_choice', 'M');
  const rating = createQuestion('rating', 'R');
  const text = createQuestion('short_text', 'T');
  const date = createQuestion('date', 'D');
  const ranking = createQuestion('ranking', 'K');
  d.pages[0]!.elements.push(single, multi, rating, text, date, ranking);
  const [s1, s2] = (single as { options: { key: string }[] }).options;
  const [m1, m2, m3] = (multi as { options: { key: string }[] }).options;
  const [k1, k2, k3] = (ranking as { options: { key: string }[] }).options;
  const answers = {
    [single.key]: { option: s1!.key, other: 'x' },
    [multi.key]: [m1!.key, m2!.key],
    [rating.key]: 4,
    [text.key]: '  Hello World ',
    [date.key]: '2026-06-15',
    [ranking.key]: [k2!.key, k1!.key, k3!.key],
  };
  const is = (c: Condition) => evaluate(d, c, { answers, hidden: { src: 'Email' } });

  it.each([
    ['choice eq (Other shape)', { source: { question: single.key }, op: 'eq', value: s1!.key }, true],
    ['choice neq', { source: { question: single.key }, op: 'neq', value: s2!.key }, true],
    ['choice in', { source: { question: single.key }, op: 'in', value: [s2!.key, s1!.key] }, true],
    ['choice not_in', { source: { question: single.key }, op: 'not_in', value: [s1!.key] }, false],
    ['multi contains_any', { source: { question: multi.key }, op: 'contains_any', value: [m3!.key, m2!.key] }, true],
    ['multi contains_all', { source: { question: multi.key }, op: 'contains_all', value: [m1!.key, m3!.key] }, false],
    ['multi contains_none', { source: { question: multi.key }, op: 'contains_none', value: [m3!.key] }, true],
    ['number gte', { source: { question: rating.key }, op: 'gte', value: 4 }, true],
    ['number lt', { source: { question: rating.key }, op: 'lt', value: 4 }, false],
    ['number between', { source: { question: rating.key }, op: 'between', value: [3, 5] }, true],
    ['text eq ignores case and spaces', { source: { question: text.key }, op: 'eq', value: 'hello world' }, true],
    ['text contains', { source: { question: text.key }, op: 'text_contains', value: 'WORLD' }, true],
    ['date gt', { source: { question: date.key }, op: 'gt', value: '2026-06-01' }, true],
    ['date between', { source: { question: date.key }, op: 'between', value: ['2026-01-01', '2026-06-14'] }, false],
    ['ranked option rank', { source: { question: ranking.key, sub: k2!.key }, op: 'eq', value: 1 }, true],
    ['ranked in top 2', { source: { question: ranking.key, sub: k3!.key }, op: 'lte', value: 2 }, false],
    ['hidden field eq ignores case', { source: { hidden: 'src' }, op: 'eq', value: 'email' }, true],
    ['missing hidden field is not answered', { source: { hidden: 'nope' }, op: 'not_answered' }, true],
    ['AND', { all: [{ source: { question: rating.key }, op: 'eq', value: 4 }, { source: { hidden: 'src' }, op: 'eq', value: 'x' }] }, false],
    ['OR', { any: [{ source: { question: rating.key }, op: 'eq', value: 1 }, { source: { hidden: 'src' }, op: 'answered' }] }, true],
    ['NOT', { not: { source: { question: rating.key }, op: 'eq', value: 4 } }, false],
  ] as [string, Condition, boolean][])('%s', (_name, condition, expected) => {
    expect(is(condition)).toBe(expected);
  });

  it('comparisons on unanswered questions are false, so "is not" excludes people who skipped', () => {
    const empty = { answers: {} };
    expect(evaluate(d, { source: { question: single.key }, op: 'neq', value: s1!.key }, empty)).toBe(false);
    expect(evaluate(d, { source: { question: single.key }, op: 'not_answered' }, empty)).toBe(true);
  });

  it('measures nesting depth', () => {
    expect(conditionDepth({ source: { hidden: 'a' }, op: 'answered' })).toBe(0);
    expect(conditionDepth({ not: { any: [{ all: [{ source: { hidden: 'a' }, op: 'answered' }] }] } })).toBe(3);
  });
});

describe('visibility and navigation', () => {
  it('hides elements whose conditions fail and skips hidden pages', () => {
    const page1 = def.pages[0]!;
    const without = visibleElements(def, page1, { answers: { q_vecuse001: ['o_vecweb001'] } });
    expect(without.map((e) => e.key)).toEqual(['q_vecage001', 'q_vecuse001']);
    const withApp = visibleElements(def, page1, { answers: { q_vecuse001: ['o_vecapp001'] } });
    expect(withApp.map((e) => e.key)).toContain('q_vecapp001');

    expect(nextStep(def, 'p_vecpage01', { answers: { q_vecage001: 'o_vec18a001', q_vecuse001: ['o_vecapp001'] } })).toEqual({
      kind: 'page',
      pageKey: 'p_vecpage03',
    });
    expect(nextStep(def, 'p_vecpage01', { answers: { q_vecage001: 'o_vecu18001' } })).toEqual({ kind: 'disqualify' });
    expect(nextStep(def, 'p_vecpage03', { answers: {} })).toEqual({ kind: 'end' });
    expect(firstPageKey(def)).toBe('p_vecpage01');
  });

  it('a skip rule jumps forward to its target, or the next visible page after it', () => {
    const d = createDefinition();
    d.pages = ['p_skip00001', 'p_skip00002', 'p_skip00003', 'p_skip00004'].map((key) => ({ key, elements: [] }));
    d.pages[2]!.visibleIf = { source: { hidden: 'never' }, op: 'answered' };
    d.logic = [{ id: 'r_skip00001', afterPage: 'p_skip00001', when: { source: { hidden: 'go' }, op: 'answered' }, then: { goTo: 'p_skip00003' } }];
    expect(nextStep(d, 'p_skip00001', { answers: {}, hidden: { go: '1' } })).toEqual({ kind: 'page', pageKey: 'p_skip00004' });
    expect(nextStep(d, 'p_skip00001', { answers: {} })).toEqual({ kind: 'page', pageKey: 'p_skip00002' });
  });

  it('answers on pages the path skips do not count for later conditions', () => {
    // An answer to q_vecweb001 is present, but page 2 isn't on this path.
    const counted = pathAnswers(def, { q_vecuse001: ['o_vecapp001'], q_vecweb001: 5, q_vecage001: 'o_vec18a001' }, 'p_vecpage03');
    expect(counted).not.toHaveProperty('q_vecweb001');
  });

  it('validatePage ignores hidden required questions', () => {
    expect(validatePage(def, 'p_vecpage01', { q_vecage001: 'o_vec18a001', q_vecuse001: ['o_vecweb001'] })).toEqual([]);
    expect(validatePage(def, 'p_vecpage01', { q_vecage001: 'o_vec18a001', q_vecuse001: ['o_vecapp001'] })).toEqual([
      expect.objectContaining({ questionKey: 'q_vecapp001', code: 'required' }),
    ]);
  });
});
