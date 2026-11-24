import { Redis } from 'ioredis';
import { createPool, type Pool } from '@survey/db';
import type { Config } from './config';
import { createTurnstileVerifier, fakeCaptcha, type CaptchaVerifier } from './infra/captcha';
import { Jobs } from './infra/jobs';
import { createMailer, type Mailer } from './infra/mailer';
import { createClamAvScanner, disabledScanner, fakeScanner, type MalwareScanner } from './infra/scanner';
import { createSnsVerifier, type SnsVerifier } from './infra/sns';
import { createMemoryStorage, createS3Storage, type ObjectStorage } from './infra/storage';
import { resolveTxt } from 'node:dns/promises';
import { fakeAiProvider } from './ai/fake';
import { createOpenAiProvider } from './ai/openai';
import type { AiProvider } from './ai/provider';

/** Everything the HTTP app and the worker need, created once per process. */
export interface Deps {
  config: Config;
  pool: Pool;
  redis: Redis;
  jobs: Jobs;
  mailer: Mailer;
  storage: ObjectStorage;
  scanner: MalwareScanner;
  captcha: CaptchaVerifier;
  /** SES bounce/complaint notifications arrive through SNS. Replaceable in tests. */
  sns: SnsVerifier;
  /** Phase 3B: the AI provider for text summaries, or null when none is configured. Replaceable in tests. */
  ai: AiProvider | null;
  /** Phase 3B: DNS TXT lookups for SSO domain verification. Replaceable in tests. */
  dns: { resolveTxt(name: string): Promise<string[][]> };
}

export function createAiProvider(config: Config): AiProvider | null {
  if (config.ai.provider === 'fake') return fakeAiProvider;
  if (config.ai.provider === 'openai' && config.ai.openaiApiKey)
    return createOpenAiProvider({ apiKey: config.ai.openaiApiKey, model: config.ai.openaiModel, baseUrl: config.ai.openaiBaseUrl });
  return null;
}

export async function createDeps(config: Config, opts: { worker: boolean }): Promise<Deps> {
  const pool = createPool(config.databaseUrl, opts.worker ? 5 : 20);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
  redis.on('error', (error) => console.error('[redis]', error.message));
  const jobs = await Jobs.start(config.databaseUrl, opts);
  const mailer = createMailer(config.emailTransport, config.smtpUrl, config.emailFrom);
  const storage = config.storage === 'memory' ? createMemoryStorage() : createS3Storage(config.s3);
  if (config.storage === 's3' && config.s3.createBucket) {
    await storage.ensureBucket().catch((e: Error) => console.error('[storage] could not create bucket:', e.message));
  }
  const scanner =
    config.scanner === 'clamav' ? createClamAvScanner(config.clamav.host, config.clamav.port) : config.scanner === 'fake' ? fakeScanner : disabledScanner;
  const captcha = config.captcha === 'fake' ? fakeCaptcha : createTurnstileVerifier(config.turnstile.siteKey, config.turnstile.secretKey);
  return { config, pool, redis, jobs, mailer, storage, scanner, captcha, sns: createSnsVerifier(), ai: createAiProvider(config), dns: { resolveTxt } };
}

export async function closeDeps(deps: Deps): Promise<void> {
  await deps.jobs.stop().catch(() => {});
  deps.redis.disconnect();
  await deps.pool.end();
}
