/**
 * Analytics performance check (acceptance criterion: on a 50k-response survey, the unfiltered
 * summary returns in < 1 s and a filtered summary in < 5 s at p95).
 *
 * Prerequisite: `pnpm db:seed:large`. Runs the API in-process against the dev database and
 * writes a report to perf/results-summary.md at the repo root.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEV_PASSWORD } from '@survey/db/dev';
import { findRepoRoot } from '@survey/db';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { closeDeps, createDeps } from '../src/deps';

const RUNS = 20;
const config = loadConfig({ logLevel: 'warn', emailTransport: 'memory' });
const deps = await createDeps(config, { worker: false });
const app = await buildApp(deps, { logger: false });

const login = await app.inject({
  method: 'POST',
  url: '/api/v1/auth/login',
  payload: { email: 'admin@acme.test', password: DEV_PASSWORD },
});
if (login.statusCode !== 200)
  throw new Error(`Login failed (${login.statusCode}). Did you run pnpm db:seed:large?`);
const cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;

const list = await app.inject({ method: 'GET', url: '/api/v1/surveys?q=Large&limit=1', headers: { cookie } });
const survey = list.json().data[0];
if (!survey) throw new Error('Large survey not found. Run pnpm db:seed:large first.');
const detail = (
  await app.inject({ method: 'GET', url: `/api/v1/surveys/${survey.id}`, headers: { cookie } })
).json();

async function measure(label: string, url: string) {
  const times: number[] = [];
  let source = '';
  for (let i = 0; i < RUNS + 2; i++) {
    const start = performance.now();
    const res = await app.inject({ method: 'GET', url, headers: { cookie } });
    const ms = performance.now() - start;
    if (res.statusCode !== 200) throw new Error(`${label}: HTTP ${res.statusCode} ${res.body}`);
    source = res.json().source;
    if (i >= 2) times.push(ms); // first two runs warm caches and connections
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!;
  return { label, source, p50: pct(50), p95: pct(95), max: times.at(-1)! };
}

const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
const base = `/api/v1/surveys/${survey.id}/results/summary`;
const results = [
  { ...(await measure('Unfiltered summary', base)), target: 1000 },
  {
    ...(await measure('Date-filtered summary (last 14 days)', `${base}?from=${encodeURIComponent(since)}`)),
    target: 5000,
  },
  {
    ...(await measure(
      'Filtered incl. partial responses',
      `${base}?from=2000-01-01T00:00:00Z&includePartial=true`,
    )),
    target: 5000,
  },
];

const rows = results
  .map(
    (r) =>
      `| ${r.label} | ${r.source} | ${r.p50.toFixed(0)} ms | ${r.p95.toFixed(0)} ms | ${r.max.toFixed(0)} ms | < ${r.target} ms | ${r.p95 < r.target ? 'PASS' : 'FAIL'} |`,
  )
  .join('\n');
const report = `# Analytics performance report

Generated ${new Date().toISOString()} by \`pnpm perf:results\` against the local Docker database.

- Survey: "${survey.title}": ${detail.responseCount.toLocaleString('en-US')} responses (${survey.completedCount.toLocaleString('en-US')} completed)
- ${RUNS} measured requests per scenario (after 2 warm-up requests), in-process HTTP (no network)
- Machine: ${process.platform} ${process.arch}, Node ${process.version}

| Scenario | Source | p50 | p95 | max | Target (p95) | Result |
|---|---|---|---|---|---|---|
${rows}
`;

const dir = resolve(findRepoRoot(), 'perf');
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'results-summary.md'), report);
console.log(report);

await app.close();
await closeDeps(deps);
process.exit(results.every((r) => r.p95 < r.target) ? 0 : 1);
