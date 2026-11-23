import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseDefinition } from '../src/schema';
import {
  cloneElement,
  createDefinition,
  createQuestion,
  createTextBlock,
  displayAnswer,
  newKey,
  orderOptions,
  QUESTION_TYPES,
  KEY_PATTERN,
} from '../src';
import { allTypesSurvey } from './fixtures';

describe('schema', () => {
  it('accepts the fixture', () => {
    expect(parseDefinition(allTypesSurvey()).ok).toBe(true);
  });

  it('accepts a definition built from every factory question type', () => {
    const def = createDefinition();
    for (const type of QUESTION_TYPES) def.pages[0]!.elements.push(createQuestion(type, type));
    def.pages[0]!.elements.push(createTextBlock('Hello'));
    const result = parseDefinition(JSON.parse(JSON.stringify(def)));
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects unknown fields (strict objects), bad keys and wrong types with paths', () => {
    const def = allTypesSurvey() as unknown as Record<string, unknown>;
    (def as { extra?: number }).extra = 1;
    const result = parseDefinition(def);
    expect(result.ok).toBe(false);

    const badKey = allTypesSurvey();
    badKey.pages[0]!.key = 'not a key';
    const r2 = parseDefinition(badKey);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues[0]!.path).toBe('pages[0].key');

    const badRating = allTypesSurvey();
    (badRating.pages[1]!.elements[1] as { config: { scale: number } }).config.scale = 50;
    expect(parseDefinition(badRating).ok).toBe(false);
  });

  it('rejects definitions with no pages', () => {
    const def = createDefinition();
    def.pages = [];
    expect(parseDefinition(def).ok).toBe(false);
  });
});

describe('keys', () => {
  it('generates keys matching the key pattern', () => {
    for (const prefix of ['p', 'q', 'o', 't'] as const) expect(newKey(prefix)).toMatch(KEY_PATTERN);
  });

  it('cloneElement gives the question and its options fresh keys', () => {
    const q = createQuestion('single_choice', 'Pick');
    const copy = cloneElement(q);
    expect(copy.key).not.toBe(q.key);
    if (!('options' in copy) || !('options' in q)) throw new Error();
    expect(copy.options.map((o) => o.key)).not.toEqual(q.options.map((o) => o.key));
    expect(copy.options.map((o) => o.label)).toEqual(q.options.map((o) => o.label));
  });
});

describe('orderOptions', () => {
  const options = [
    { key: 'o_1aaaaaaa', label: '1' },
    { key: 'o_2aaaaaaa', label: '2' },
    { key: 'o_3aaaaaaa', label: '3' },
    { key: 'o_4aaaaaaa', label: '4' },
    { key: 'o_other000', label: 'Other', isOther: true },
    { key: 'o_none0000', label: 'None', exclusive: true },
  ];

  it('returns the original order when not randomized', () => {
    expect(orderOptions(options, false, 'seed')).toBe(options);
  });

  it('is a stable permutation that keeps Other and exclusive options last', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const a = orderOptions(options, true, seed);
        const b = orderOptions(options, true, seed);
        expect(a).toEqual(b);
        expect([...a].map((o) => o.key).sort()).toEqual(options.map((o) => o.key).sort());
        expect(a.slice(-2).map((o) => o.key)).toEqual(['o_other000', 'o_none0000']);
      }),
    );
  });

  it('produces different orders for different seeds', () => {
    const orders = new Set(
      Array.from({ length: 20 }, (_, i) =>
        orderOptions(options, true, `s${i}`)
          .map((o) => o.key)
          .join(),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('displayAnswer', () => {
  const def = allTypesSurvey();
  const single = def.pages[0]!.elements[1]!;
  const multi = def.pages[0]!.elements[2]!;
  if (single.kind !== 'question' || multi.kind !== 'question') throw new Error();

  it('uses labels and includes Other text', () => {
    expect(displayAnswer(single, 'o_red00001')).toBe('Red');
    expect(displayAnswer(single, { option: 'o_other001', other: 'Teal' })).toBe('Other: Teal');
    expect(displayAnswer(multi, ['o_a0000001', 'o_b0000001'])).toBe('A; B');
    expect(displayAnswer(single, null)).toBe('');
  });
});
