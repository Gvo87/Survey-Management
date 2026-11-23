import type { SurveyDefinition } from '../src/schema';

/** A two-page survey exercising every Phase 1 question type, with fixed keys for readable tests. */
export function allTypesSurvey(): SurveyDefinition {
  return {
    schemaVersion: 1,
    defaultLocale: 'en',
    hiddenFields: [{ key: 'source', nonIdentifying: true }],
    settings: { showProgressBar: true, allowBack: true, thankYou: { title: 'Thanks', body: 'Done' } },
    pages: [
      {
        key: 'p_page0001',
        title: 'About you',
        elements: [
          { kind: 'text', key: 't_intro001', body: 'Welcome' },
          {
            kind: 'question',
            key: 'q_single01',
            type: 'single_choice',
            title: 'Favourite colour?',
            required: true,
            options: [
              { key: 'o_red00001', label: 'Red' },
              { key: 'o_blue0001', label: 'Blue' },
              { key: 'o_other001', label: 'Other', isOther: true },
            ],
            config: { randomize: false },
          },
          {
            kind: 'question',
            key: 'q_multi001',
            type: 'multi_choice',
            title: 'Which apply?',
            required: false,
            options: [
              { key: 'o_a0000001', label: 'A' },
              { key: 'o_b0000001', label: 'B' },
              { key: 'o_c0000001', label: 'C' },
              { key: 'o_none0001', label: 'None of these', exclusive: true },
              { key: 'o_moth0001', label: 'Other', isOther: true },
            ],
            config: { randomize: false, minSelections: 2, maxSelections: 3 },
          },
          {
            kind: 'question',
            key: 'q_drop0001',
            type: 'dropdown',
            title: 'Country',
            required: false,
            options: [
              { key: 'o_fr000001', label: 'France' },
              { key: 'o_de000001', label: 'Germany' },
            ],
            config: { randomize: false },
          },
          {
            kind: 'question',
            key: 'q_short001',
            type: 'short_text',
            title: 'Name',
            required: false,
            config: { minLength: 2, maxLength: 10 },
          },
        ],
      },
      {
        key: 'p_page0002',
        elements: [
          {
            kind: 'question',
            key: 'q_long0001',
            type: 'long_text',
            title: 'Comments',
            required: false,
            config: { maxLength: 100 },
          },
          {
            kind: 'question',
            key: 'q_rate0001',
            type: 'rating',
            title: 'Rate us',
            required: true,
            config: { scale: 5, icon: 'star' },
          },
          {
            kind: 'question',
            key: 'q_nps00001',
            type: 'nps',
            title: 'Recommend?',
            required: false,
            config: { lowLabel: 'No', highLabel: 'Yes' },
          },
          {
            kind: 'question',
            key: 'q_like0001',
            type: 'likert',
            title: 'It was easy',
            required: false,
            options: [
              { key: 'o_l1000001', label: 'Disagree', value: 1 },
              { key: 'o_l2000001', label: 'Neutral', value: 2 },
              { key: 'o_l3000001', label: 'Agree', value: 3 },
            ],
            config: {},
          },
          { kind: 'question', key: 'q_mail0001', type: 'email', title: 'Email', required: false, config: {} },
          {
            kind: 'question',
            key: 'q_date0001',
            type: 'date',
            title: 'Visit date',
            required: false,
            config: { minDate: '2026-01-01', maxDate: '2026-12-31' },
          },
        ],
      },
    ],
  };
}
