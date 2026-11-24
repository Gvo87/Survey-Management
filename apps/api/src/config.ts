import { createHash, hkdfSync } from 'node:crypto';
import { loadRootEnv } from '@survey/db';
import type { S3Settings } from './infra/storage';
import { DEFAULT_OPENAI_MODEL } from './ai/openai';

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  appUrl: string;
  respondentUrl: string;
  sessionSecret: string;
  cookieSecure: boolean;
  signupMode: 'open' | 'invite_only';
  /** New organizations per IP hash per hour. Strict in production; lenient where tests create many orgs. */
  signupsPerHour: number;
  smtpUrl: string;
  emailFrom: string;
  emailTransport: 'smtp' | 'memory';
  sentryDsn: string | null;
  storage: 's3' | 'memory';
  s3: S3Settings & { createBucket: boolean };
  scanner: 'clamav' | 'disabled' | 'fake';
  clamav: { host: string; port: number };
  captcha: 'turnstile' | 'fake';
  turnstile: { siteKey: string | null; secretKey: string | null };
  /** Phase 2B: campaign emails per org per rolling 24 h (deliverability protection). */
  emailsPerOrgPerDay: number;
  /** SNS topic ARNs allowed to post SES bounce/complaint notifications. Empty disables the endpoint. */
  sesTopicArns: string[];
  /** Anonymous surveys: filtered results for fewer responses than this are hidden. */
  minGroupSize: number;
  /** Phase 3A: AES-256 key for secrets the app must read back (webhook secrets, integration tokens). */
  encryptionKey: Buffer;
  /**
   * Phase 3A: let webhooks and integrations call private and loopback addresses. Only for local
   * development and tests: in production every outgoing call is checked against private ranges (SSRF).
   */
  allowPrivateUrls: boolean;
  /** Phase 3A: requests per minute per API key. */
  apiKeyRequestsPerMinute: number;
  /**
   * Phase 3B: AI summaries. `openai` needs OPENAI_API_KEY; `fake` is a deterministic stand-in (tests, demos);
   * null when nothing is configured, and the feature shows as unavailable.
   */
  ai: {
    provider: 'openai' | 'fake' | null;
    openaiApiKey: string | null;
    openaiModel: string;
    openaiBaseUrl: string;
    /** Tokens per org per calendar month (UTC), unless a super admin sets another cap. */
    defaultMonthlyTokenCap: number;
    /** Most recent answers sent per summary. */
    maxAnswers: number;
  };
  /**
   * Phase 3B: how SSO email domains are verified. `dns` (a TXT record) everywhere by default; `auto` verifies on
   * adding, for local development and end-to-end tests only (refused in production).
   */
  ssoDomainVerification: 'dns' | 'auto';
}

/**
 * DATA_ENCRYPTION_KEY is required in production. Elsewhere it falls back to a key derived from
 * SESSION_SECRET, so existing .env files keep working.
 */
function encryptionKeyFrom(raw: string | null, sessionSecret: string, env: Config['env']): Buffer {
  if (raw) return createHash('sha256').update(raw).digest();
  if (env === 'production') throw new Error('DATA_ENCRYPTION_KEY must be set in production');
  return Buffer.from(hkdfSync('sha256', sessionSecret, 'survey-data-key', 'aes-256-gcm', 32));
}

