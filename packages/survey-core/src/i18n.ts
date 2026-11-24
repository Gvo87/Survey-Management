/**
 * Multi-language surveys (Phase 3B).
 *
 * A translation is a flat map from a text key to the translated string, stored per language next to the
 * definition (`survey_versions.translations`). Keys name a place in the definition, never a position, so
 * translations survive reordering:
 *
 *   survey.title                     the survey's title
 *   page.p_1.title / .description    a page
 *   q_7Hk2.title / .help / .body     a question or text block
 *   q_7Hk2.option.o_a / .row.r_1     an option or matrix row
 *   q_7Hk2.placeholder, .lowLabel …  labels in a question's settings
 *   thankYou.title / .body           end screens (and disqualified.*)
 *   ui.next, ui.back …               the respondent app's buttons and messages
 *
 * Logic and piping refer to keys, so they work the same in every language. Missing strings fall back to
 * the default language. Runtime code only: no Zod, so the respondent bundle can import it.
 */
import { parseTokens } from './piping';
import type { Element, Question, SurveyDefinition } from './schema';

/** Buttons and messages of the respondent app, in English. Each can be translated as `ui.<name>`. */
export const UI_STRINGS = {
  next: 'Next',
  back: 'Back',
  submit: 'Submit',
  submitting: 'Submitting…',
  required: 'required',
  requiredError: 'This question is required.',
  errorSummary: 'Please check these answers:',
  pageOf: 'Page {n} of {total}',
  selectPlaceholder: 'Select an option',
  language: 'Language',
  anonymousNote: "This survey is anonymous. Your answers aren't linked to you.",
} as const;
export type UiStringName = keyof typeof UI_STRINGS;
export type UiStrings = Record<UiStringName, string>;

/** Language codes: `fr`, `pt-BR`, `zh-Hant` style. */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;
export const MAX_LANGUAGES = 30;
export const MAX_TRANSLATION_LENGTH = 5000;

const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug', 'dv', 'ckb']);

/** Right-to-left scripts (Arabic, Hebrew, Persian, Urdu, …). */
export function textDirection(locale: string): 'ltr' | 'rtl' {
  return RTL_LANGUAGES.has(locale.split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr';
}

export interface TranslatableString {
  key: string;
  /** The text in the default language. */
  source: string;
  /** Where it appears, for translators ("Question 3 · option"). */
  context: string;
  /** Long text (rendered as a textarea in editors). */
  long?: boolean;
}

const CONFIG_LABELS = [
  'placeholder',
  'lowLabel',
  'highLabel',
  'minLabel',
  'maxLabel',
  'unit',
  'statement',
  'linkLabel',
  'patternMessage',
] as const;

/**
 * Every string a translator can translate, in the order a respondent meets them. Empty source strings are
 * left out (nothing to translate). UI strings come last.
 */
export function translatableStrings(def: SurveyDefinition, surveyTitle?: string): TranslatableString[] {
  const out: TranslatableString[] = [];
  const add = (key: string, source: string | undefined, context: string, long = false) => {
    if (source && source.trim()) out.push({ key, source, context, ...(long ? { long } : {}) });
  };
  add('survey.title', surveyTitle, 'Survey title');
  let number = 0;
  def.pages.forEach((page, p) => {
    add(`page.${page.key}.title`, page.title, `Page ${p + 1} · title`);
    add(`page.${page.key}.description`, page.description, `Page ${p + 1} · description`, true);
    for (const element of page.elements) {
      if (element.kind === 'text') {
        add(`${element.key}.body`, element.body, `Page ${p + 1} · text block`, true);
        continue;
      }
      number++;
      const where = `Question ${number}`;
      add(`${element.key}.title`, element.title, `${where} · title`);
      add(`${element.key}.help`, element.helpText, `${where} · help text`, true);
      if ('options' in element)
        for (const o of element.options) add(`${element.key}.option.${o.key}`, o.label, `${where} · ${element.type === 'matrix' ? 'column' : 'option'}`);
      if (element.type === 'matrix') for (const r of element.rows) add(`${element.key}.row.${r.key}`, r.label, `${where} · row`);
      const config = element.config as Record<string, unknown>;
      for (const name of CONFIG_LABELS)
        if (typeof config[name] === 'string') add(`${element.key}.${name}`, config[name] as string, `${where} · ${name}`, name === 'statement');
    }
  });
  const { thankYou, disqualified } = def.settings;
  add('thankYou.title', thankYou.title, 'Thank-you page · title');
  add('thankYou.body', thankYou.body, 'Thank-you page · text', true);
  add('disqualified.title', disqualified?.title, 'Screened-out page · title');
  add('disqualified.body', disqualified?.body, 'Screened-out page · text', true);
  for (const [name, source] of Object.entries(UI_STRINGS)) add(`ui.${name}`, source, 'Button or message');
  return out;
}

/** Keep only known keys with non-empty, length-limited text. */
export function cleanTranslation(def: SurveyDefinition, strings: Record<string, unknown>, surveyTitle?: string): Record<string, string> {
  const known = new Set(translatableStrings(def, surveyTitle).map((s) => s.key));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(strings))
    if (known.has(key) && typeof value === 'string' && value.trim()) out[key] = value.slice(0, MAX_TRANSLATION_LENGTH);
  return out;
}

