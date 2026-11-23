/** Question types, in the order the builder offers them. */
export const QUESTION_TYPES = [
  'single_choice',
  'multi_choice',
  'dropdown',
  'likert',
  'matrix',
  'ranking',
  'rating',
  'nps',
  'slider',
  'short_text',
  'long_text',
  'email',
  'phone',
  'date',
  'file_upload',
  'consent',
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

/** How a question's answer behaves in conditions (which operators apply). */
export type ValueKind = 'choice' | 'multi' | 'matrix' | 'ranking' | 'number' | 'text' | 'date' | 'file' | 'consent';

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
  kind: ValueKind;
  /** Phase the type was introduced in (for docs and the builder). */
  phase: 1 | 2;
}

const meta = (m: Omit<QuestionTypeMeta, 'supportsOther' | 'textLike' | 'identifying' | 'choiceLike'> & Partial<QuestionTypeMeta>): QuestionTypeMeta => ({
  choiceLike: false,
  supportsOther: false,
  textLike: false,
  identifying: false,
  ...m,
});

export const QUESTION_TYPE_META: Record<QuestionType, QuestionTypeMeta> = {
  single_choice: meta({ label: 'Single choice', description: 'Pick one option', choiceLike: true, supportsOther: true, kind: 'choice', phase: 1 }),
  multi_choice: meta({ label: 'Multiple choice', description: 'Pick one or more options', choiceLike: true, supportsOther: true, kind: 'multi', phase: 1 }),
  dropdown: meta({ label: 'Dropdown', description: 'Pick one option from a list', choiceLike: true, kind: 'choice', phase: 1 }),
  likert: meta({ label: 'Likert scale', description: 'Agreement with a statement', choiceLike: true, kind: 'choice', phase: 1 }),
  matrix: meta({ label: 'Matrix', description: 'Several rows rated on the same columns', kind: 'matrix', phase: 2 }),
  ranking: meta({ label: 'Ranking', description: 'Put options in order of preference', kind: 'ranking', phase: 2 }),
  rating: meta({ label: 'Rating', description: 'Stars or numbers on a scale', kind: 'number', phase: 1 }),
  nps: meta({ label: 'Net Promoter Score', description: 'Likelihood to recommend, 0–10', kind: 'number', phase: 1 }),
  slider: meta({ label: 'Slider', description: 'A number on a continuous scale', kind: 'number', phase: 2 }),
  short_text: meta({ label: 'Short text', description: 'A single line of text or a number', textLike: true, kind: 'text', phase: 1 }),
  long_text: meta({ label: 'Long text', description: 'A paragraph of text', textLike: true, kind: 'text', phase: 1 }),
  email: meta({ label: 'Email', description: 'An email address', textLike: true, identifying: true, kind: 'text', phase: 1 }),
  phone: meta({ label: 'Phone number', description: 'An international phone number', textLike: true, identifying: true, kind: 'text', phase: 2 }),
  date: meta({ label: 'Date / time', description: 'A date, a time, or both', kind: 'date', phase: 1 }),
  file_upload: meta({ label: 'File upload', description: 'Images or documents', identifying: true, kind: 'file', phase: 2 }),
  consent: meta({ label: 'Consent', description: 'Agree to a statement (e.g. privacy notice)', kind: 'consent', phase: 2 }),
};

export const OPERATORS = [
  'answered',
  'not_answered',
  'eq',
  'neq',
  'in',
  'not_in',
  'contains_any',
  'contains_all',
  'contains_none',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'text_contains',
] as const;
export type Operator = (typeof OPERATORS)[number];

/** Operators valid for each kind of value. Matrix rows behave as choice/multi, ranked options as numbers. */
export const OPERATORS_BY_KIND: Record<ValueKind | 'hidden', readonly Operator[]> = {
  choice: ['eq', 'neq', 'in', 'not_in', 'answered', 'not_answered'],
  multi: ['contains_any', 'contains_all', 'contains_none', 'answered', 'not_answered'],
  matrix: ['answered', 'not_answered'],
  ranking: ['answered', 'not_answered'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'answered', 'not_answered'],
  text: ['eq', 'neq', 'text_contains', 'answered', 'not_answered'],
  date: ['eq', 'gt', 'lt', 'between', 'answered', 'not_answered'],
  file: ['answered', 'not_answered'],
  consent: ['answered', 'not_answered'],
  hidden: ['eq', 'neq', 'in', 'not_in', 'text_contains', 'answered', 'not_answered'],
};

export const FILE_CATEGORIES = ['image', 'pdf', 'document', 'spreadsheet', 'text'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

/** MIME types accepted per category. The server checks the file's actual bytes, not the name. */
export const FILE_CATEGORY_MIME: Record<FileCategory, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  pdf: ['application/pdf'],
  document: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text'],
  spreadsheet: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'],
  text: ['text/plain'],
};

export const LIMITS = {
  pages: 50,
  elementsPerPage: 100,
  questions: 300,
  options: 100,
  matrixRows: 50,
  hiddenFields: 20,
  hiddenFieldValueLength: 500,
  titleLength: 2000,
  helpTextLength: 2000,
  optionLabelLength: 500,
  textBlockLength: 10000,
  otherTextLength: 1000,
  shortTextMax: 1000,
  longTextMax: 20000,
  logicRules: 200,
  conditionDepth: 3,
  conditionItems: 20,
  patternLength: 200,
  maxFiles: 10,
  maxFileSizeMb: 25,
} as const;

/** URL parameters the platform itself uses; they can't be declared as hidden fields. */
export const RESERVED_HIDDEN_FIELDS = ['d', 'test', 'lang', 'resume'] as const;

export const KEY_PATTERN = /^[a-z]{1,2}_[A-Za-z0-9]{6,16}$/;
export const HIDDEN_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
