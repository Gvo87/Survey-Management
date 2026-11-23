import { describe, expect, it } from 'vitest';
import {
  bankQuestion,
  checkCompletion,
  checkThemeContrast,
  completionRedirect,
  contrastRatio,
  createDefinition,
  createQuestion,
  DEFAULT_THEME,
  displayAnswer,
  isSafePattern,
  listQuestions,
  malformedTokens,
  normalisePhone,
  pipe,
  remapDefinitionKeys,
  validateAnswer,
  validateDefinition,
  type Question,
  type SurveyDefinition,
} from '../src';
import { parseDefinition } from '../src/schema';
import vectors from '../test-vectors/logic.json';

const vectorDef = vectors.definition as unknown as SurveyDefinition;
const codes = (def: SurveyDefinition, ctx = {}) => validateDefinition(def, ctx).filter((i) => i.severity === 'error').map((i) => i.code);
const q = <T extends Question['type']>(type: T, patch: Record<string, unknown> = {}) =>
  ({ ...createQuestion(type, 'Question'), ...patch }) as Extract<Question, { type: T }>;
const v = (question: Question, raw: unknown) => {
  const r = validateAnswer(question, raw);
  return r.ok ? { value: r.value } : { error: r.error.code };
};

describe('new question types', () => {
  it('matrix: one column per row, every row when required, definition order', () => {
    const m = q('matrix', { required: true });
    const [r1, r2] = m.rows;
    const [c1, c2] = m.options;
    expect(v(m, { [r2!.key]: c1!.key, [r1!.key]: c2!.key })).toEqual({ value: { [r1!.key]: c2!.key, [r2!.key]: c1!.key } });
    expect(v(m, { [r1!.key]: c1!.key })).toEqual({ error: 'incomplete' });
    expect(v(m, { o_unknown01: c1!.key })).toEqual({ error: 'invalid_option' });
    expect(v(m, { [r1!.key]: [c1!.key] })).toEqual({ error: 'invalid_option' });
    const multi = { ...m, required: false, config: { multiplePerRow: true, randomizeRows: false } };
    expect(v(multi, { [r1!.key]: [c2!.key, c1!.key] })).toEqual({ value: { [r1!.key]: [c1!.key, c2!.key] } });
  });

  it('ranking: every option (or the top N), each once', () => {
    const r = q('ranking');
    const [a, b, c] = r.options.map((o) => o.key);
    expect(v(r, [c, a, b])).toEqual({ value: [c, a, b] });
    expect(v(r, [c, a])).toEqual({ error: 'incomplete' });
    expect(v(r, [a, a, b])).toEqual({ error: 'duplicate_option' });
    const top2 = { ...r, config: { randomize: false, rankCount: 2 } };
    expect(v(top2, [b, a])).toEqual({ value: [b, a] });
  });

  it('slider: range and step', () => {
    const s = q('slider', { config: { min: 0, max: 10, step: 0.5 } });
    expect(v(s, 7.5)).toEqual({ value: 7.5 });
    expect(v(s, '3')).toEqual({ value: 3 });
    expect(v(s, 7.3)).toEqual({ error: 'out_of_range' });
    expect(v(s, 11)).toEqual({ error: 'out_of_range' });
  });

  it('phone: normalised to E.164', () => {
    expect(normalisePhone('+44 (20) 7946-0958')).toBe('+442079460958');
    expect(normalisePhone('0044 20 7946 0958')).toBe('+442079460958');
    expect(normalisePhone('020 7946 0958')).toBeNull();
    expect(v(q('phone'), '+1 415 555 0123')).toEqual({ value: '+14155550123' });
    expect(v(q('phone'), '12345')).toEqual({ error: 'invalid_phone' });
  });

  it('date, time and datetime modes with bounds', () => {
    expect(v(q('date', { config: { mode: 'time', minTime: '09:00' } }), '08:30')).toEqual({ error: 'out_of_range' });
    expect(v(q('date', { config: { mode: 'time' } }), '14:05')).toEqual({ value: '14:05' });
    expect(v(q('date', { config: { mode: 'datetime', maxDate: '2026-12-31' } }), '2026-06-01T09:30')).toEqual({ value: '2026-06-01T09:30' });
    expect(v(q('date', { config: { mode: 'datetime', maxDate: '2026-12-31' } }), '2027-01-01T00:00')).toEqual({ error: 'out_of_range' });
    expect(v(q('date', { config: { mode: 'datetime' } }), '2026-02-30T10:00')).toEqual({ error: 'invalid_date' });
  });

  it('file upload: file ids only, limited count', () => {
    const f = q('file_upload', { config: { maxFiles: 2, maxSizeMb: 5, allowedTypes: ['image'] } });
    const id = (n: number) => `0192f0a0-0000-7000-8000-00000000000${n}`;
    expect(v(f, [id(1)])).toEqual({ value: [id(1)] });
    expect(v(f, [id(1), id(2), id(3)])).toEqual({ error: 'too_many' });
    expect(v(f, ['../etc/passwd'])).toEqual({ error: 'invalid_type' });
  });

  it('consent: must be true when required', () => {
    const c = q('consent');
    expect(c.required).toBe(true);
    expect(v(c, true)).toEqual({ value: true });
    expect(v(c, false)).toEqual({ error: 'required' });
  });

  it('short text: number format, ranges and patterns', () => {
    const n = q('short_text', { config: { maxLength: 20, format: 'integer', minValue: 1, maxValue: 99 } });
    expect(v(n, ' 42 ')).toEqual({ value: '42' });
    expect(v(n, '4.5')).toEqual({ error: 'invalid_number' });
    expect(v(n, '120')).toEqual({ error: 'out_of_range' });
    const p = q('short_text', { config: { maxLength: 20, pattern: '[A-Z]{2}-\\d{4}', patternMessage: 'Use AB-1234' } });
    expect(v(p, 'AB-1234')).toEqual({ value: 'AB-1234' });
    const bad = validateAnswer(p, 'AB-12345');
    expect(bad).toEqual({ ok: false, error: { code: 'pattern_mismatch', message: 'Use AB-1234' } });
  });

  it('every new type round-trips through the schema and displays readably', () => {
    const def = createDefinition();
    for (const type of ['matrix', 'ranking', 'slider', 'phone', 'file_upload', 'consent'] as const) def.pages[0]!.elements.push(createQuestion(type, type));
    expect(parseDefinition(JSON.parse(JSON.stringify(def))).ok).toBe(true);
    const ranking = q('ranking');
    expect(displayAnswer(ranking, ranking.options.map((o) => o.key).reverse())).toBe('1. Option 3; 2. Option 2; 3. Option 1');
    const matrix = q('matrix');
    expect(displayAnswer(matrix, { [matrix.rows[0]!.key]: matrix.options[2]!.key })).toBe('Row 1: Good');
  });
});

