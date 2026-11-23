import { loadRootEnv } from '@survey/db';

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
    sentryDsn: process.env.SENTRY_DSN || null,
    ...overrides,
  };

  if (config.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  if (config.env === 'production' && !config.cookieSecure)
    throw new Error('COOKIE_SECURE must be true in production');
  return config;
}
