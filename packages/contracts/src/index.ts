/**
 * API contracts (docs/03-api-design.md). Request bodies are Zod schemas so the API validates
 * exactly what the clients type-check against. Responses are plain TypeScript types.
 *
 * The respondent app imports from here with `import type` only, so Zod stays out of its bundle.
 */
import { z } from 'zod';
import type { AnswerValue, Issue, Question, SurveyDefinition, ThemeTokens } from '@survey/core';

// ── Shared ───────────────────────────────────────────────────────────────────
export const ORG_ROLES = ['org_admin', 'creator', 'analyst'] as const;
export const SURVEY_ROLES = ['owner', 'editor', 'viewer'] as const;
export const SURVEY_STATUSES = ['draft', 'live', 'closed', 'archived'] as const;

export type OrgRole = (typeof ORG_ROLES)[number];
export type SurveyRole = (typeof SURVEY_ROLES)[number];
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];
export type ResponseStatus = 'in_progress' | 'completed' | 'disqualified';

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: { path: string; code: string; message: string; pageKey?: string }[];
  requestId: string;
}

export interface PageResult<T> {
  data: T[];
  nextCursor: string | null;
}

const Email = z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address.'));
const Password = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(200, 'Use no more than 200 characters.');
const Name = z.string().trim().min(1, 'Enter a name.').max(200);
const IsoDateTime = z.iso.datetime({ offset: true });

// ── Auth ─────────────────────────────────────────────────────────────────────
export const SignupRequest = z.object({ name: Name, email: Email, password: Password, orgName: Name });
export const LoginRequest = z.object({ email: Email, password: z.string().min(1).max(200) });
export const SwitchOrgRequest = z.object({ orgId: z.uuid() });
export const TokenRequest = z.object({ token: z.string().min(10).max(200) });
export const ForgotPasswordRequest = z.object({ email: Email });
export const ResetPasswordRequest = z.object({ token: z.string().min(10).max(200), password: Password });

export interface Me {
  user: { id: string; email: string; name: string; isSuperAdmin: boolean; emailVerified: boolean };
  activeOrg: { id: string; name: string; slug: string; role: OrgRole } | null;
  memberships: { orgId: string; orgName: string; role: OrgRole }[];
  csrfToken: string;
}

// ── Organization ─────────────────────────────────────────────────────────────
export const UpdateOrgRequest = z.object({
  name: Name.optional(),
  /** Phase 3A: publishing needs approval by an org admin or a designated approver. */
  approvalRequired: z.boolean().optional(),
  approverIds: z.array(z.uuid()).max(50).optional(),
});
export const UpdateMemberRequest = z.object({ role: z.enum(ORG_ROLES) });
export const CreateInvitationRequest = z.object({ email: Email, role: z.enum(ORG_ROLES) });
export const AcceptInvitationRequest = z.object({ name: Name.optional(), password: Password.optional() });

export interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
  /** Phase 3A. */
  approvalRequired: boolean;
  approverIds: string[];
}
export interface Member {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  joinedAt: string;
  lastLoginAt: string | null;
}
export interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}
export interface InvitationPreview {
  orgName: string;
  email: string;
  role: OrgRole;
  userExists: boolean;
}

// ── Surveys ──────────────────────────────────────────────────────────────────
export const AccessSettings = z.object({
  closesAt: IsoDateTime.nullable(),
  /** Not accepting responses before this time (Phase 2A). */
  opensAt: IsoDateTime.nullable(),
  quota: z.number().int().min(1).max(10_000_000).nullable(),
  onePerBrowser: z.boolean(),
  /** Require a CAPTCHA before a new response starts (Phase 2A). */
  captcha: z.boolean(),
});
export type AccessSettings = z.infer<typeof AccessSettings> & { passwordEnabled: boolean };
/** `password` is write-only: a string sets it, null removes it. */
export const AccessSettingsUpdate = AccessSettings.partial().extend({
  password: z.string().min(4, 'Use at least 4 characters.').max(200).nullable().optional(),
});

