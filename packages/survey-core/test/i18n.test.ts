import { describe, expect, it } from 'vitest';
import {
  checkTranslation,
  cleanTranslation,
  format,
  localizeDefinition,
  negotiateLocale,
  nextStep,
  pipe,
  textDirection,
  translatableStrings,
  uiStrings,
  UI_STRINGS,
} from '../src/index';
import type { SurveyDefinition } from '../src/schema';
import { SurveyDefinitionSchema } from '../src/schema';
import { allTypesSurvey } from './fixtures';

/** Two pages: a choice question piped into page 2's title, and a rule that skips page 2 for "No". */
function bilingual(): SurveyDefinition {
  return {
    schemaVersion: 1,
    defaultLocale: 'en',
    hiddenFields: [{ key: 'source' }],
    settings: { showProgressBar: true, allowBack: true, thankYou: { title: 'Thanks {{q.q_like0001}}', body: 'Done' } },
    logic: [{ id: 'r_skip0001', afterPage: 'p_one00001', when: { source: { question: 'q_like0001' }, op: 'eq', value: 'o_no000001' }, then: { end: true } }],
    pages: [
      {
        key: 'p_one00001',
        title: 'Start',
        elements: [
          {
            kind: 'question',
            key: 'q_like0001',
            type: 'single_choice',
            title: 'Do you like it?',
            helpText: 'Pick one',
            required: true,
            options: [
              { key: 'o_yes00001', label: 'Yes' },
              { key: 'o_no000001', label: 'No' },
            ],
            config: { randomize: false },
          },
        ],
      },
      {
        key: 'p_two00001',
        title: 'You said {{q.q_like0001}} ({{param.source|direct}})',
        elements: [{ kind: 'question', key: 'q_why00001', type: 'long_text', title: 'Why?', required: false, config: { maxLength: 500, placeholder: 'Tell us' } }],
      },
    ],
  };
}

const french: Record<string, string> = {
  'survey.title': 'Enquête',
  'page.p_one00001.title': 'Début',
  'q_like0001.title': "Vous l'aimez ?",
  'q_like0001.option.o_yes00001': 'Oui',
  'q_like0001.option.o_no000001': 'Non',
  'page.p_two00001.title': 'Vous avez dit {{q.q_like0001}} ({{param.source|direct}})',
  'q_why00001.title': 'Pourquoi ?',
  'thankYou.title': 'Merci {{q.q_like0001}}',
  'ui.next': 'Suivant',
};

describe('translatable strings', () => {
  it('names every text in the definition by key, with context', () => {
    const keys = translatableStrings(bilingual(), 'Survey').map((s) => s.key);
    expect(keys).toEqual([
      'survey.title',
      'page.p_one00001.title',
      'q_like0001.title',
      'q_like0001.help',
      'q_like0001.option.o_yes00001',
      'q_like0001.option.o_no000001',
      'page.p_two00001.title',
      'q_why00001.title',
      'q_why00001.placeholder',
      'thankYou.title',
      'thankYou.body',
      ...Object.keys(UI_STRINGS).map((k) => `ui.${k}`),
    ]);
    const help = translatableStrings(bilingual()).find((s) => s.key === 'q_like0001.help')!;
    expect(help).toMatchObject({ source: 'Pick one', context: 'Question 1 · help text', long: true });
  });

  it('covers matrix rows and columns, text blocks and settings labels', () => {
    const keys = translatableStrings(allTypesSurvey()).map((s) => s.key);
    expect(keys).toContain('t_intro001.body');
    expect(keys.some((k) => /\.option\./.test(k))).toBe(true);
    for (const k of keys) expect(k).toMatch(/^(survey|page|thankYou|disqualified|ui|[a-z]_[A-Za-z0-9]+)\./);
  });

  it('cleanTranslation drops unknown keys and blank strings', () => {
    expect(cleanTranslation(bilingual(), { 'q_like0001.title': 'X', 'q_nope.title': 'Y', 'q_why00001.title': '  ', other: 3 })).toEqual({
      'q_like0001.title': 'X',
    });
  });
});

describe('checking a translation', () => {
  it('lists missing strings and piping tokens that differ from the source', () => {
    const check = checkTranslation(bilingual(), { ...french, 'q_why00001.title': 'Pourquoi {{q.q_like0001}} ?' }, 'Survey');
    expect(check.missing).toContain('q_like0001.help');
    expect(check.missing).toContain('ui.back');
    expect(check.missing).not.toContain('q_like0001.title');
    expect(check.tokenMismatches).toEqual(['q_why00001.title']);
    expect(check.translated + check.missing.length).toBe(check.total);
  });
});