export interface TranslationCheck {
  total: number;
  translated: number;
  /** Keys with no translation (the respondent sees the default language there). */
  missing: string[];
  /** Keys whose translation uses different piping tokens than the source ({{q.…}}, {{param.…}}). */
  tokenMismatches: string[];
}

const tokenSet = (text: string) =>
  parseTokens(text)
    .map((t) => `${t.namespace}.${t.key}`)
    .sort()
    .join('|');

export function checkTranslation(def: SurveyDefinition, strings: Record<string, string>, surveyTitle?: string): TranslationCheck {
  const all = translatableStrings(def, surveyTitle);
  const missing: string[] = [];
  const tokenMismatches: string[] = [];
  for (const s of all) {
    const t = strings[s.key];
    if (!t?.trim()) missing.push(s.key);
    else if (tokenSet(t) !== tokenSet(s.source)) tokenMismatches.push(s.key);
  }
  return { total: all.length, translated: all.length - missing.length, missing, tokenMismatches };
}

/** The definition with translated text in place (the default language where a string is missing). */
export function localizeDefinition(def: SurveyDefinition, strings: Record<string, string> | undefined): SurveyDefinition {
  if (!strings || Object.keys(strings).length === 0) return def;
  const t = (key: string, fallback: string) => (strings[key]?.trim() ? strings[key]! : fallback);
  const opt = (key: string, fallback: string | undefined) => (fallback === undefined ? undefined : t(key, fallback));
  const localizeQuestion = (q: Question): Question => {
    const config: Record<string, unknown> = { ...q.config };
    for (const name of CONFIG_LABELS) if (typeof config[name] === 'string') config[name] = t(`${q.key}.${name}`, config[name] as string);
    const out = { ...q, title: t(`${q.key}.title`, q.title), config } as Question & { options?: unknown; rows?: unknown };
    if (q.helpText !== undefined) out.helpText = t(`${q.key}.help`, q.helpText);
    if ('options' in q) out.options = q.options.map((o) => ({ ...o, label: t(`${q.key}.option.${o.key}`, o.label) }));
    if (q.type === 'matrix') out.rows = q.rows.map((r) => ({ ...r, label: t(`${q.key}.row.${r.key}`, r.label) }));
    return out as Question;
  };
  const localizeElement = (e: Element): Element => (e.kind === 'text' ? { ...e, body: t(`${e.key}.body`, e.body) } : localizeQuestion(e));
  const { thankYou, disqualified } = def.settings;
  return {
    ...def,
    pages: def.pages.map((p) => ({
      ...p,
      ...(p.title !== undefined ? { title: t(`page.${p.key}.title`, p.title) } : {}),
      ...(p.description !== undefined ? { description: t(`page.${p.key}.description`, p.description) } : {}),
      elements: p.elements.map(localizeElement),
    })),
    settings: {
      ...def.settings,
      thankYou: { ...thankYou, title: t('thankYou.title', thankYou.title), body: t('thankYou.body', thankYou.body) },
      ...(disqualified
        ? { disqualified: { title: opt('disqualified.title', disqualified.title)!, body: opt('disqualified.body', disqualified.body)! } }
        : {}),
    },
  };
}

/** The respondent app's strings in one language (English where untranslated). */
export function uiStrings(strings: Record<string, string> | undefined): UiStrings {
  const out = { ...UI_STRINGS } as UiStrings;
  if (strings) for (const name of Object.keys(UI_STRINGS) as UiStringName[]) if (strings[`ui.${name}`]?.trim()) out[name] = strings[`ui.${name}`]!;
  return out;
}

/** Fill `{name}` placeholders ("Page {n} of {total}"). */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

/**
 * Pick the language to serve: an explicit choice (`?lang=`) if the survey has it, then the browser's
 * preferences (`Accept-Language`, best quality first, `pt-BR` also matching `pt`), else the default.
 */
export function negotiateLocale(available: string[], defaultLocale: string, requested: string | null | undefined, acceptLanguage: string | null | undefined): string {
  const lower = new Map(available.map((l) => [l.toLowerCase(), l]));
  const match = (tag: string): string | null => {
    const t = tag.trim().toLowerCase();
    if (!t || t === '*') return null;
    if (lower.has(t)) return lower.get(t)!;
    const base = t.split('-')[0]!;
    if (lower.has(base)) return lower.get(base)!;
    return available.find((l) => l.toLowerCase().split('-')[0] === base) ?? null;
  };
  if (requested) {
    const found = match(requested);
    if (found) return found;
  }
  if (acceptLanguage) {
    const ranked = acceptLanguage
      .split(',')
      .slice(0, 20)
      .map((part, i) => {
        const [tag, ...params] = part.split(';');
        const q = Number(params.find((p) => p.trim().startsWith('q='))?.trim().slice(2) ?? '1');
        return { tag: tag ?? '', q: Number.isFinite(q) ? q : 0, i };
      })
      .filter((x) => x.q > 0)
      .sort((a, b) => b.q - a.q || a.i - b.i);
    for (const { tag } of ranked) {
      const found = match(tag);
      if (found) return found;
    }
  }
  return defaultLocale;
}
