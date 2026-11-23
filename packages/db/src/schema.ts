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

export const tables = {
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
