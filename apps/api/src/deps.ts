import { Redis } from 'ioredis';
import { createPool, type Pool } from '@survey/db';
import type { Config } from './config';
import { Jobs } from './infra/jobs';
import { createMailer, type Mailer } from './infra/mailer';

/** Everything the HTTP app and the worker need, created once per process. */
export interface Deps {
  config: Config;
  pool: Pool;
  redis: Redis;
  jobs: Jobs;
  mailer: Mailer;
}

export async function createDeps(config: Config, opts: { worker: boolean }): Promise<Deps> {
  const pool = createPool(config.databaseUrl, opts.worker ? 5 : 20);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
  redis.on('error', (error) => console.error('[redis]', error.message));
  const jobs = await Jobs.start(config.databaseUrl, opts);
  const mailer = createMailer(config.emailTransport, config.smtpUrl, config.emailFrom);
  return { config, pool, redis, jobs, mailer };
}

export async function closeDeps(deps: Deps): Promise<void> {
  await deps.jobs.stop().catch(() => {});
  deps.redis.disconnect();
  await deps.pool.end();
}
