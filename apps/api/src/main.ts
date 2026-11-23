import { buildApp } from './app';
import { loadConfig } from './config';
import { closeDeps, createDeps } from './deps';
import { initSentry } from './lib/sentry';

const config = loadConfig();
await initSentry(config.sentryDsn, config.env);
const deps = await createDeps(config, { worker: false });
const app = await buildApp(deps);

await app.listen({ port: config.port, host: '0.0.0.0' });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeDeps(deps);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
