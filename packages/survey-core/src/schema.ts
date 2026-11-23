/**
 * Structural schema for a survey definition (data model §2.3).
 *
 * This module is the only part of @survey/core that depends on Zod. The respondent app imports
 * types from here with `import type` only, so Zod never reaches the respondent bundle.
 * Semantic rules (unique keys, min ≤ max, …) live in validate.ts.
 */
import { z } from 'zod';
import { HIDDEN_FIELD_PATTERN, ISO_DATE_PATTERN, KEY_PATTERN, LIMITS } from './constants';

const Key = z.string().regex(KEY_PATTERN, 'Invalid key');
const Title = z.string().max(LIMITS.titleLength);
const HelpText = z.string().max(LIMITS.helpTextLength).optional();
const IsoDate = z.string().regex(ISO_DATE_PATTERN, 'Use YYYY-MM-DD');

export const ChoiceOptionSchema = z.strictObject({
  key: Key,
  label: z.string().max(LIMITS.optionLabelLength),
  /** Ordinal used for Likert means. */
  value: z.number().int().min(-100).max(100).optional(),
  /** "Other, please specify": selecting it asks for free text. */
  isOther: z.boolean().optional(),
  /** "None of the above": selecting it clears every other option (multi choice only). */
  exclusive: z.boolean().optional(),
});

const Options = z.array(ChoiceOptionSchema).max(LIMITS.options);

const QuestionBase = {
  kind: z.literal('question'),
  key: Key,
  title: Title,
  helpText: HelpText,
  required: z.boolean(),
};

const RandomizeConfig = z.strictObject({ randomize: z.boolean() });

export const SingleChoiceSchema = z.strictObject({
  ...QuestionBase,
  type: z.literal('single_choice'),
  options: Options,
  config: RandomizeConfig,
});

export const MultiChoiceSchema = z.strictObject({
  ...QuestionBase,
  type: z.literal('multi_choice'),
  options: Options,
  config: z.strictObject({
    randomize: z.boolean(),
    minSelections: z.number().int().min(1).max(LIMITS.options).optional(),
    maxSelections: z.number().int().min(1).max(LIMITS.options).optional(),
  }),
});

export const DropdownSchema = z.strictObject({
  ...QuestionBase,
  type: z.literal('dropdown'),
  options: Options,
  config: z.strictObject({ randomize: z.boolean(), placeholder: z.string().max(200).optional() }),
});

const TextConfig = (max: number) =>
  z.strictObject({
    minLength: z.number().int().min(1).max(max).optional(),
    maxLength: z.number().int().min(1).max(max),
    placeholder: z.string().max(200).optional(),
  });

export const ShortTextSchema = z.strictObject({
  ...QuestionBase,
  type: z.literal('short_text'),
  config: TextConfig(LIMITS.shortTextMax),
});

export const LongTextSchema = z.strictObject({
  ...QuestionBase,
  type: z.literal('long_text'),
  config: TextConfig(LIMITS.longTextMax),
});

export const RatingSchema = z.strictObject({
  ...QuestionBase,
  type: z.literal('rating'),
  config: z.strictObject({
    scale: z.number().int().min(3).max(10),
    icon: z.enum(['star', 'number']),
    lowLabel: z.string().max(100).optional(),
    highLabel: z.string().max(100).optional(),
  }),
});

export const NpsSchema = z.strictObject({
  ...QuestionBase,
  type: z.literal('nps'),
  config: z.strictObject({ lowLabel: z.string().max(100), highLabel: z.string().max(100) }),
});

export const LikertSchema = z.strictObject({
  ...QuestionBase,
  type: z.literal('likert'),
  options: Options,
  config: z.strictObject({}),
});

export const EmailSchema = z.strictObject({
  ...QuestionBase,
  type: z.literal('email'),
  config: z.strictObject({ placeholder: z.string().max(200).optional() }),
});

export const DateSchema = z.strictObject({
  ...QuestionBase,
  type: z.literal('date'),
  config: z.strictObject({ minDate: IsoDate.optional(), maxDate: IsoDate.optional() }),
});

export const QuestionSchema = z.discriminatedUnion('type', [
  SingleChoiceSchema,
  MultiChoiceSchema,
  DropdownSchema,
  ShortTextSchema,
  LongTextSchema,
  RatingSchema,
  NpsSchema,
  LikertSchema,
  EmailSchema,
  DateSchema,
]);

export const TextBlockSchema = z.strictObject({
  kind: z.literal('text'),
  key: Key,
  /** Plain text with paragraphs; rendered as text, never HTML. */
  body: z.string().max(LIMITS.textBlockLength),
});

export const ElementSchema = z.union([QuestionSchema, TextBlockSchema]);

export const PageSchema = z.strictObject({
  key: Key,
  title: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  elements: z.array(ElementSchema).max(LIMITS.elementsPerPage),
});

export const HiddenFieldSchema = z.strictObject({
  key: z.string().regex(HIDDEN_FIELD_PATTERN, 'Letters, digits and underscores only'),
  label: z.string().max(200).optional(),
  /** Allowed in anonymous surveys (e.g. `source`). Unmarked fields are dropped when the survey is anonymous. */
  nonIdentifying: z.boolean().optional(),
});

export const SurveyDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  defaultLocale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  pages: z.array(PageSchema).min(1).max(LIMITS.pages),
  hiddenFields: z.array(HiddenFieldSchema).max(LIMITS.hiddenFields),
  settings: z.strictObject({
    showProgressBar: z.boolean(),
    allowBack: z.boolean(),
    thankYou: z.strictObject({ title: z.string().max(200), body: z.string().max(5000) }),
  }),
});

export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type TextBlock = z.infer<typeof TextBlockSchema>;
export type Element = z.infer<typeof ElementSchema>;
export type Page = z.infer<typeof PageSchema>;
export type HiddenField = z.infer<typeof HiddenFieldSchema>;
export type SurveyDefinition = z.infer<typeof SurveyDefinitionSchema>;
export type ChoiceQuestion = Extract<Question, { options: ChoiceOption[] }>;

export interface StructuralIssue {
  path: string;
  code: string;
  message: string;
}

/** Parse untrusted JSON into a definition. Structural problems block saving. */
export function parseDefinition(
  input: unknown,
): { ok: true; definition: SurveyDefinition } | { ok: false; issues: StructuralIssue[] } {
  const result = SurveyDefinitionSchema.safeParse(input);
  if (result.success) return { ok: true, definition: result.data };
  return {
    ok: false,
    issues: result.error.issues.slice(0, 50).map((issue) => ({
      path: formatPath(issue.path),
      code: issue.code,
      message: issue.message,
    })),
  };
}

function formatPath(path: PropertyKey[]): string {
  return path
    .map((segment, i) =>
      typeof segment === 'number' ? `[${segment}]` : `${i === 0 ? '' : '.'}${String(segment)}`,
    )
    .join('');
}
