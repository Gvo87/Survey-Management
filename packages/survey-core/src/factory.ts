import type { QuestionType } from './constants';
import type { ChoiceOption, Element, Page, Question, SurveyDefinition, TextBlock } from './schema';

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

/** Stable key for pages (p), questions (q), options (o) and text blocks (t). Never reused. */
export function newKey(prefix: 'p' | 'q' | 'o' | 't'): string {
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
      return {
        ...base,
        type,
        options: [createOption('Option 1'), createOption('Option 2')],
        config: { randomize: false },
      };
    case 'multi_choice':
      return {
        ...base,
        type,
        options: [createOption('Option 1'), createOption('Option 2'), createOption('Option 3')],
        config: { randomize: false },
      };
    case 'dropdown':
      return {
        ...base,
        type,
        options: [createOption('Option 1'), createOption('Option 2')],
        config: { randomize: false },
      };
    case 'short_text':
      return { ...base, type, config: { maxLength: 255 } };
    case 'long_text':
      return { ...base, type, config: { maxLength: 5000 } };
    case 'rating':
      return { ...base, type, config: { scale: 5, icon: 'star' } };
    case 'nps':
      return { ...base, type, config: { lowLabel: 'Not at all likely', highLabel: 'Extremely likely' } };
    case 'likert':
      return {
        ...base,
        type,
        options: LIKERT_DEFAULT_LABELS.map((label, i) => createOption(label, { value: i + 1 })),
        config: {},
      };
    case 'email':
      return { ...base, type, config: {} };
    case 'date':
      return { ...base, type, config: {} };
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

/** Copy an element with fresh keys (for "duplicate question"). */
export function cloneElement(element: Element): Element {
  if (element.kind === 'text') return { ...element, key: newKey('t') };
  const copy = structuredClone(element);
  copy.key = newKey('q');
  if ('options' in copy) copy.options = copy.options.map((o) => ({ ...o, key: newKey('o') }));
  return copy;
}