describe('localizing a definition', () => {
  const fr = localizeDefinition(bilingual(), french);

  it('replaces text and falls back to the default language where a string is missing', () => {
    const q = fr.pages[0]!.elements[0]!;
    expect(q.kind === 'question' && q.title).toBe("Vous l'aimez ?");
    expect(q.kind === 'question' && q.helpText).toBe('Pick one');
    expect(q.kind === 'question' && 'options' in q && q.options.map((o) => o.label)).toEqual(['Oui', 'Non']);
    expect(fr.pages[1]!.elements[0]!.kind === 'question' && (fr.pages[1]!.elements[0] as { config: { placeholder?: string } }).config.placeholder).toBe('Tell us');
  });

  it('is still a valid definition with the same keys and structure', () => {
    expect(SurveyDefinitionSchema.safeParse(fr).success).toBe(true);
    const keysOf = (d: SurveyDefinition) => JSON.stringify(d.pages.map((p) => [p.key, p.elements.map((e) => e.key)]));
    expect(keysOf(fr)).toBe(keysOf(bilingual()));
    expect(fr.logic).toEqual(bilingual().logic);
  });

  it('logic behaves the same in every language', () => {
    for (const def of [bilingual(), fr]) {
      expect(nextStep(def, 'p_one00001', { answers: { q_like0001: 'o_no000001' } })).toEqual({ kind: 'end' });
      expect(nextStep(def, 'p_one00001', { answers: { q_like0001: 'o_yes00001' } })).toEqual({ kind: 'page', pageKey: 'p_two00001' });
    }
  });

  it('piping shows the answer as the respondent saw it, in their language', () => {
    const ctx = { answers: { q_like0001: 'o_yes00001' }, hidden: { source: 'mail' } };
    expect(pipe(fr.pages[1]!.title!, { def: fr, ...ctx })).toBe('Vous avez dit Oui (mail)');
    expect(pipe(bilingual().pages[1]!.title!, { def: bilingual(), ...ctx })).toBe('You said Yes (mail)');
    expect(pipe(fr.settings.thankYou.title, { def: fr, ...ctx })).toBe('Merci Oui');
  });

  it('returns the definition unchanged without strings', () => {
    const def = bilingual();
    expect(localizeDefinition(def, undefined)).toBe(def);
    expect(localizeDefinition(def, {})).toBe(def);
  });
});

describe('UI strings', () => {
  it('uses translations where present and English elsewhere', () => {
    const ui = uiStrings(french);
    expect(ui.next).toBe('Suivant');
    expect(ui.back).toBe('Back');
    expect(format(ui.pageOf, { n: 2, total: 5 })).toBe('Page 2 of 5');
  });
});

describe('choosing the language', () => {
  const available = ['en', 'fr', 'pt-BR', 'ar'];
  it('prefers an explicit choice the survey offers', () => {
    expect(negotiateLocale(available, 'en', 'fr', 'ar')).toBe('fr');
    expect(negotiateLocale(available, 'en', 'FR', null)).toBe('fr');
    expect(negotiateLocale(available, 'en', 'de', 'ar')).toBe('ar');
  });
  it('detects from Accept-Language by quality, matching base languages', () => {
    expect(negotiateLocale(available, 'en', null, 'de-DE,de;q=0.9,fr;q=0.8,en;q=0.7')).toBe('fr');
    expect(negotiateLocale(available, 'en', null, 'pt-PT;q=0.9,en;q=0.5')).toBe('pt-BR');
    expect(negotiateLocale(available, 'en', null, 'fr-CA')).toBe('fr');
    expect(negotiateLocale(available, 'en', null, 'ja,zh;q=0.5')).toBe('en');
    expect(negotiateLocale(available, 'en', null, 'fr;q=0,ar;q=0.1')).toBe('ar');
    expect(negotiateLocale(available, 'en', null, '')).toBe('en');
  });
  it('knows right-to-left scripts', () => {
    expect(textDirection('ar')).toBe('rtl');
    expect(textDirection('he-IL')).toBe('rtl');
    expect(textDirection('fa')).toBe('rtl');
    expect(textDirection('fr')).toBe('ltr');
  });
});
