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
export const UpdateOrgRequest = z.object({ name: Name });
export const UpdateMemberRequest = z.object({ role: z.enum(ORG_ROLES) });
export const CreateInvitationRequest = z.object({ email: Email, role: z.enum(ORG_ROLES) });
export const AcceptInvitationRequest = z.object({ name: Name.optional(), password: Password.optional() });

export interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
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
});
export const UpdateSurveyRequest = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  anonymous: z.boolean().optional(),
  access: AccessSettingsUpdate.optional(),
  themeId: z.uuid().nullable().optional(),
});
export const DuplicateSurveyRequest = z.object({ title: z.string().trim().min(1).max(300).optional() });
export const SaveDraftRequest = z.object({ definition: z.unknown() });
export const PublishRequest = z.object({ revision: z.number().int().min(0) });
export const SetCollaboratorRequest = z.object({ role: z.enum(SURVEY_ROLES) });
export const TransferSurveyRequest = z.object({ userId: z.uuid() });
export const ListSurveysQuery = z.object({
  status: z.enum(SURVEY_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
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
}

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
