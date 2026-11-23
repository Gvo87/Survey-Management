import { describe, expect, it } from 'vitest';
import { createDefinition, createQuestion, hasErrors, validateDefinition } from '../src';
import type { SurveyDefinition } from '../src';
import { allTypesSurvey } from './fixtures';

const codes = (def: SurveyDefinition, ctx = {}) =>
  validateDefinition(def, ctx).map((i) => `${i.severity}:${i.code}`);

describe('validateDefinition', () => {
  it('accepts the all-types fixture without errors', () => {
    const issues = validateDefinition(allTypesSurvey());
    expect(hasErrors(issues)).toBe(false);
  });

  it('requires at least one question', () => {
    expect(codes(createDefinition())).toContain('error:no_questions');
  });

  it('flags empty pages as warnings only', () => {
    const def = allTypesSurvey();
    def.pages.push({ key: 'p_empty001', elements: [] });
    expect(codes(def)).toEqual(['warning:empty_page']);
  });

  it('requires titles', () => {
    const def = createDefinition();
    def.pages[0]!.elements.push(createQuestion('short_text', '  '));
    expect(codes(def)).toContain('error:title_required');
  });

  it('detects duplicate keys across pages and elements', () => {
    const def = allTypesSurvey();
    const copy = structuredClone(def.pages[1]!.elements[0]!);
    def.pages[0]!.elements.push(copy);
    expect(codes(def)).toContain('error:duplicate_key');
  });

  it('checks choice options', () => {
    const def = createDefinition();
    const q = createQuestion('single_choice', 'Pick');
    if (!('options' in q)) throw new Error();
    q.options = [{ key: 'o_only0001', label: '' }];
    def.pages[0]!.elements.push(q);
    expect(codes(def)).toEqual(
      expect.arrayContaining(['error:too_few_options', 'error:option_label_required']),
    );
  });

  it('warns on duplicate option labels', () => {
    const def = createDefinition();
    const q = createQuestion('single_choice', 'Pick');
    if (!('options' in q)) throw new Error();
    q.options = [
      { key: 'o_aaaaaaa1', label: 'Yes' },
      { key: 'o_aaaaaaa2', label: 'yes ' },
    ];
    def.pages[0]!.elements.push(q);
    expect(codes(def)).toEqual(['warning:duplicate_option_label']);
  });

  it('rejects Other on types that do not support it, and more than one Other', () => {
    const def = createDefinition();
    const dropdown = createQuestion('dropdown', 'Pick');
    const single = createQuestion('single_choice', 'Pick');
    if (!('options' in dropdown) || !('options' in single)) throw new Error();
    dropdown.options[0]!.isOther = true;
    single.options.forEach((o) => (o.isOther = true));
    def.pages[0]!.elements.push(dropdown, single);
    expect(codes(def)).toEqual(expect.arrayContaining(['error:other_not_supported', 'error:multiple_other']));
  });

  it('checks multi-choice selection limits', () => {
    const def = createDefinition();
    const q = createQuestion('multi_choice', 'Pick');
    if (q.type !== 'multi_choice') throw new Error();
    q.config = { randomize: false, minSelections: 3, maxSelections: 2 };
    def.pages[0]!.elements.push(q);
    expect(codes(def)).toContain('error:min_exceeds_max');
    q.config = { randomize: false, maxSelections: 9 };
    expect(codes(def)).toContain('error:max_exceeds_options');
  });

  it('checks text length and date ranges', () => {
    const def = createDefinition();
    const text = createQuestion('short_text', 'Name');
    const date = createQuestion('date', 'When');
    if (text.type !== 'short_text' || date.type !== 'date') throw new Error();
    text.config = { minLength: 20, maxLength: 10 };
    date.config = { minDate: '2026-12-01', maxDate: '2026-01-01' };
    def.pages[0]!.elements.push(text, date);
    expect(codes(def).filter((c) => c === 'error:min_exceeds_max')).toHaveLength(2);
  });

  it('blocks identifying questions in anonymous surveys and warns about hidden fields', () => {
    const def = allTypesSurvey();
    def.hiddenFields.push({ key: 'customer_id' });
    const result = codes(def, { anonymous: true });
    expect(result).toContain('error:identifying_question_in_anonymous');
    expect(result).toContain('warning:hidden_field_dropped_when_anonymous');
  });

  it('rejects reserved and duplicate hidden fields', () => {
    const def = allTypesSurvey();
    def.hiddenFields.push({ key: 'source' }, { key: 'test' });
    expect(codes(def)).toEqual(
      expect.arrayContaining(['error:duplicate_hidden_field', 'error:reserved_hidden_field']),
    );
  });

  it('forbids changing a published question type under the same key', () => {
    const published = allTypesSurvey();
    const draft = allTypesSurvey();
    const changed = {
      ...draft.pages[0]!.elements[4]!,
      type: 'long_text',
    } as (typeof draft.pages)[0]['elements'][0];
    draft.pages[0]!.elements[4] = changed;
    expect(codes(draft, { previousVersions: [published] })).toContain('error:question_type_changed');
    expect(codes(allTypesSurvey(), { previousVersions: [published] })).not.toContain(
      'error:question_type_changed',
    );
  });
});
