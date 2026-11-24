/**
 * Drizzle table definitions for typed queries. The source of truth for the schema is the SQL in
 * ../migrations (it also holds RLS policies, triggers and functions Drizzle can't express).
 * An integration test checks these definitions against the live database columns.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Question, SurveyDefinition, ThemeTokens } from '@survey/core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export type OrgRole = 'org_admin' | 'creator' | 'analyst';
export type SurveyRole = 'owner' | 'editor' | 'viewer';
export type SurveyStatus = 'draft' | 'live' | 'closed' | 'archived';
export interface SurveyAccess {
  closesAt: string | null;
  quota: number | null;
  onePerBrowser: boolean;
  /** Phase 2A. Absent on surveys created before it (read with `readAccess`). */
  opensAt?: string | null;
  captcha?: boolean;
  /** argon2id hash; never returned by the API. */
  passwordHash?: string | null;
  /** Phase 3B: respondents must sign in as members of the survey's org (never on anonymous surveys). */
  requireLogin?: boolean;
}

/** Access settings with Phase 2A defaults filled in. */
export function readAccess(a: SurveyAccess): Required<SurveyAccess> {
  return {
    closesAt: a.closesAt ?? null,
    quota: a.quota ?? null,
    onePerBrowser: a.onePerBrowser ?? false,
    opensAt: a.opensAt ?? null,
    captcha: a.captcha ?? false,
    passwordHash: a.passwordHash ?? null,
    requireLogin: a.requireLogin ?? false,
  };
}

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: citext('slug').notNull(),
  plan: text('plan').notNull().default('free'),
  status: text('status').notNull().default('active'),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: citext('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),
  emailVerifiedAt: ts('email_verified_at'),
  lastLoginAt: ts('last_login_at'),
  disabledAt: ts('disabled_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').$type<OrgRole>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  email: citext('email').notNull(),
  role: text('role').$type<OrgRole>().notNull(),
  tokenHash: bytea('token_hash').notNull(),
  invitedBy: uuid('invited_by').notNull(),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  idHash: bytea('id_hash').primaryKey(),
  userId: uuid('user_id').notNull(),
  activeOrgId: uuid('active_org_id'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
});

