import type { QuestionType } from './constants';
import type { ChoiceOption, Element, Page, Question, SurveyDefinition, TextBlock } from './schema';
import type { Condition } from './types';
import { PIPE_TOKEN } from './piping';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Random base62 string using the platform CSPRNG (browser and Node). */
export function randomId(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  // 248 = largest multiple of 62 below 256, to avoid modulo bias.
  for (let i = 0; i < length; i++) {
    let b = bytes[i]!;
    while (b >= 248) {
      const extra = new Uint8Array(1);
      globalThis.crypto.getRandomValues(extra);
      b = extra[0]!;
    }
    out += ALPHABET[b % 62];
  }
  return out;
}

/** Stable key for pages (p), questions (q), options (o), text blocks (t) and rules (r). Never reused. */
export function newKey(prefix: 'p' | 'q' | 'o' | 't' | 'r'): string {
  return `${prefix}_${randomId(8)}`;
}

export function createOption(label: string, extra: Partial<ChoiceOption> = {}): ChoiceOption {
  return { key: newKey('o'), label, ...extra };
}

export const LIKERT_DEFAULT_LABELS = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];

export function createQuestion(type: QuestionType, title = ''): Question {
  const base = { kind: 'question' as const, key: newKey('q'), title, required: false };
  switch (type) {
    case 'single_choice':
      return { ...base, type, options: [createOption('Option 1'), createOption('Option 2')], config: { randomize: false } };
    case 'multi_choice':
      return {
        ...base,
        type,
        options: [createOption('Option 1'), createOption('Option 2'), createOption('Option 3')],
        config: { randomize: false },
      };
    case 'dropdown':
      return { ...base, type, options: [createOption('Option 1'), createOption('Option 2')], config: { randomize: false } };
    case 'likert':
      return { ...base, type, options: LIKERT_DEFAULT_LABELS.map((label, i) => createOption(label, { value: i + 1 })), config: {} };
    case 'matrix':
      return {
        ...base,
        type,
        rows: [createOption('Row 1'), createOption('Row 2')],
        options: ['Poor', 'Fair', 'Good', 'Excellent'].map((label, i) => createOption(label, { value: i + 1 })),
        config: { multiplePerRow: false, randomizeRows: false },
      };
    case 'ranking':
      return { ...base, type, options: [createOption('Option 1'), createOption('Option 2'), createOption('Option 3')], config: { randomize: false } };
    case 'short_text':
      return { ...base, type, config: { maxLength: 255 } };
    case 'long_text':
      return { ...base, type, config: { maxLength: 5000 } };
    case 'rating':
      return { ...base, type, config: { scale: 5, icon: 'star' } };
    case 'nps':
      return { ...base, type, config: { lowLabel: 'Not at all likely', highLabel: 'Extremely likely' } };
    case 'slider':
      return { ...base, type, config: { min: 0, max: 100, step: 1 } };
    case 'email':
      return { ...base, type, config: {} };
    case 'phone':
      return { ...base, type, config: {} };
    case 'date':
      return { ...base, type, config: { mode: 'date' } };
    case 'file_upload':
      return { ...base, type, config: { maxFiles: 1, maxSizeMb: 10, allowedTypes: ['image', 'pdf'] } };
    case 'consent':
      return { ...base, required: true, type, config: { statement: 'I agree to the processing of my answers as described in the privacy notice.' } };
  }
}

export function createTextBlock(body = ''): TextBlock {
  return { kind: 'text', key: newKey('t'), body };
}

export function createPage(title?: string): Page {
  return { key: newKey('p'), ...(title ? { title } : {}), elements: [] };
}

export function createDefinition(): SurveyDefinition {
  return {
    schemaVersion: 1,
    defaultLocale: 'en',
    pages: [createPage()],
    hiddenFields: [],
    settings: {
      showProgressBar: true,
      allowBack: true,
      thankYou: { title: 'Thank you!', body: 'Your response has been recorded.' },
    },
  };
}