export const CreateSurveyRequest = z.object({
  title: z.string().trim().min(1).max(300),
  fromTemplate: z.object({ kind: z.enum(['global', 'org']), id: z.uuid() }).optional(),
  /** Phase 3A. */
  folderId: z.uuid().optional(),
});
export const UpdateSurveyRequest = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  anonymous: z.boolean().optional(),
  access: AccessSettingsUpdate.optional(),
  themeId: z.uuid().nullable().optional(),
  /** Phase 3A: null moves the survey out of any folder. */
  folderId: z.uuid().nullable().optional(),
});
export const DuplicateSurveyRequest = z.object({ title: z.string().trim().min(1).max(300).optional() });
export const SaveDraftRequest = z.object({ definition: z.unknown() });
export const PublishRequest = z.object({
  revision: z.number().int().min(0),
  /** Phase 3A: shown to approvers when the org requires approval. */
  note: z.string().trim().max(1000).optional(),
});
export const SetCollaboratorRequest = z.object({ role: z.enum(SURVEY_ROLES) });
export const TransferSurveyRequest = z.object({ userId: z.uuid() });
export const ListSurveysQuery = z.object({
  status: z.enum(SURVEY_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  /** Phase 3A: a folder id, or `none` for surveys outside every folder. */
  folderId: z.union([z.uuid(), z.literal('none')]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface SurveySummary {
  id: string;
  publicId: string;
  title: string;
  status: SurveyStatus;
  myRole: SurveyRole;
  owner: { id: string; name: string } | null;
  completedCount: number;
  currentVersionNumber: number | null;
  hasDraft: boolean;
  publicUrl: string | null;
  updatedAt: string;
  /** Phase 3A. */
  folderId: string | null;
  /** Phase 3A: a publish waiting for approval. */
  pendingApproval: boolean;
}

export interface SurveyDetail extends SurveySummary {
  anonymous: boolean;
  access: AccessSettings;
  closedReason: 'manual' | 'close_date' | 'quota' | null;
  createdAt: string;
  /** Link that records responses flagged as test data (editors only). */
  testUrl: string | null;
  responseCount: number;
  themeId: string | null;
  isTemplate: boolean;
}

export interface DraftValidation {
  errors: Issue[];
  warnings: Issue[];
}

export interface Draft {
  versionId: string;
  revision: number;
  basedOnVersionNumber: number | null;
  definition: SurveyDefinition;
  validation: DraftValidation;
  updatedAt: string;
}

export interface SaveDraftResult {
  revision: number;
  validation: DraftValidation;
  updatedAt: string;
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  publishedAt: string;
  publishedBy: string | null;
  responseCount: number;
}

export interface VersionDetail extends VersionSummary {
  definition: SurveyDefinition;
}

export interface PublishResult {
  version: { id: string; versionNumber: number; publishedAt: string };
  survey: SurveyDetail;
  publicUrl: string;
}

export interface Collaborator {
  user: { id: string; name: string; email: string };
  role: SurveyRole;
}

// ── Distribution ─────────────────────────────────────────────────────────────
const PresetHiddenFields = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(500));
export const CreateDistributionRequest = z.object({
  channel: z.literal('link'),
  name: z.string().trim().min(1).max(200),
  presetHiddenFields: PresetHiddenFields.optional(),
});
export const UpdateDistributionRequest = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  presetHiddenFields: PresetHiddenFields.optional(),
  disabled: z.boolean().optional(),
});

export interface Distribution {
  id: string;
  channel: 'link' | 'embed' | 'email';
  name: string;
  isDefault: boolean;
  url: string;
  presetHiddenFields: Record<string, string>;
  responseCount: number;
  disabledAt: string | null;
  createdAt: string;
}

// ── Respondent API (/r/v1) ───────────────────────────────────────────────────
const AnswerValueSchema: z.ZodType<AnswerValue> = z.union([
  z.string().max(25_000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(100)).max(100),
  z.strictObject({ option: z.string().max(100), other: z.string().max(2000) }),
  z.strictObject({ options: z.array(z.string().max(100)).max(100), other: z.string().max(2000) }),
  // Matrix: row key -> column key(s).
  z.record(z.string().max(40), z.union([z.string().max(100), z.array(z.string().max(100)).max(100)])),
]);

export const SaveResponseRequest = z.object({
  seq: z.number().int().min(1).max(1_000_000),
  start: z
    .object({
      versionId: z.uuid(),
      distributionToken: z.string().max(64).optional(),
      testToken: z.string().max(128).optional(),
      hiddenFields: z.record(z.string().max(64), z.string().max(500)).optional(),
      locale: z.string().max(10),
      /** Turnstile token, when the survey requires a CAPTCHA. */
      captchaToken: z.string().max(2048).optional(),
      /** Phase 2B: the personal token from a campaign email link. */
      recipientToken: z.string().max(64).optional(),
    })
    .optional(),
  /** Full snapshot of every answer so far; the latest `seq` wins. */
  answers: z.record(z.string().max(40), AnswerValueSchema.nullable()),
  currentPageKey: z.string().max(40),
  hp: z.string().max(500).optional(),
});
export type SaveResponseRequest = z.infer<typeof SaveResponseRequest>;

export type RespondentAccess =
  | { state: 'open' }
  | { state: 'closed'; message: string }
  | { state: 'not_yet_open'; opensAt: string }
  | { state: 'password_required' }
  | { state: 'already_responded' }
  | { state: 'not_found' };

export const UnlockRequest = z.object({ password: z.string().min(1).max(200) });
export interface UnlockResult {
  /** Send as X-Access-Token on later respondent requests. Valid for 12 hours. */
  accessToken: string;
}

export interface RespondentTheme {
  tokens: ThemeTokens;
  logoUrl: string | null;
}

export interface ResumeState {
  versionId: string;
  status: ResponseStatus;
  currentPageKey: string | null;
  seq: number;
  answers: Record<string, AnswerValue>;
  /** The hidden fields stored with the response (logic and piping use them). */
  hiddenFields: Record<string, string>;
}

export interface RespondentSurvey {
  survey: { publicId: string; title: string; anonymous: boolean; onePerBrowser: boolean };
  access: RespondentAccess;
  version: { id: string; definition: SurveyDefinition } | null;
  /** Present when the request carried a valid X-Response-Key for an existing response. */
  resume: ResumeState | null;
  theme: RespondentTheme | null;
  /** Turnstile site key when this survey requires a CAPTCHA to start. */
  captchaSiteKey: string | null;
  /** Hidden-field values the distribution link presets. They win over URL parameters, as on the server. */
  presetHiddenFields: Record<string, string>;
  /** Phase 2B: contact fields for piping, when opened from a campaign link (never for anonymous surveys). */
  contact: Record<string, string> | null;
}

export const ResumeLinkRequest = z.object({ email: z.email().max(254) });

export interface UploadedFile {
  fileId: string;
  filename: string;
  size: number;
  mime: string;
}

export interface SaveResponseResult {
  applied: boolean;
  seq: number;
}

export interface CompleteResult {
  responseStatus: 'completed' | 'disqualified';
  /** The thank-you or screen-out message, with piping already applied. */
  thankYou: { title: string; body: string };
  /** Where to send the respondent next (completed responses only). */
  redirectUrl: string | null;
}

// ── Results ──────────────────────────────────────────────────────────────────
export const ResultsQuery = z.object({
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  versionId: z.uuid().optional(),
  includePartial: z.stringbool().default(false),
  includeTest: z.stringbool().default(false),
  /** Leave out responses with quality flags (too fast, straight-lined, ...). */
  excludeFlagged: z.stringbool().default(false),
});
export type ResultsQuery = z.infer<typeof ResultsQuery>;

export interface OptionCount {
  key: string;
  label: string;
  count: number;
  pct: number;
}

export type QuestionSummary = {
  questionKey: string;
  title: string;
  answered: number;
  removedInCurrentVersion: boolean;
} & (
  | {
      type: 'single_choice' | 'multi_choice' | 'dropdown' | 'likert';
      options: OptionCount[];
      otherCount: number;
      mean: number | null;
    }
  | {
      type: 'rating';
      scale: number;
      mean: number | null;
      median: number | null;
      distribution: { value: number; count: number }[];
    }
  | {
      type: 'nps';
      score: number | null;
      promoters: number;
      passives: number;
      detractors: number;
      distribution: { value: number; count: number }[];
    }
  | { type: 'short_text' | 'long_text' | 'email' | 'phone'; latest: { responseId: string; text: string }[] }
  | { type: 'date'; byDay: { date: string; count: number }[] }
  | {
      type: 'matrix';
      rows: { key: string; label: string; answered: number }[];
      columns: { key: string; label: string }[];
      /** counts[row][column] */
      counts: number[][];
    }
  | {
      type: 'ranking';
      options: { key: string; label: string; meanRank: number | null; firstPlace: number; ranked: number }[];
    }
  | {
      type: 'slider';
      mean: number | null;
      median: number | null;
      min: number;
      max: number;
      histogram: { from: number; to: number; count: number }[];
    }
  | { type: 'file_upload'; files: number }
  | { type: 'consent'; agreed: number }
);

export interface ResultsSummary {
  totals: {
    started: number;
    completed: number;
    disqualified: number;
    completionRate: number | null;
    avgDurationSec: number | null;
    medianDurationSec: number | null;
  };
  dropoff: { pageKey: string; title: string; reached: number; abandonedHere: number }[];
  questions: QuestionSummary[];
  versions: { id: string; versionNumber: number }[];
  generatedAt: string;
  source: 'aggregate' | 'live';
}

export const ListResponsesQuery = z.object({
  status: z.enum(['in_progress', 'completed', 'disqualified', 'all']).default('all'),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  includeTest: z.stringbool().default(false),
  /** Only responses with this quality flag. */
  flag: z.enum(['too_fast', 'straight_lined', 'malware']).optional(),
  /** Phase 2B: full-text search in open answers, a tag, or a results filter (JSON). */
  q: z.string().trim().max(200).optional(),
  tag: z.uuid().optional(),
  filter: z.string().max(20_000).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const TextAnswersQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface ResponseSummary {
  id: string;
  status: ResponseStatus;
  isTest: boolean;
  startedAt: string;
  completedAt: string | null;
  durationSec: number | null;
  versionNumber: number;
  distributionName: string | null;
  deviceType: string | null;
  preview: string;
  /** Phase 2A: `too_fast`, `straight_lined`, `malware`. */
  qualityFlags: string[];
  /** Phase 2B. */
  tags: { id: string; name: string }[];
}

export interface FileInfo {
  id: string;
  filename: string;
  size: number;
  mime: string;
  scanStatus: 'pending' | 'clean' | 'infected' | 'error';
  questionKey: string | null;
}

export interface ResponseDetail extends ResponseSummary {
  hiddenFields: Record<string, string>;
  answers: { questionKey: string; title: string; type: string; value: AnswerValue; display: string }[];
  files: FileInfo[];
  /** Phase 2B. */
  notes: { id: string; author: string | null; authorId: string | null; body: string; createdAt: string }[];
  /** Phase 2B: the campaign recipient, for non-anonymous surveys. */
  contact: { email: string; name: string } | null;
}

export const ExportQuery = z.object({
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  versionId: z.uuid().optional(),
  status: z.enum(['completed', 'all']).default('completed'),
  layout: z.enum(['compact', 'expanded']).default('compact'),
  includeTest: z.stringbool().default(false),
  excludeFlagged: z.stringbool().default(false),
});
export type ExportQuery = z.infer<typeof ExportQuery>;

// -- Themes (Phase 2A) --------------------------------------------------------
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #2445a8.');
export const ThemeTokensSchema = z.strictObject({
  primary: Hex,
  background: Hex,
  surface: Hex,
  text: Hex,
  font: z.enum(['system', 'humanist', 'rounded', 'serif', 'mono']),
  radius: z.enum(['none', 'small', 'medium', 'large']),
});
export const SaveThemeRequest = z.object({
  name: z.string().trim().min(1).max(100),
  tokens: ThemeTokensSchema,
  logoFileId: z.uuid().nullable().optional(),
  isDefault: z.boolean().optional(),
});
export interface Theme {
  id: string;
  name: string;
  tokens: ThemeTokens;
  logoFileId: string | null;
  logoUrl: string | null;
  isDefault: boolean;
  surveyCount: number;
  updatedAt: string;
}

// -- Templates and question bank (Phase 2A) -----------------------------------
export interface TemplateSummary {
  kind: 'global' | 'org';
  id: string;
  name: string;
  description: string;
  category: string;
  questionCount: number;
}
export const SaveAsTemplateRequest = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).default(''),
});
export const CreateBankItemRequest = z.object({
  question: z.unknown(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});
export const BankQuery = z.object({ q: z.string().trim().max(200).optional() });
export interface BankItem {
  id: string;
  question: Question;
  tags: string[];
  createdBy: string | null;
  createdAt: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2B
// ═════════════════════════════════════════════════════════════════════════════

// -- Results filters: the logic condition grammar plus response fields ---------
const FilterOp = z.enum([
  'answered', 'not_answered', 'eq', 'neq', 'in', 'not_in', 'contains_any', 'contains_all', 'contains_none',
  'gt', 'gte', 'lt', 'lte', 'between', 'text_contains',
]);
const FilterValue = z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.union([z.string().max(500), z.number()])).max(100)]);
export const RESULT_FIELDS = ['status', 'startedAt', 'completedAt', 'versionId', 'distributionId', 'deviceType', 'tag'] as const;
export type ResultField = (typeof RESULT_FIELDS)[number];