describe('validator: logic and piping', () => {
  it('accepts the vector definition', () => {
    expect(codes(vectorDef)).toEqual([]);
  });

  it('rejects references to later questions, dangling keys, backward jumps and mismatched operators', () => {
    const def = structuredClone(vectorDef);
    // A page-1 question conditioned on a page-3 answer.
    (def.pages[0]!.elements[0] as Question).visibleIf = { source: { question: 'q_vecwhy001' }, op: 'answered' };
    def.logic!.push({ id: 'r_back00001', afterPage: 'p_vecpage03', when: { source: { hidden: 'src' }, op: 'answered' }, then: { goTo: 'p_vecpage01' } });
    def.logic!.push({ id: 'r_bad000001', afterPage: 'p_vecpage01', when: { source: { question: 'q_vecuse001' }, op: 'gt', value: 3 }, then: { end: true } });
    def.logic!.push({ id: 'r_gone00001', afterPage: 'p_vecpage01', when: { source: { question: 'q_deleted01' }, op: 'answered' }, then: { end: true } });
    def.logic!.push({ id: 'r_opt000001', afterPage: 'p_vecpage01', when: { source: { question: 'q_vecage001' }, op: 'eq', value: 'o_deleted01' }, then: { end: true } });
    def.logic!.push({ id: 'r_hid000001', afterPage: 'p_vecpage01', when: { source: { hidden: 'undeclared' }, op: 'answered' }, then: { end: true } });
    expect(codes(def)).toEqual(
      expect.arrayContaining(['forward_reference', 'backward_jump', 'operator_type_mismatch', 'dangling_reference']),
    );
    const messages = validateDefinition(def).map((i) => i.message).join('\n');
    expect(messages).toContain('jumps back to page 1');
    expect(messages).toContain('which comes later');
    expect(messages).toContain('"undeclared"');
  });

  it('limits nesting to three levels and requires values', () => {
    const def = structuredClone(vectorDef);
    const leaf = { source: { hidden: 'src' }, op: 'eq' } as const;
    (def.pages[2]!.elements[0] as Question).visibleIf = { not: { any: [{ all: [{ not: leaf }] }] } };
    expect(codes(def)).toEqual(expect.arrayContaining(['condition_too_deep', 'missing_value']));
  });

  it('checks piping tokens', () => {
    const def = structuredClone(vectorDef);
    (def.pages[0]!.elements[0] as Question).title = 'Hi {{param.src}}, you said {{q.q_vecwhy001}} {{q.nope}} {{param.unknown}} {{oops}}';
    const issues = validateDefinition(def);
    expect(issues.filter((i) => i.code === 'forward_reference')).toHaveLength(1);
    expect(issues.filter((i) => i.code === 'dangling_reference')).toHaveLength(2);
    expect(issues.some((i) => i.code === 'malformed_token' && i.severity === 'warning')).toBe(true);
    expect(malformedTokens('{{oops}} {{q.q_abcdefgh}}')).toEqual(['{{oops}}']);
  });

  it('rejects unsafe regex patterns and non-http redirects', () => {
    expect(isSafePattern('[A-Z]{2}-\\d{4}')).toEqual({ ok: true });
    expect(isSafePattern('(a+)+$').ok).toBe(false);
    expect(isSafePattern('(\\w*)*').ok).toBe(false);
    expect(isSafePattern('(a)\\1').ok).toBe(false);
    expect(isSafePattern('(').ok).toBe(false);
    const def = structuredClone(vectorDef);
    def.settings.thankYou.redirectUrl = 'javascript:alert(1)';
    expect(codes(def)).toContain('invalid_url');
  });

  it('blocks file upload and phone questions in anonymous surveys', () => {
    const def = createDefinition();
    def.pages[0]!.elements.push(createQuestion('file_upload', 'CV'), createQuestion('phone', 'Phone'));
    expect(codes(def, { anonymous: true }).filter((c) => c === 'identifying_question_in_anonymous')).toHaveLength(2);
  });
});