export const authTokens = pgTable('auth_tokens', {
  tokenHash: bytea('token_hash').primaryKey(),
  userId: uuid('user_id').notNull(),
  purpose: text('purpose').$type<'password_reset' | 'email_verify'>().notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const surveys = pgTable('surveys', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  title: text('title').notNull(),
  publicId: text('public_id').notNull(),
  status: text('status').$type<SurveyStatus>().notNull().default('draft'),
  currentVersionId: uuid('current_version_id'),
  anonymous: boolean('anonymous').notNull().default(false),
  access: jsonb('access')
    .$type<SurveyAccess>()
    .notNull()
    .default({ closesAt: null, quota: null, onePerBrowser: false }),
  completedCount: integer('completed_count').notNull().default(0),
  closedReason: text('closed_reason').$type<'manual' | 'close_date' | 'quota'>(),
  closedAt: ts('closed_at'),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
  themeId: uuid('theme_id'),
  isTemplate: boolean('is_template').notNull().default(false),
  templateDescription: text('template_description'),
  /** Phase 3A. */
  folderId: uuid('folder_id'),
  /** Phase 3B: delete responses older than this many days (null: the org default, if any). */
  retentionDays: integer('retention_days'),
});

export const surveyVersions = pgTable('survey_versions', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  versionNumber: integer('version_number').notNull(),
  status: text('status').$type<'draft' | 'published'>().notNull(),
  definition: jsonb('definition').$type<SurveyDefinition>().notNull(),
  translations: jsonb('translations').$type<Record<string, Record<string, string>>>().notNull().default({}),
  revision: integer('revision').notNull().default(0),
  createdBy: uuid('created_by').notNull(),
  updatedBy: uuid('updated_by'),
  publishedBy: uuid('published_by'),
  publishedAt: ts('published_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const surveyCollaborators = pgTable(
  'survey_collaborators',
  {
    orgId: uuid('org_id').notNull(),
    surveyId: uuid('survey_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').$type<SurveyRole>().notNull(),
    addedBy: uuid('added_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.surveyId, t.userId] })],
);

export const distributions = pgTable('distributions', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  channel: text('channel').$type<'link' | 'embed' | 'email'>().notNull(),
  name: text('name').notNull(),
  token: text('token').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  presetHiddenFields: jsonb('preset_hidden_fields').$type<Record<string, string>>().notNull().default({}),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  disabledAt: ts('disabled_at'),
});

export const responses = pgTable('responses', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  versionId: uuid('version_id').notNull(),
  distributionId: uuid('distribution_id'),
  responseKeyHash: bytea('response_key_hash').notNull(),
  status: text('status').$type<'in_progress' | 'completed' | 'disqualified'>().notNull(),
  isTest: boolean('is_test').notNull().default(false),
  seq: integer('seq').notNull().default(0),
  currentPageKey: text('current_page_key'),
  furthestPageKey: text('furthest_page_key'),
  lastQuestionKey: text('last_question_key'),
  locale: text('locale').notNull(),
  hiddenFields: jsonb('hidden_fields').$type<Record<string, string>>().notNull().default({}),
  deviceType: text('device_type').$type<'mobile' | 'tablet' | 'desktop'>(),
  qualityFlags: text('quality_flags')
    .array()
    .notNull()
    .default(sql`'{}'`),
  startedAt: ts('started_at').notNull(),
  lastActivityAt: ts('last_activity_at').notNull(),
  completedAt: ts('completed_at'),
  durationMs: integer('duration_ms'),
  aggregatedAt: ts('aggregated_at'),
  recipientId: uuid('recipient_id'),
  respondentUserId: uuid('respondent_user_id'),
  country: text('country'),
});

export const answers = pgTable(
  'answers',
  {
    orgId: uuid('org_id').notNull(),
    surveyId: uuid('survey_id').notNull(),
    responseId: uuid('response_id').notNull(),
    questionKey: text('question_key').notNull(),
    subKey: text('sub_key').notNull().default(''),
    valueText: text('value_text'),
    valueNumber: numeric('value_number', { mode: 'number' }),
    valueChoices: text('value_choices').array(),
    valueDate: date('value_date', { mode: 'string' }),
    valueJson: jsonb('value_json'),
    otherText: text('other_text'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.surveyId, t.responseId, t.questionKey, t.subKey] })],
);

export const questionCounts = pgTable(
  'question_counts',
  {
    orgId: uuid('org_id').notNull(),
    surveyId: uuid('survey_id').notNull(),
    versionId: uuid('version_id').notNull(),
    questionKey: text('question_key').notNull(),
    subKey: text('sub_key').notNull().default(''),
    bucket: text('bucket').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.surveyId, t.versionId, t.questionKey, t.subKey, t.bucket] })],
);