export type ResultFilter =
  | { all: ResultFilter[] }
  | { any: ResultFilter[] }
  | { not: ResultFilter }
  | { question: string; sub?: string; op: z.infer<typeof FilterOp>; value?: z.infer<typeof FilterValue> }
  | { hidden: string; op: 'eq' | 'neq' | 'in' | 'not_in' | 'text_contains' | 'answered' | 'not_answered'; value?: string | string[] }
  | { field: ResultField; op: 'eq' | 'neq' | 'in' | 'not_in' | 'gte' | 'lte' | 'between'; value: z.infer<typeof FilterValue> };

export const ResultFilterSchema: z.ZodType<ResultFilter> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ResultFilterSchema).min(1).max(20) }),
    z.strictObject({ any: z.array(ResultFilterSchema).min(1).max(20) }),
    z.strictObject({ not: ResultFilterSchema }),
    z.strictObject({ question: z.string().max(40), sub: z.string().max(40).optional(), op: FilterOp, value: FilterValue.optional() }),
    z.strictObject({
      hidden: z.string().max(64),
      op: z.enum(['eq', 'neq', 'in', 'not_in', 'text_contains', 'answered', 'not_answered']),
      value: z.union([z.string().max(500), z.array(z.string().max(500)).max(100)]).optional(),
    }),
    z.strictObject({ field: z.enum(RESULT_FIELDS), op: z.enum(['eq', 'neq', 'in', 'not_in', 'gte', 'lte', 'between']), value: FilterValue }),
  ]),
) as z.ZodType<ResultFilter>;