describe('piping', () => {
  const ctx = {
    def: vectorDef,
    answers: { q_vecage001: 'o_vec18a001', q_vecuse001: ['o_vecweb001', 'o_vecapp001'], q_vecwhy001: '<img src=x onerror=alert(1)>' },
    hidden: { src: 'panel & co' },
  };

  it('inserts labels, hidden fields and fallbacks as plain text', () => {
    expect(pipe('You are {{q.q_vecage001}} and use {{q.q_vecuse001}} (via {{param.src}}). {{contact.first_name|Friend}}!', ctx)).toBe(
      'You are 18-34 and use Web, App (via panel & co). Friend!',
    );
    expect(pipe('{{q.q_vecapp001|no rating}}', ctx)).toBe('no rating');
    // Markup in an answer stays text: renderers insert it with textContent / React text nodes.
    expect(pipe('{{q.q_vecwhy001}}', ctx)).toBe('<img src=x onerror=alert(1)>');
  });

  it('builds redirect URLs with encoded values and appended hidden fields', () => {
    const def = structuredClone(vectorDef);
    def.settings.thankYou.redirectUrl = 'https://example.com/next?age={{q.q_vecage001}}';
    def.settings.thankYou.appendHiddenFields = true;
    expect(completionRedirect({ ...ctx, def })).toBe('https://example.com/next?age=18-34&src=panel+%26+co');
    def.settings.thankYou.redirectUrl = 'javascript:alert(1)';
    expect(completionRedirect({ ...ctx, def })).toBeNull();
  });
});

describe('fresh keys for templates and the question bank', () => {
  it('remaps every key and keeps logic, rules and piping working', () => {
    const def = structuredClone(vectorDef);
    (def.pages[2]!.elements[1] as Question).title = 'Why? You chose {{q.q_vecage001}}';
    const copy = remapDefinitionKeys(def);
    const oldKeys = new Set(JSON.stringify(def).match(/\b[a-z]_vec[A-Za-z0-9]+/g));
    const leftovers = (JSON.stringify(copy).match(/\b[a-z]_vec[A-Za-z0-9]+/g) ?? []).filter((k) => oldKeys.has(k));
    expect(leftovers).toEqual([]);
    expect(codes(copy)).toEqual([]);
    expect(parseDefinition(copy).ok).toBe(true);

    // The disqualify rule still fires on the remapped "Under 18" option.
    const [age] = listQuestions(copy);
    const under18 = (age as { options: { key: string; label: string }[] }).options.find((o) => o.label === 'Under 18')!;
    expect(checkCompletion(copy, { [age!.key]: under18.key }).outcome).toBe('disqualified');
  });

  it('bank questions get fresh keys and lose their conditions', () => {
    const original = vectorDef.pages[0]!.elements[2] as Question;
    const copy = bankQuestion(original);
    expect(copy.key).not.toBe(original.key);
    expect(copy.visibleIf).toBeUndefined();
  });
});

describe('theme contrast (WCAG AA)', () => {
  it('passes the default theme and reports failing pairs', () => {
    expect(checkThemeContrast(DEFAULT_THEME)).toEqual([]);
    expect(contrastRatio('#ffffff', '#000000')).toBe(21);
    const problems = checkThemeContrast({ ...DEFAULT_THEME, text: '#9a9a9a', primary: '#f5e663' });
    expect(problems.map((p) => p.pair)).toEqual(expect.arrayContaining(['text/background', 'text/surface', 'primary/surface']));
  });
});
