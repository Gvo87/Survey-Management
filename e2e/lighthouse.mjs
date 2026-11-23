// Respondent performance budget (docs/01-architecture.md §1.8): a 15-question survey must reach
// Largest Contentful Paint in < 2 s on Lighthouse's mobile profile (simulated slow 4G, 4x CPU).
//
// Prerequisites: the API is running (`pnpm dev` or `pnpm --filter @survey/api dev`).
// This script builds the respondent app, serves the production build on :4174, creates a
// survey through the API, runs Lighthouse with Playwright's Chromium, and writes
// perf/lighthouse-respondent.md.
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://localhost:3000';
const PREVIEW = 'http://localhost:4174';
const BUDGET_MS = 2000;

// 1. A 15-question survey, created through the API.
let cookie = '';
async function api(method, path, body, headers = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
const me = await api('POST', '/auth/signup', {
  name: 'Perf',
  email: `perf.${Date.now()}@example.com`,
  password: 'perf-password-123',
  orgName: 'Perf',
});
const csrf = { 'x-csrf-token': me.csrfToken };
const survey = await api('POST', '/surveys', { title: 'Performance check: 15 questions' }, csrf);
const draft = await api('GET', `/surveys/${survey.id}/draft`);
const types = ['single_choice', 'nps', 'rating', 'short_text', 'multi_choice'];
const question = (i) => {
  const type = types[i % types.length];
  const key = `q_perf${String(i).padStart(5, '0')}`;
  const options = ['Excellent', 'Good', 'Fair', 'Poor'].map((label, j) => ({
    key: `o_perf${i}${j}000`.slice(0, 11).padEnd(8, '0'),
    label,
  }));
  const base = {
    kind: 'question',
    key,
    type,
    title: `Question ${i + 1}: how would you describe your experience?`,
    required: false,
  };
  if (type === 'single_choice' || type === 'multi_choice')
    return { ...base, options, config: { randomize: false } };
  if (type === 'nps') return { ...base, config: { lowLabel: 'Not likely', highLabel: 'Very likely' } };
  if (type === 'rating') return { ...base, config: { scale: 5, icon: 'star' } };
  return { ...base, config: { maxLength: 255 } };
};
const definition = {
  ...draft.definition,
  pages: [
    {
      key: 'p_perf00001',
      title: 'About your visit',
      elements: Array.from({ length: 8 }, (_, i) => question(i)),
    },
    { key: 'p_perf00002', elements: Array.from({ length: 7 }, (_, i) => question(i + 8)) },
  ],
};
const saved = await api(
  'PUT',
  `/surveys/${survey.id}/draft`,
  { definition },
  { ...csrf, 'if-match': `"rev-${draft.revision}"` },
);
const published = await api('POST', `/surveys/${survey.id}/publish`, { revision: saved.revision }, csrf);
const url = `${PREVIEW}/s/${new URL(published.publicUrl).pathname.split('/').pop()}`;

// 2. Production build served by `vite preview` (proxies /r to the API).
console.log('[lighthouse] building respondent app…');
execSync('pnpm --filter @survey/respondent build', { cwd: root, stdio: 'inherit' });
const server = spawn(
  'pnpm',
  ['--filter', '@survey/respondent', 'exec', 'vite', 'preview', '--port', '4174', '--strictPort'],
  {
    cwd: root,
    shell: true,
    stdio: 'ignore',
  },
);
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(PREVIEW)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 500));
}

// 3. Lighthouse, mobile profile (simulated throttling), three runs, median LCP.
const chrome = await chromeLauncher.launch({
  chromePath: chromium.executablePath(),
  chromeFlags: ['--headless=new'],
});
const runs = [];
try {
  for (let i = 0; i < 3; i++) {
    const result = await lighthouse(url, {
      port: chrome.port,
      onlyCategories: ['performance'],
      logLevel: 'error',
    });
    const a = result.lhr.audits;
    runs.push({
      lcp: a['largest-contentful-paint'].numericValue,
      fcp: a['first-contentful-paint'].numericValue,
      tbt: a['total-blocking-time'].numericValue,
      score: result.lhr.categories.performance.score * 100,
    });
  }
} finally {
  await chrome.kill();
  server.kill();
  if (process.platform === 'win32') {
    try {
      execSync(
        `for /f "tokens=5" %a in ('netstat -aon ^| findstr :4174 ^| findstr LISTENING') do taskkill /F /PID %a`,
        { stdio: 'ignore', shell: 'cmd.exe' },
      );
    } catch {
      // already stopped
    }
  }
}

const median = (key) => [...runs].sort((x, y) => x[key] - y[key])[1][key];
const lcp = median('lcp');
const pass = lcp < BUDGET_MS;
const report = `# Respondent page performance (Lighthouse)

Generated ${new Date().toISOString()} by \`pnpm --filter @survey/e2e lighthouse\`.

- Page: a published 15-question survey (2 pages), production build served by \`vite preview\`, API on localhost
- Profile: Lighthouse mobile defaults: simulated throttling (150 ms RTT, 1.6 Mbps down, 4x CPU slowdown)
- 3 runs, median shown

| Metric | Median | Budget | Result |
|---|---|---|---|
| Largest Contentful Paint | ${Math.round(lcp)} ms | < ${BUDGET_MS} ms | ${pass ? 'PASS' : 'FAIL'} |
| First Contentful Paint | ${Math.round(median('fcp'))} ms | - | - |
| Total Blocking Time | ${Math.round(median('tbt'))} ms | - | - |
| Performance score | ${Math.round(median('score'))} | - | - |

Note: the API runs on the same machine, so server latency is near zero; simulated throttling still applies
network round-trips to every request, including the survey fetch.
`;
mkdirSync(resolve(root, 'perf'), { recursive: true });
writeFileSync(resolve(root, 'perf', 'lighthouse-respondent.md'), report);
console.log(report);
process.exit(pass ? 0 : 1);