/** Copy an element with fresh keys (for "duplicate question"). Its own condition is kept. */
export function cloneElement(element: Element): Element {
  if (element.kind === 'text') return { ...structuredClone(element), key: newKey('t') };
  const copy = structuredClone(element);
  copy.key = newKey('q');
  if ('options' in copy) copy.options = copy.options.map((o) => ({ ...o, key: newKey('o') }));
  if (copy.type === 'matrix') copy.rows = copy.rows.map((r) => ({ ...r, key: newKey('o') }));
  return copy;
}

/** A question as stored in (and inserted from) the question bank: fresh keys, no conditions. */
export function bankQuestion(question: Question): Question {
  const copy = cloneElement(question) as Question;
  delete copy.visibleIf;
  return copy;
}

/**
 * Give every page, element, option, row and rule a fresh key, and rewrite every reference to them
 * (conditions, rules, piping tokens). Used when creating a survey from a template, so two surveys
 * never share keys.
 */
export function remapDefinitionKeys(def: SurveyDefinition): SurveyDefinition {
  const map = new Map<string, string>();
  const fresh = (key: string, prefix: 'p' | 'q' | 'o' | 't' | 'r') => {
    if (!map.has(key)) map.set(key, newKey(prefix));
    return map.get(key)!;
  };
  // First pass: allocate keys.
  for (const page of def.pages) {
    fresh(page.key, 'p');
    for (const element of page.elements) {
      fresh(element.key, element.kind === 'text' ? 't' : 'q');
      if (element.kind === 'question') {
        if ('options' in element) for (const o of element.options) fresh(o.key, 'o');
        if (element.type === 'matrix') for (const r of element.rows) fresh(r.key, 'o');
      }
    }
  }
  for (const rule of def.logic ?? []) fresh(rule.id, 'r');

  const k = (key: string) => map.get(key) ?? key;
  const text = (s: string | undefined) =>
    s === undefined ? undefined : s.replace(PIPE_TOKEN, (raw, ns: string, key: string) => (ns === 'q' && map.has(key) ? raw.replace(key, k(key)) : raw));
  const cond = (c: Condition): Condition => {
    if ('all' in c) return { all: c.all.map(cond) };
    if ('any' in c) return { any: c.any.map(cond) };
    if ('not' in c) return { not: cond(c.not) };
    const source = 'question' in c.source ? { question: k(c.source.question), ...(c.source.sub ? { sub: k(c.source.sub) } : {}) } : c.source;
    const value = Array.isArray(c.value) ? c.value.map((v) => (typeof v === 'string' ? k(v) : v)) : typeof c.value === 'string' ? k(c.value) : c.value;
    return { ...c, source, ...(c.value !== undefined ? { value } : {}) };
  };
  const options = (list: ChoiceOption[]) => list.map((o) => ({ ...o, key: k(o.key) }));
  const clean = <T extends object>(o: T) => JSON.parse(JSON.stringify(o)) as T; // drops undefined

  const copy = structuredClone(def);
  return clean({
    ...copy,
    pages: copy.pages.map((page) => ({
      ...page,
      key: k(page.key),
      title: text(page.title),
      description: text(page.description),
      ...(page.visibleIf ? { visibleIf: cond(page.visibleIf) } : {}),
      elements: page.elements.map((e) => {
        const base = { ...e, key: k(e.key), ...(e.visibleIf ? { visibleIf: cond(e.visibleIf) } : {}) };
        if (base.kind === 'text') return { ...base, body: text(base.body)! };
        const q = { ...base, title: text(base.title)!, helpText: text(base.helpText) } as Question;
        if ('options' in q) (q as { options: ChoiceOption[] }).options = options(q.options);
        if (q.type === 'matrix') q.rows = options(q.rows);
        return q;
      }),
    })),
    ...(copy.logic
      ? {
          logic: copy.logic.map((rule) => ({
            ...rule,
            id: k(rule.id),
            afterPage: k(rule.afterPage),
            when: cond(rule.when),
            then: 'goTo' in rule.then ? { goTo: k(rule.then.goTo) } : rule.then,
          })),
        }
      : {}),
    settings: {
      ...copy.settings,
      thankYou: {
        ...copy.settings.thankYou,
        title: text(copy.settings.thankYou.title)!,
        body: text(copy.settings.thankYou.body)!,
        redirectUrl: text(copy.settings.thankYou.redirectUrl),
      },
    },
  });
}