/** Base scope shared by results, cross-tab, drop-off and exports (the GET summary's query, as JSON). */
const ResultScope = {
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  versionId: z.uuid().optional(),
  includePartial: z.boolean().default(false),
  includeTest: z.boolean().default(false),
  excludeFlagged: z.boolean().default(false),
  filter: ResultFilterSchema.optional(),
};

export const ResultsQueryRequest = z.object({
  ...ResultScope,
  /** Up to 4 segments, compared side by side. Each is combined with `filter`. */
  segments: z.array(z.object({ name: z.string().trim().min(1).max(60), filter: ResultFilterSchema })).max(4).default([]),
});
export type ResultsQueryRequest = z.infer<typeof ResultsQueryRequest>;

export interface SegmentResult {
  name: string;
  /** null when suppressed: anonymous surveys hide groups smaller than the minimum size. */
  summary: ResultsSummary | null;
  suppressed: boolean;
}
export interface ResultsQueryResult {
  overall: ResultsSummary | null;
  suppressed: boolean;
  segments: SegmentResult[];
  /** Anonymous surveys: groups smaller than this aren't shown. */
  minGroupSize: number | null;
}

const QuestionRef = z.object({ questionKey: z.string().max(40), subKey: z.string().max(40).optional() });
export const CrosstabRequest = z.object({ ...ResultScope, rows: QuestionRef, columns: QuestionRef });
export type CrosstabRequest = z.infer<typeof CrosstabRequest>;
export interface CrosstabResult {
  rows: { key: string; label: string }[];
  columns: { key: string; label: string }[];
  /** counts[row][column] */
  counts: number[][];
  rowTotals: number[];
  columnTotals: number[];
  total: number;
  /** Percentages of each row's total / each column's total, one decimal. */
  rowPct: number[][];
  columnPct: number[][];
  chiSquare: { value: number; df: number; p: number } | null;
  /** Why the chi-square test is missing or unreliable. */
  warnings: string[];
}

