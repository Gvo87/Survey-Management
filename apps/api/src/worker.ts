import { ALL_QUEUES, QUEUES } from '@survey/db';
import { loadConfig } from './config';
import { closeDeps, createDeps } from './deps';
import { createJobHandlers } from './jobs/handlers';
import { captureError, initSentry } from './lib/sentry';

const config = loadConfig();
await initSentry(config.sentryDsn, config.env);
const deps = await createDeps(config, { worker: true });
const handlers = createJobHandlers(deps);
const boss = deps.jobs.boss;

for (const name of ALL_QUEUES) {
  await boss.work(name, async (jobs) => {
    for (const job of jobs) {
      try {
        await (handlers[name] as (data: unknown) => Promise<void>)(job.data);
      } catch (error) {
        captureError(error, { queue: name, jobId: job.id });
        throw error; // pg-boss retries with backoff
      }
    }
  });
}

await boss.schedule(QUEUES.closeExpiredSurveys, '*/5 * * * *');
await boss.schedule(QUEUES.nightlyAggregates, '15 3 * * *');
await boss.schedule(QUEUES.cleanupSessions, '30 4 * * *');

console.log(`[worker] processing ${ALL_QUEUES.length} queues`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[worker] shutting down');
  await closeDeps(deps);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
