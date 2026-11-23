/**
 * Analytics performance check (acceptance criteria: on a 50k-response survey, the unfiltered
 * summary returns in < 1 s and a filtered summary in < 5 s at p95; Phase 2B: answer filters with up
 * to 4 segments in < 5 s at p95, and a 50k-response XLSX export in < 2 minutes).
 *
 * Prerequisite: `pnpm db:seed:large`. Runs the API in-process against the dev database and
 * writes a report to perf/results-summary.md at the repo root.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEV_PASSWORD } from '@survey/db/dev';
import { eq } from 'drizzle-orm';
import { findRepoRoot, surveys, withTenant } from '@survey/db';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { closeDeps, createDeps } from '../src/deps';
import { buildExportFile } from '../src/jobs/exports';

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

const csrf = login.json().csrfToken as string;

async function measure(label: string, url: string, body?: unknown) {
  const times: number[] = [];
  let source = '';
  for (let i = 0; i < RUNS + 2; i++) {
    const start = performance.now();
    const res = await app.inject(
      body
        ? { method: 'POST', url, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: JSON.stringify(body) }
        : { method: 'GET', url, headers: { cookie } },
    );
    const ms = performance.now() - start;
    if (res.statusCode !== 200) throw new Error(`${label}: HTTP ${res.statusCode} ${res.body}`);
    source = res.json().source ?? res.json().overall?.source ?? '';
    if (i >= 2) times.push(ms); // first two runs warm caches and connections
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!;
  return { label, source, p50: pct(50), p95: pct(95), max: times.at(-1)! };
}

const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
const base = `/api/v1/surveys/${survey.id}/results/summary`;
// Phase 2B: answer filters and segments on the seeded NPS questions.
const version = (await app.inject({ method: 'GET', url: `/api/v1/surveys/${survey.id}/versions`, headers: { cookie } })).json()[0];
const definition = (await app.inject({ method: 'GET', url: `/api/v1/surveys/${survey.id}/versions/${version.id}`, headers: { cookie } })).json().definition;
const questions = definition.pages.flatMap((p: { elements: { kind: string; key: string; type: string; options?: { key: string }[] }[] }) => p.elements);
const nps = questions.find((q: { type: string }) => q.type === 'nps');
const plan = questions.find((q: { type: string }) => q.type === 'single_choice');
const query = `/api/v1/surveys/${survey.id}/results/query`;
const planIs = (i: number) => ({ question: plan.key, op: 'eq', value: plan.options[i].key });
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
  {
    ...(await measure('Answer filter (NPS 0-6 AND plan)', query, { filter: { all: [{ question: nps.key, op: 'lte', value: 6 }, planIs(0)] } })),
    target: 5000,
  },
  {
    ...(await measure('4 segments side by side (by plan)', query, {
      segments: [0, 1, 2, 3].map((i) => ({ name: `Plan ${i + 1}`, filter: planIs(i) })),
    })),
    target: 5000,
  },
];

// Phase 2B: a full XLSX export of every completed response, as the export job builds it.
const xlsxStart = performance.now();
const orgId = login.json().activeOrg.id as string;
const [rowSurvey] = await withTenant(deps.pool, orgId, (tx) => tx.db.select().from(surveys).where(eq(surveys.id, survey.id)));
const file = await buildExportFile(deps, orgId, rowSurvey!, 'xlsx', {});
const xlsxMs = performance.now() - xlsxStart;
const xlsxRow = `| XLSX export of ${file.rowCount.toLocaleString('en-US')} responses (${(file.buffer.length / 1024 / 1024).toFixed(1)} MB) | worker | ${(xlsxMs / 1000).toFixed(1)} s | - | - | < 120 s | ${xlsxMs < 120_000 ? 'PASS' : 'FAIL'} |`;

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
${xlsxRow}
`;

const dir = resolve(findRepoRoot(), 'perf');
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'results-summary.md'), report);
console.log(report);

await app.close();
await closeDeps(deps);
process.exit(results.every((r) => r.p95 < r.target) && xlsxMs < 120_000 ? 0 : 1);