export const DropoffRequest = z.object({ ...ResultScope });
export interface DropoffByQuestion {
  started: number;
  questions: {
    questionKey: string;
    title: string;
    pageKey: string;
    /** Responses with an answer to this question (in progress, completed or screened out). */
    answered: number;
    /** In-progress responses whose last answer was this question. */
    leftAfter: number;
  }[];
  /** Started but never answered anything. */
  leftBeforeFirst: number;
}

export const TermsQuery = z.object({
  filter: z.string().max(20_000).optional(),
  includeTest: z.stringbool().default(false),
});
export interface TermsResult {
  answered: number;
  terms: { term: string; count: number }[];
}

export interface LiveEvent {
  type: 'response.completed';
  completedCount: number;
}

// -- Tags, notes, bulk delete --------------------------------------------------
export interface Tag {
  id: string;
  name: string;
  responseCount: number;
}
export const CreateTagRequest = z.object({ name: z.string().trim().min(1).max(40) });
export const CreateNoteRequest = z.object({ body: z.string().trim().min(1).max(5000) });
export const BulkDeleteRequest = z
  .object({
    ids: z.array(z.uuid()).min(1).max(1000).optional(),
    scope: z
      .object({
        status: z.enum(['in_progress', 'completed', 'disqualified', 'all']).default('all'),
        includeTest: z.boolean().default(false),
        q: z.string().trim().max(200).optional(),
        tag: z.uuid().optional(),
        flag: z.enum(['too_fast', 'straight_lined', 'malware']).optional(),
        filter: ResultFilterSchema.optional(),
      })
      .optional(),
    /** The count the user confirmed. The delete is refused if the selection no longer matches it. */
    expectedCount: z.number().int().min(1).max(1_000_000),
  })
  .refine((v) => Boolean(v.ids) !== Boolean(v.scope), 'Send either ids or scope.');
