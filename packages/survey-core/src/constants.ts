/** Question types available in Phase 1. Matrix, ranking, slider, phone, file upload and consent arrive in Phase 2A. */
export const QUESTION_TYPES = [
  'single_choice',
  'multi_choice',
  'dropdown',
  'short_text',
  'long_text',
  'rating',
  'nps',
  'likert',
  'email',
  'date',
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface QuestionTypeMeta {
  label: string;
  description: string;
  /** Answers are option keys (stored in `value_choices`). */
  choiceLike: boolean;
  /** Supports an "Other, please specify" option. */
  supportsOther: boolean;
  /** Answers are free text. */
  textLike: boolean;
  /** Not allowed in anonymous surveys: the answer identifies the respondent. */
  identifying: boolean;
}

export const QUESTION_TYPE_META: Record<QuestionType, QuestionTypeMeta> = {
  single_choice: {
    label: 'Single choice',
    description: 'Pick one option',
    choiceLike: true,
    supportsOther: true,
    textLike: false,
    identifying: false,
  },
  multi_choice: {
    label: 'Multiple choice',
    description: 'Pick one or more options',
    choiceLike: true,
    supportsOther: true,
    textLike: false,
    identifying: false,
  },
  dropdown: {
    label: 'Dropdown',
    description: 'Pick one option from a list',
    choiceLike: true,
    supportsOther: false,
    textLike: false,
    identifying: false,
  },
  short_text: {
    label: 'Short text',
    description: 'A single line of text',
    choiceLike: false,
    supportsOther: false,
    textLike: true,
    identifying: false,
  },
  long_text: {
    label: 'Long text',
    description: 'A paragraph of text',
    choiceLike: false,
    supportsOther: false,
    textLike: true,
    identifying: false,
  },
  rating: {
    label: 'Rating',
    description: 'Stars or numbers on a scale',
    choiceLike: false,
    supportsOther: false,
    textLike: false,
    identifying: false,
  },
  nps: {
    label: 'Net Promoter Score',
    description: 'Likelihood to recommend, 0–10',
    choiceLike: false,
    supportsOther: false,
    textLike: false,
    identifying: false,
  },
  likert: {
    label: 'Likert scale',
    description: 'Agreement with a statement',
    choiceLike: true,
    supportsOther: false,
    textLike: false,
    identifying: false,
  },
  email: {
    label: 'Email',
    description: 'An email address',
    choiceLike: false,
    supportsOther: false,
    textLike: true,
    identifying: true,
  },
  date: {
    label: 'Date',
    description: 'A calendar date',
    choiceLike: false,
    supportsOther: false,
    textLike: false,
    identifying: false,
  },
};

export const LIMITS = {
  pages: 50,
  elementsPerPage: 100,
  questions: 300,
  options: 100,
  hiddenFields: 20,
  hiddenFieldValueLength: 500,
  titleLength: 2000,
  helpTextLength: 2000,
  optionLabelLength: 500,
  textBlockLength: 10000,
  otherTextLength: 1000,
  shortTextMax: 1000,
  longTextMax: 20000,
} as const;

/** URL parameters the platform itself uses; they can't be declared as hidden fields. */
export const RESERVED_HIDDEN_FIELDS = ['d', 'test', 'lang', 'resume'] as const;

export const KEY_PATTERN = /^[a-z]{1,2}_[A-Za-z0-9]{6,16}$/;
export const HIDDEN_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