export const auditLogs = pgTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid('org_id'),
  actorType: text('actor_type').$type<'user' | 'api_key' | 'system'>().notNull(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ip: inet('ip'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const themes = pgTable('themes', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  name: text('name').notNull(),
  tokens: jsonb('tokens').$type<ThemeTokens>().notNull(),
  logoFileId: uuid('logo_file_id'),
  isDefault: boolean('is_default').notNull().default(false),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const globalTemplates = pgTable('global_templates', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  category: text('category').notNull().default('general'),
  definition: jsonb('definition').$type<SurveyDefinition>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const questionBankItems = pgTable('question_bank_items', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  question: jsonb('question').$type<Question>().notNull(),
  tags: text('tags').array().notNull().default(sql`'{}'`),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'error';

export const files = pgTable('files', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  purpose: text('purpose').$type<'response_upload' | 'logo'>().notNull(),
  surveyId: uuid('survey_id'),
  responseId: uuid('response_id'),
  questionKey: text('question_key'),
  storageKey: text('storage_key').notNull(),
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  sha256: bytea('sha256').notNull(),
  scanStatus: text('scan_status').$type<ScanStatus>().notNull().default('pending'),
  scanDetail: text('scan_detail'),
  scannedAt: ts('scanned_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ── Phase 2B ───────────────────────────────────────────────────────────
export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  email: citext('email').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  attributes: jsonb('attributes').$type<Record<string, string>>().notNull().default({}),
  unsubscribedAt: ts('unsubscribed_at'),
  bouncedAt: ts('bounced_at'),
  complainedAt: ts('complained_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const contactLists = pgTable('contact_lists', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  name: text('name').notNull(),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const contactListMembers = pgTable(
  'contact_list_members',
  {
    orgId: uuid('org_id').notNull(),
    listId: uuid('list_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.contactId] })],
);

export interface ColumnMapping {
  email: string;
  firstName?: string;
  lastName?: string;
  /** CSV column -> attribute name. */
  attributes?: Record<string, string>;
}

export const contactImports = pgTable('contact_imports', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  listId: uuid('list_id'),
  storageKey: text('storage_key').notNull(),
  filename: text('filename').notNull(),
  columnMapping: jsonb('column_mapping').$type<ColumnMapping>().notNull(),
  status: text('status').$type<'queued' | 'running' | 'done' | 'failed'>().notNull().default('queued'),
  total: integer('total').notNull().default(0),
  created: integer('created').notNull().default(0),
  updated: integer('updated').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  errors: jsonb('errors').$type<{ row: number; message: string }[]>().notNull().default([]),
  errorReportKey: text('error_report_key'),
  failure: text('failure'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

export const emailSuppressions = pgTable('email_suppressions', {
  email: citext('email').primaryKey(),
  reason: text('reason').$type<'bounce' | 'complaint'>().notNull(),
  detail: text('detail'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';
export type RecipientStatus = 'pending' | 'sent' | 'failed' | 'suppressed' | 'bounced' | 'responded';

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  distributionId: uuid('distribution_id'),
  listId: uuid('list_id'),
  name: text('name').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  status: text('status').$type<CampaignStatus>().notNull().default('draft'),
  scheduledAt: ts('scheduled_at'),
  timezone: text('timezone').notNull().default('UTC'),
  reminderAfterDays: integer('reminder_after_days'),
  reminderMax: integer('reminder_max').notNull().default(0),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const recipients = pgTable('recipients', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  campaignId: uuid('campaign_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  status: text('status').$type<RecipientStatus>().notNull().default('pending'),
  sentAt: ts('sent_at'),
  lastSentAt: ts('last_sent_at'),
  remindersSent: integer('reminders_sent').notNull().default(0),
  respondedAt: ts('responded_at'),
  error: text('error'),
});

export const tags = pgTable('tags', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const responseTags = pgTable(
  'response_tags',
  {
    orgId: uuid('org_id').notNull(),
    responseId: uuid('response_id').notNull(),
    tagId: uuid('tag_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.responseId, t.tagId] })],
);

export const responseNotes = pgTable('response_notes', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  responseId: uuid('response_id').notNull(),
  authorId: uuid('author_id'),
  body: text('body').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';
/** What to export: the CSV endpoint's options plus a results filter. */
export interface ExportOptions {
  layout?: 'compact' | 'expanded';
  status?: 'completed' | 'all';
  includeTest?: boolean;
  excludeFlagged?: boolean;
  from?: string;
  to?: string;
  versionId?: string;
  filter?: unknown;
}

export const dataExports = pgTable('exports', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  requestedBy: uuid('requested_by'),
  format: text('format').$type<ExportFormat>().notNull(),
  options: jsonb('options').$type<ExportOptions>().notNull().default({}),
  status: text('status').$type<'queued' | 'running' | 'done' | 'failed'>().notNull().default('queued'),
  storageKey: text('storage_key'),
  filename: text('filename'),
  size: integer('size'),
  rowCount: integer('row_count'),
  failure: text('failure'),
  createdAt: ts('created_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  expiresAt: ts('expires_at'),
});

export const scheduledReports = pgTable('scheduled_reports', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  name: text('name').notNull(),
  frequency: text('frequency').$type<'daily' | 'weekly' | 'monthly'>().notNull(),
  day: integer('day'),
  hour: integer('hour').notNull(),
  timezone: text('timezone').notNull(),
  format: text('format').$type<ExportFormat>().notNull(),
  options: jsonb('options').$type<ExportOptions>().notNull().default({}),
  recipientIds: uuid('recipient_ids').array().notNull(),
  active: boolean('active').notNull().default(true),
  nextRunAt: ts('next_run_at').notNull(),
  lastRunAt: ts('last_run_at'),
  lastStatus: text('last_status'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ── Phase 3A: collaboration and the platform API ────────────────────────────
export const folders = pgTable('folders', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  parentId: uuid('parent_id'),
  name: text('name').notNull(),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    orgId: uuid('org_id').notNull(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const surveyTeamCollaborators = pgTable(
  'survey_team_collaborators',
  {
    orgId: uuid('org_id').notNull(),
    surveyId: uuid('survey_id').notNull(),
    teamId: uuid('team_id').notNull(),
    role: text('role').$type<'editor' | 'viewer'>().notNull(),
    addedBy: uuid('added_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.surveyId, t.teamId] })],
);

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  anchorKey: text('anchor_key'),
  parentId: uuid('parent_id'),
  authorId: uuid('author_id'),
  body: text('body').notNull(),
  resolvedAt: ts('resolved_at'),
  resolvedBy: uuid('resolved_by'),
  editedAt: ts('edited_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'superseded' | 'cancelled';
export const approvalRequests = pgTable('approval_requests', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  versionId: uuid('version_id'),
  revision: integer('revision').notNull(),
  status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
  requestedBy: uuid('requested_by').notNull(),
  requestNote: text('request_note'),
  decidedBy: uuid('decided_by'),
  decisionNote: text('decision_note'),
  decidedAt: ts('decided_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type NotificationKind = 'new_response' | 'nps_detractor' | 'threshold' | 'closing';
export type NotificationChannel = 'email' | 'in_app' | 'slack';
export interface NotificationRuleConfig {
  /** nps_detractor: the NPS question to watch. */
  questionKey?: string;
  /** threshold: fire once when this many responses are complete. */
  count?: number;
}
export const notificationRules = pgTable('notification_rules', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  kind: text('kind').$type<NotificationKind>().notNull(),
  config: jsonb('config').$type<NotificationRuleConfig>().notNull().default({}),
  channels: text('channels').array().$type<NotificationChannel[]>().notNull(),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const notificationFirings = pgTable(
  'notification_firings',
  {
    orgId: uuid('org_id').notNull(),
    ruleId: uuid('rule_id').notNull(),
    eventId: text('event_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.eventId] })],
);

/** kind → the channels a user accepts for it. A kind that's absent accepts every channel. */
export type NotificationPreferenceMap = Partial<Record<NotificationKind, ('email' | 'in_app')[]>>;
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    channels: jsonb('channels').$type<NotificationPreferenceMap>().notNull().default({}),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  userId: uuid('user_id').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  link: text('link'),
  surveyId: uuid('survey_id'),
  inApp: boolean('in_app').notNull().default(true),
  email: boolean('email').notNull().default(false),
  emailedAt: ts('emailed_at'),
  readAt: ts('read_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  keyHash: bytea('key_hash').notNull(),
  scopes: text('scopes').array().notNull(),
  createdBy: uuid('created_by').notNull(),
  lastUsedAt: ts('last_used_at'),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    orgId: uuid('org_id').notNull(),
    key: text('key').notNull(),
    requestHash: bytea('request_hash').notNull(),
    status: text('status').$type<'processing' | 'done'>().notNull().default('processing'),
    statusCode: integer('status_code'),
    contentType: text('content_type'),
    response: text('response'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })],
);

export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  url: text('url').notNull(),
  description: text('description'),
  events: text('events').array().notNull(),
  surveyIds: uuid('survey_ids').array(),
  secretEnc: text('secret_enc').notNull(),
  previousSecretEnc: text('previous_secret_enc'),
  previousSecretExpiresAt: ts('previous_secret_expires_at'),
  active: boolean('active').notNull().default(true),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  disabledReason: text('disabled_reason'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export type DeliveryStatus = 'pending' | 'succeeded' | 'failed';
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  webhookId: uuid('webhook_id').notNull(),
  eventId: text('event_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<DeliveryStatus>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastHttpStatus: integer('last_http_status'),
  nextAttemptAt: ts('next_attempt_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

export const webhookAttempts = pgTable('webhook_attempts', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid('org_id').notNull(),
  deliveryId: uuid('delivery_id').notNull(),
  attempt: integer('attempt').notNull(),
  manual: boolean('manual').notNull().default(false),
  httpStatus: integer('http_status'),
  error: text('error'),
  durationMs: integer('duration_ms').notNull(),
  responseSnippet: text('response_snippet'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type IntegrationKind = 'slack' | 'hubspot' | 'google_sheets';
export const integrations = pgTable(
  'integrations',
  {
    orgId: uuid('org_id').notNull(),
    kind: text('kind').$type<IntegrationKind>().notNull(),
    configEnc: text('config_enc').notNull(),
    summary: jsonb('summary').$type<Record<string, string>>().notNull().default({}),
    status: text('status').$type<'connected' | 'error'>().notNull().default('connected'),
    lastError: text('last_error'),
    updatedBy: uuid('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.kind] })],
);

// ── Phase 3B ─────────────────────────────────────────────────────────────
export const ssoConnections = pgTable('sso_connections', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  protocol: text('protocol').$type<'oidc' | 'saml'>().notNull(),
  name: text('name').notNull(),
  configEnc: text('config_enc').notNull(),
  summary: jsonb('summary').$type<Record<string, string>>().notNull().default({}),
  defaultRole: text('default_role').$type<'creator' | 'analyst'>().notNull().default('creator'),
  enabled: boolean('enabled').notNull().default(true),
  lastLoginAt: ts('last_login_at'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const ssoDomains = pgTable(
  'sso_domains',
  {
    orgId: uuid('org_id').notNull(),
    domain: citext('domain').notNull(),
    verificationToken: text('verification_token').notNull(),
    verifiedAt: ts('verified_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.domain] })],
);

export const ssoIdentities = pgTable(
  'sso_identities',
  {
    orgId: uuid('org_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id').notNull(),
    email: citext('email').notNull(),
    lastLoginAt: ts('last_login_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.subject] })],
);

export interface InsightTheme {
  label: string;
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  count: number;
  responseIds: string[];
}
export const textInsights = pgTable('text_insights', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  surveyId: uuid('survey_id').notNull(),
  questionKey: text('question_key').notNull(),
  status: text('status').$type<'pending' | 'done' | 'failed'>().notNull().default('pending'),
  errorCode: text('error_code'),
  provider: text('provider'),
  model: text('model'),
  responsesAnalysed: integer('responses_analysed').notNull().default(0),
  responsesTotal: integer('responses_total').notNull().default(0),
  summary: text('summary'),
  themes: jsonb('themes').$type<InsightTheme[]>().notNull().default([]),
  sentiment: jsonb('sentiment').$type<{ positive: number; neutral: number; negative: number }>(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  requestedBy: uuid('requested_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  generatedAt: ts('generated_at'),
});

export const orgUsageMonthly = pgTable(
  'org_usage_monthly',
  {
    orgId: uuid('org_id').notNull(),
    month: date('month', { mode: 'string' }).notNull(),
    responses: integer('responses').notNull().default(0),
    surveysPublished: integer('surveys_published').notNull().default(0),
    emailsSent: integer('emails_sent').notNull().default(0),
    aiTokens: integer('ai_tokens').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.month] })],
);

export const privacyRequests = pgTable('privacy_requests', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  kind: text('kind').$type<'export' | 'erase'>().notNull(),
  subjectEmail: citext('subject_email').notNull(),
  status: text('status').$type<'pending' | 'done' | 'failed'>().notNull().default('pending'),
  result: jsonb('result').$type<Record<string, number>>().notNull().default({}),
  storageKey: text('storage_key'),
  filename: text('filename'),
  size: integer('size'),
  expiresAt: ts('expires_at'),
  failure: text('failure'),
  requestedBy: uuid('requested_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
});

export const tables = {
  ssoConnections,
  ssoDomains,
  ssoIdentities,
  textInsights,
  orgUsageMonthly,
  privacyRequests,
  folders,
  teams,
  teamMembers,
  surveyTeamCollaborators,
  comments,
  approvalRequests,
  notificationRules,
  notificationFirings,
  notificationPreferences,
  notifications,
  apiKeys,
  idempotencyKeys,
  webhooks,
  webhookDeliveries,
  webhookAttempts,
  integrations,
  contacts,
  contactLists,
  contactListMembers,
  contactImports,
  emailSuppressions,
  campaigns,
  recipients,
  tags,
  responseTags,
  responseNotes,
  dataExports,
  scheduledReports,
  themes,
  globalTemplates,
  questionBankItems,
  files,
  organizations,
  users,
  memberships,
  invitations,
  sessions,
  authTokens,
  surveys,
  surveyVersions,
  surveyCollaborators,
  distributions,
  responses,
  answers,
  questionCounts,
  auditLogs,
};