export interface BulkDeleteResult {
  deleted: number;
}

// -- Exports and scheduled reports --------------------------------------------
export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const ExportOptionsSchema = z.object({
  layout: z.enum(['compact', 'expanded']).default('compact'),
  status: z.enum(['completed', 'all']).default('completed'),
  includeTest: z.boolean().default(false),
  excludeFlagged: z.boolean().default(false),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  versionId: z.uuid().optional(),
  filter: ResultFilterSchema.optional(),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;
export const CreateExportRequest = ExportOptionsSchema.extend({ format: z.enum(EXPORT_FORMATS) });
export interface ExportJob {
  id: string;
  format: ExportFormat;
  status: 'queued' | 'running' | 'done' | 'failed';
  filename: string | null;
  size: number | null;
  rowCount: number | null;
  downloadUrl: string | null;
  failure: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
}

export const SaveScheduledReportRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    /** weekly: 1 (Monday) to 7; monthly: 1 to 28. */
    day: z.number().int().min(1).max(28).nullable().default(null),
    hour: z.number().int().min(0).max(23),
    timezone: z.string().min(1).max(64),
    format: z.enum(EXPORT_FORMATS),
    options: ExportOptionsSchema.default({ layout: 'compact', status: 'completed', includeTest: false, excludeFlagged: false }),
    recipientIds: z.array(z.uuid()).min(1).max(20),
    active: z.boolean().default(true),
  })
  .refine((v) => v.frequency === 'daily' || v.day !== null, { message: 'Choose a day.', path: ['day'] })
  .refine((v) => v.frequency !== 'weekly' || (v.day ?? 0) <= 7, { message: 'Choose a weekday.', path: ['day'] });
export interface ScheduledReport {
  id: string;
  name: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  day: number | null;
  hour: number;
  timezone: string;
  format: ExportFormat;
  options: z.infer<typeof ExportOptionsSchema>;
  recipients: { id: string; name: string; email: string }[];
  active: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
}