/** AI_PROVIDER=openai|fake|none; unset means OpenAI when a key is configured. */
function aiProviderFrom(raw: string | null, apiKey: string | null): Config['ai']['provider'] {
  if (raw === 'fake') return 'fake';
  if (raw === 'none') return null;
  return apiKey ? 'openai' : null;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadRootEnv();
  const env = (process.env.NODE_ENV as Config['env']) ?? 'development';
  const get = (name: string, fallback?: string): string => {
    const value = process.env[name] ?? fallback;
    if (value === undefined || value === '')
      throw new Error(`Missing environment variable ${name} (see .env.example)`);
    return value;
  };
  const opt = (name: string) => process.env[name] || null;

  const config: Config = {
    env,
    port: Number(get('API_PORT', '3000')),
    logLevel: get('LOG_LEVEL', 'info'),
    databaseUrl: get('DATABASE_URL'),
    redisUrl: get('REDIS_URL'),
    appUrl: get('APP_URL', 'http://localhost:5173').replace(/\/$/, ''),
    respondentUrl: get('RESPONDENT_URL', 'http://localhost:5174').replace(/\/$/, ''),
    sessionSecret: get('SESSION_SECRET'),
    cookieSecure: get('COOKIE_SECURE', env === 'production' ? 'true' : 'false') === 'true',
    signupMode: get('SIGNUP_MODE', 'open') === 'invite_only' ? 'invite_only' : 'open',
    signupsPerHour: Number(get('SIGNUPS_PER_HOUR', env === 'production' ? '20' : '500')),
    smtpUrl: get('SMTP_URL', 'smtp://localhost:1025'),
    emailFrom: get('EMAIL_FROM', 'Survey Platform <no-reply@survey.local>'),
    emailTransport: 'smtp',
    sentryDsn: opt('SENTRY_DSN'),
    storage: 's3',
    s3: {
      endpoint: opt('S3_ENDPOINT'),
      region: get('S3_REGION', 'us-east-1'),
      bucket: get('S3_BUCKET', 'survey-files'),
      accessKey: get('S3_ACCESS_KEY', 'survey'),
      secretKey: get('S3_SECRET_KEY', 'survey-dev-secret'),
      forcePathStyle: get('S3_FORCE_PATH_STYLE', 'false') === 'true',
      createBucket: get('S3_CREATE_BUCKET', 'false') === 'true',
    },
    scanner: get('MALWARE_SCANNER', env === 'production' ? 'clamav' : 'disabled') === 'clamav' ? 'clamav' : 'disabled',
    clamav: { host: get('CLAMAV_HOST', 'localhost'), port: Number(get('CLAMAV_PORT', '3310')) },
    captcha: 'turnstile',
    turnstile: { siteKey: opt('TURNSTILE_SITE_KEY'), secretKey: opt('TURNSTILE_SECRET_KEY') },
    emailsPerOrgPerDay: Number(get('EMAILS_PER_ORG_PER_DAY', '10000')),
    sesTopicArns: (opt('SES_SNS_TOPIC_ARNS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    minGroupSize: Number(get('ANONYMOUS_MIN_GROUP_SIZE', '5')),
    encryptionKey: Buffer.alloc(0),
    allowPrivateUrls: get('ALLOW_PRIVATE_WEBHOOK_URLS', env === 'development' ? 'true' : 'false') === 'true',
    apiKeyRequestsPerMinute: Number(get('API_KEY_REQUESTS_PER_MINUTE', '600')),
    ai: {
      provider: aiProviderFrom(opt('AI_PROVIDER'), opt('OPENAI_API_KEY')),
      openaiApiKey: opt('OPENAI_API_KEY'),
      openaiModel: get('OPENAI_MODEL', DEFAULT_OPENAI_MODEL),
      openaiBaseUrl: get('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
      defaultMonthlyTokenCap: Number(get('AI_MONTHLY_TOKEN_CAP', '500000')),
      maxAnswers: Number(get('AI_MAX_ANSWERS', '400')),
    },
    ssoDomainVerification: get('SSO_DOMAIN_VERIFICATION', 'dns') === 'auto' ? 'auto' : 'dns',
    ...overrides,
  };
  if (!overrides.encryptionKey)
    config.encryptionKey = encryptionKeyFrom(opt('DATA_ENCRYPTION_KEY'), config.sessionSecret, env);

  if (config.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  if (config.env === 'production') {
    if (!config.cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
    if (config.scanner !== 'clamav') throw new Error('MALWARE_SCANNER must be clamav in production: uploads must be scanned');
    if (config.allowPrivateUrls) throw new Error('ALLOW_PRIVATE_WEBHOOK_URLS must not be true in production');
    if (config.ssoDomainVerification === 'auto') throw new Error('SSO_DOMAIN_VERIFICATION=auto is for development only');
    if (config.ai.provider === 'fake') throw new Error('AI_PROVIDER=fake is for development and tests only');
  }
  return config;
}
