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

export const tables = {
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