// -- Contacts -----------------------------------------------------------------
export type ContactStatus = 'subscribed' | 'unsubscribed' | 'bounced';
export interface Contact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  attributes: Record<string, string>;
  status: ContactStatus;
  lists: { id: string; name: string }[];
  createdAt: string;
}
const AttributeName = z.string().trim().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Use letters, numbers and _.');
export const ContactsQuery = z.object({
  q: z.string().trim().max(200).optional(),
  listId: z.uuid().optional(),
  status: z.enum(['subscribed', 'unsubscribed', 'bounced']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const SaveContactRequest = z.object({
  email: z.email().max(254),
  firstName: z.string().trim().max(100).nullable().optional(),
  lastName: z.string().trim().max(100).nullable().optional(),
  attributes: z.record(AttributeName, z.string().max(500)).optional(),
  listIds: z.array(z.uuid()).max(50).optional(),
});
export interface ContactList {
  id: string;
  name: string;
  memberCount: number;
  createdAt: string;
}
export const SaveListRequest = z.object({ name: z.string().trim().min(1).max(100) });
export const ListMembersRequest = z.object({ contactIds: z.array(z.uuid()).min(1).max(1000) });
export const ColumnMappingSchema = z.object({
  email: z.string().min(1).max(200),
  firstName: z.string().max(200).optional(),
  lastName: z.string().max(200).optional(),
  attributes: z.record(z.string().max(200), AttributeName).optional(),
});
/** Multipart fields sent before the CSV file. */
export const ImportFieldsSchema = z.object({
  mapping: z.string().max(20_000),
  listId: z.uuid().optional(),
  newListName: z.string().trim().min(1).max(100).optional(),
});
export interface ContactImport {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  filename: string;
  listId: string | null;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
  errorReportUrl: string | null;
  failure: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// -- Campaigns ------------------------------------------------------------------
export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';
const Reminders = z.object({ afterDays: z.number().int().min(1).max(60), max: z.number().int().min(0).max(5) });
export const SaveCampaignRequest = z.object({
  name: z.string().trim().min(1).max(100),
  listId: z.uuid(),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  reminders: Reminders.nullable().default(null),
});
export const SendCampaignRequest = z.object({
  /** Local date and time in `timezone`, e.g. 2026-12-01T09:00. Omit to send now. */
  scheduledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
  timezone: z.string().min(1).max(64).default('UTC'),
});
export interface Campaign {
  id: string;
  surveyId: string;
  name: string;
  list: { id: string; name: string } | null;
  subject: string;
  body: string;
  status: CampaignStatus;
  scheduledAt: string | null;
  timezone: string;
  reminders: { afterDays: number; max: number } | null;
  counts: { total: number; pending: number; sent: number; responded: number; bounced: number; failed: number; suppressed: number };
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}
export interface CampaignRecipient {
  id: string;
  email: string;
  name: string;
  status: 'pending' | 'sent' | 'failed' | 'suppressed' | 'bounced' | 'responded';
  sentAt: string | null;
  remindersSent: number;
  respondedAt: string | null;
  error: string | null;
}
export const RecipientsQuery = z.object({
  status: z.enum(['pending', 'sent', 'failed', 'suppressed', 'bounced', 'responded']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ── Phase 3A: folders and teams ──────────────────────────────────────────────
export const SaveFolderRequest = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(100),
  /** null or absent: top level. Folders nest at most 3 levels. */
  parentId: z.uuid().nullable().optional(),
});
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  /** Surveys directly in this folder that the caller can see. */
  surveyCount: number;
}

export const SaveTeamRequest = z.object({ name: z.string().trim().min(1, 'Enter a name.').max(100) });
export const SetTeamMembersRequest = z.object({ userIds: z.array(z.uuid()).max(500) });
export interface Team {
  id: string;
  name: string;
  members: { id: string; name: string; email: string; role: OrgRole }[];
  createdAt: string;
}
export const TEAM_SHARE_ROLES = ['editor', 'viewer'] as const;
export const SetTeamShareRequest = z.object({ role: z.enum(TEAM_SHARE_ROLES) });
export interface TeamShare {
  team: { id: string; name: string; memberCount: number };
  role: (typeof TEAM_SHARE_ROLES)[number];
}

// ── Phase 3A: comments on drafts ─────────────────────────────────────────────
export const CreateCommentRequest = z.object({
  body: z.string().trim().min(1, 'Write a comment.').max(5000),
  /** A question or page key; absent or null for the survey as a whole. Replies inherit their thread's. */
  anchorKey: z.string().max(40).nullable().optional(),
  parentId: z.uuid().optional(),
});
export const UpdateCommentRequest = z.object({
  body: z.string().trim().min(1).max(5000).optional(),
  resolved: z.boolean().optional(),
});
export interface Comment {
  id: string;
  anchorKey: string | null;
  parentId: string | null;
  author: { id: string; name: string } | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** The caller wrote it (and can edit or delete it). */
  mine: boolean;
}

// ── Phase 3A: approvals ──────────────────────────────────────────────────────
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'superseded', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const DecideApprovalRequest = z.object({ note: z.string().trim().max(1000).optional() });
export const ListApprovalsQuery = z.object({
  status: z.enum(APPROVAL_STATUSES).optional(),
  surveyId: z.uuid().optional(),
});
export interface ApprovalRequest {
  id: string;
  survey: { id: string; title: string };
  /** The draft revision that was reviewed; approving publishes exactly this. */
  revision: number;
  status: ApprovalStatus;
  requestedBy: { id: string; name: string };
  requestNote: string | null;
  decidedBy: { id: string; name: string } | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** The caller may approve or reject it (an admin or designated approver who didn't request it). */
  canDecide: boolean;
}
/** `POST /surveys/{id}/publish` answers 202 with this when the org requires approval. */
export interface ApprovalPending {
  approvalRequest: ApprovalRequest;
}

// ── Phase 3A: notifications ──────────────────────────────────────────────────
export const NOTIFICATION_KINDS = ['new_response', 'nps_detractor', 'threshold', 'closing'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_CHANNELS = ['email', 'in_app', 'slack'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NotificationRuleSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS),
  config: z
    .object({
      /** nps_detractor: the NPS question to watch (a score of 0-6 is a detractor). */
      questionKey: z.string().max(40).optional(),
      /** threshold: fires once when this many responses are complete. */
      count: z.number().int().min(1).max(10_000_000).optional(),
    })
    .default({}),
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(1, 'Choose at least one channel.').max(3),
});
export const SaveNotificationRulesRequest = z.object({ rules: z.array(NotificationRuleSchema).max(20) });
export type NotificationRuleInput = z.infer<typeof NotificationRuleSchema>;
export interface NotificationRule extends NotificationRuleInput {
  id: string;
}
export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}
export interface NotificationInbox extends PageResult<AppNotification> {
  unread: number;
}
export const NotificationsQuery = z.object({
  unread: z.stringbool().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const MarkNotificationsReadRequest = z
  .object({ ids: z.array(z.uuid()).min(1).max(200).optional(), all: z.literal(true).optional() })
  .refine((v) => Boolean(v.ids) !== Boolean(v.all), 'Send either ids or all.');
export const NotificationPreferencesSchema = z.object({
  /** kind → the channels you accept. A kind that's absent accepts every channel. */
  channels: z.partialRecord(z.enum(NOTIFICATION_KINDS), z.array(z.enum(['email', 'in_app'])).max(2)),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

// ── Phase 3A: public API keys ────────────────────────────────────────────────
export const API_SCOPES = [
  'surveys:read',
  'surveys:write',
  'responses:read',
  'responses:delete',
  'contacts:read',
  'contacts:write',
  'webhooks:manage',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const CreateApiKeyRequest = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(100),
  scopes: z.array(z.enum(API_SCOPES)).min(1, 'Choose at least one scope.'),
  expiresAt: IsoDateTime.nullable().optional(),
});
export interface ApiKey {
  id: string;
  name: string;
  /** The start of the key, to recognise it. The full key is shown only once. */
  prefix: string;
  scopes: ApiScope[];
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}
export interface CreatedApiKey extends ApiKey {
  /** `sk_live_…`. Store it now: it can't be shown again. */
  key: string;
}

// ── Phase 3A: outgoing webhooks ──────────────────────────────────────────────
export const WEBHOOK_EVENTS = ['response.submitted', 'survey.published', 'survey.closed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
const WebhookUrl = z
  .string()
  .trim()
  .max(2000)
  .pipe(z.url({ protocol: /^https?$/, error: 'Enter an http:// or https:// URL.' }));
export const CreateWebhookRequest = z.object({
  url: WebhookUrl,
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Choose at least one event.'),
  /** Only these surveys; null or absent for every survey. */
  surveyIds: z.array(z.uuid()).min(1).max(100).nullable().optional(),
  description: z.string().trim().max(300).optional(),
});
export const UpdateWebhookRequest = CreateWebhookRequest.partial().extend({ active: z.boolean().optional() });
export interface Webhook {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEvent[];
  surveyIds: string[] | null;
  active: boolean;
  /** Events in a row that failed every attempt; 50 disables the endpoint. */
  consecutiveFailures: number;
  disabledReason: string | null;
  /** After a rotation, the previous secret also signs until this time. */
  previousSecretExpiresAt: string | null;
  createdAt: string;
}
export interface CreatedWebhook extends Webhook {
  /** `whsec_…`. Shown once: use it to verify the Survey-Webhook-Signature header. */
  secret: string;
}
export const DELIVERY_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export const DeliveriesQuery = z.object({
  status: z.enum(DELIVERY_STATUSES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: (typeof DELIVERY_STATUSES)[number];
  attempts: number;
  httpStatus: number | null;
  createdAt: string;
  nextAttemptAt: string | null;
}
export interface WebhookAttempt {
  attempt: number;
  manual: boolean;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
  responseSnippet: string | null;
  createdAt: string;
}
export interface WebhookDeliveryDetail extends WebhookDelivery {
  payload: unknown;
  attemptLog: WebhookAttempt[];
}
export interface WebhookTestResult {
  deliveryId: string;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
}

// ── Phase 3A: integrations ───────────────────────────────────────────────────
export const INTEGRATION_KINDS = ['slack', 'hubspot', 'google_sheets'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
export const SlackIntegrationRequest = z.object({
  webhookUrl: z.string().trim().max(500).pipe(z.url({ protocol: /^https?$/ })),
  channelName: z.string().trim().max(80).optional(),
});
export const HubspotIntegrationRequest = z.object({
  /** A HubSpot private-app access token. */
  accessToken: z.string().trim().min(10).max(500),
  /** The email question whose answer identifies the contact. */
  emailQuestionKey: z.string().max(40).optional(),
});
export const GoogleSheetsIntegrationRequest = z.object({
  spreadsheetId: z.string().trim().min(10).max(200),
  sheetName: z.string().trim().min(1).max(100).default('Responses'),
  accessToken: z.string().trim().min(10).max(4000),
});
export interface Integration {
  kind: IntegrationKind;
  connected: boolean;
  status: 'connected' | 'error' | null;
  /** Non-secret details, e.g. the Slack channel. */
  summary: Record<string, string>;
  lastError: string | null;
  updatedAt: string | null;
  /** HubSpot and Google Sheets are defined but don't sync yet (Phase 3A stubs). */
  stub: boolean;
}

// ── Phase 3A: audit log ──────────────────────────────────────────────────────
export const AuditLogQuery = z.object({
  action: z.string().trim().max(100).optional(),
  actorId: z.uuid().optional(),
  entityType: z.string().trim().max(50).optional(),
  entityId: z.uuid().optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export interface AuditEntry {
  id: number;
  createdAt: string;
  action: string;
  actor: { type: 'user' | 'api_key' | 'system'; id: string | null; name: string | null };
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
}
