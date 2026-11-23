/**
 * Semantic validation of a structurally valid definition.
 *
 * On every draft save these issues are returned to the builder; on publish, any issue with
 * severity "error" blocks publishing.
 */
import { QUESTION_TYPE_META, LIMITS, RESERVED_HIDDEN_FIELDS } from './constants';
import type { SurveyDefinition } from './schema';
import { isValidIsoDate } from './answers';
import { listQuestions } from './engine';

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** JSON-ish path into the definition, e.g. `pages[0].elements[2].options`. */
  path: string;
  pageKey?: string;
  elementKey?: string;
}

export interface ValidationContext {
  /** The survey is anonymous: identifying question types are not allowed. */
  anonymous?: boolean;
  /** Earlier published versions: a question key must keep its type forever. */
  previousVersions?: SurveyDefinition[];
}

export function validateDefinition(def: SurveyDefinition, ctx: ValidationContext = {}): Issue[] {
  const issues: Issue[] = [];
  const seenKeys = new Map<string, string>();
  const error = (code: string, message: string, path: string, extra: Partial<Issue> = {}) =>
    issues.push({ severity: 'error', code, message, path, ...extra });
  const warn = (code: string, message: string, path: string, extra: Partial<Issue> = {}) =>
    issues.push({ severity: 'warning', code, message, path, ...extra });
  const claimKey = (key: string, path: string, extra: Partial<Issue>) => {
    const existing = seenKeys.get(key);
    if (existing) error('duplicate_key', `Key "${key}" is used more than once.`, path, extra);
    else seenKeys.set(key, path);
  };

  const previousTypes = new Map<string, string>();
  for (const prev of ctx.previousVersions ?? []) {
    for (const q of listQuestions(prev)) previousTypes.set(q.key, q.type);
  }

  let questionCount = 0;

  def.pages.forEach((page, pi) => {
    const pagePath = `pages[${pi}]`;
    claimKey(page.key, pagePath, { pageKey: page.key });
    if (page.elements.length === 0)
      warn('empty_page', `Page ${pi + 1} has no content.`, pagePath, { pageKey: page.key });

    page.elements.forEach((element, ei) => {
      const path = `${pagePath}.elements[${ei}]`;
      const at = { pageKey: page.key, elementKey: element.key };
      claimKey(element.key, path, at);

      if (element.kind === 'text') {
        if (!element.body.trim()) warn('empty_text_block', 'This text block is empty.', path, at);
        return;
      }

      questionCount++;
      const q = element;
      const meta = QUESTION_TYPE_META[q.type];
      if (!q.title.trim()) error('title_required', 'Every question needs a title.', `${path}.title`, at);

      const previousType = previousTypes.get(q.key);
      if (previousType && previousType !== q.type)
        error(
          'question_type_changed',
          'This question changed type since it was published. Delete it and add a new question instead.',
          path,
          at,
        );

      if (ctx.anonymous && meta.identifying)
        error(
          'identifying_question_in_anonymous',
          `${meta.label} questions can't be used in an anonymous survey.`,
          path,
          at,
        );

      if ('options' in q) {
        const optPath = `${path}.options`;
        if (q.options.length < 2) error('too_few_options', 'Add at least two options.', optPath, at);
        const optionKeys = new Set<string>();
        const labels = new Set<string>();
        q.options.forEach((o, oi) => {
          if (optionKeys.has(o.key))
            error('duplicate_key', `Option key "${o.key}" is used twice.`, `${optPath}[${oi}]`, at);
          optionKeys.add(o.key);
          if (!o.label.trim())
            error('option_label_required', `Option ${oi + 1} has no label.`, `${optPath}[${oi}]`, at);
          const normalised = o.label.trim().toLowerCase();
          if (normalised && labels.has(normalised))
            warn('duplicate_option_label', `Two options are labelled "${o.label}".`, `${optPath}[${oi}]`, at);
          labels.add(normalised);
          if (o.isOther && !meta.supportsOther)
            error(
              'other_not_supported',
              `${meta.label} questions can't have an "Other" option.`,
              optPath,
              at,
            );
          if (o.exclusive && q.type !== 'multi_choice')
            error('exclusive_not_supported', 'Only multiple choice options can be exclusive.', optPath, at);
        });
        if (q.options.filter((o) => o.isOther).length > 1)
          error('multiple_other', 'Only one "Other" option is allowed.', optPath, at);
      }

      if (q.type === 'multi_choice') {
        const { minSelections: min, maxSelections: max } = q.config;
        const selectable = q.options.filter((o) => !o.exclusive).length;
        if (min !== undefined && max !== undefined && min > max)
          error('min_exceeds_max', 'Minimum selections is higher than maximum.', `${path}.config`, at);
        if (max !== undefined && max > selectable)
          error(
            'max_exceeds_options',
            'Maximum selections is higher than the number of options.',
            `${path}.config`,
            at,
          );
        if (min !== undefined && min > selectable)
          error(
            'min_exceeds_options',
            'Minimum selections is higher than the number of options.',
            `${path}.config`,
            at,
          );
      }

      if ((q.type === 'short_text' || q.type === 'long_text') && q.config.minLength !== undefined) {
        if (q.config.minLength > q.config.maxLength)
          error('min_exceeds_max', 'Minimum length is longer than maximum length.', `${path}.config`, at);
      }

      if (q.type === 'date') {
        const { minDate, maxDate } = q.config;
        if (minDate && !isValidIsoDate(minDate))
          error('invalid_date', 'Earliest date is not a valid date.', `${path}.config.minDate`, at);
        if (maxDate && !isValidIsoDate(maxDate))
          error('invalid_date', 'Latest date is not a valid date.', `${path}.config.maxDate`, at);
        if (minDate && maxDate && minDate > maxDate)
          error('min_exceeds_max', 'Earliest date is after the latest date.', `${path}.config`, at);
      }

      if (q.type === 'likert') {
        const values = q.options.map((o) => o.value);
        if (values.some((v) => v === undefined))
          warn(
            'likert_missing_values',
            'Give every scale point a numeric value so averages can be shown.',
            path,
            at,
          );
      }
    });
  });

  if (questionCount === 0) error('no_questions', 'Add at least one question.', 'pages');
  if (questionCount > LIMITS.questions)
    error('too_many_questions', `A survey can have at most ${LIMITS.questions} questions.`, 'pages');

  const hiddenKeys = new Set<string>();
  def.hiddenFields.forEach((field, i) => {
    const path = `hiddenFields[${i}]`;
    if (hiddenKeys.has(field.key))
      error('duplicate_hidden_field', `Hidden field "${field.key}" is declared twice.`, path);
    hiddenKeys.add(field.key);
    if ((RESERVED_HIDDEN_FIELDS as readonly string[]).includes(field.key))
      error(
        'reserved_hidden_field',
        `"${field.key}" is reserved by the platform. Choose another name.`,
        path,
      );
    if (ctx.anonymous && !field.nonIdentifying)
      warn(
        'hidden_field_dropped_when_anonymous',
        `Hidden field "${field.key}" isn't marked as non-identifying, so it won't be collected in this anonymous survey.`,
        path,
      );
  });

  return issues;
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
