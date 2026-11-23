/**
 * Phase 2A end to end: logic (shared vectors in the browser and through the real respondent UI),
 * piping that can't inject HTML, file uploads to the admin's download, themes, the stacked matrix
 * on phones, and accessibility of the new question types.
 *
 * CAPTCHA is covered by the API integration tests (with a fake verifier): the real Turnstile
 * widget needs Cloudflare's servers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { publishViaApi, RESPONDENT } from './helpers';

const VECTORS_PATH = path.join(__dirname, '../../packages/survey-core/test-vectors/logic.json');
const CORE_PATH = path.join(__dirname, '../../packages/survey-core/src/index.ts').replace(/\\/g, '/');
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
  definition: object;
  cases: { name: string; hidden?: Record<string, string>; answers: Record<string, unknown>; expect: { ok: boolean; outcome: string; path: string[]; errors: string[] } }[];
};

async function expectNoSeriousViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`), context).toEqual([]);
}

test('logic vectors evaluate the same in the browser as on the server', async ({ page }) => {
  // The respondent app's dev server serves the engine's source as an ES module: run every vector in Chromium.
  await page.goto(`${RESPONDENT}/preview`);
  const results = await page.evaluate(
    async ({ corePath, vectors }) => {
      const core = await import(/* @vite-ignore */ `/@fs/${corePath.replace(/^\//, '')}`);
      return vectors.cases.map((c: { hidden?: Record<string, string>; answers: Record<string, unknown> }) => {
        const r = core.checkCompletion(vectors.definition, c.answers, c.hidden);
        return { ok: r.ok, outcome: r.outcome, path: r.path, errors: r.errors.map((e: { questionKey: string }) => e.questionKey).sort() };
      });
    },
    { corePath: CORE_PATH, vectors },
  );
  for (const [i, c] of vectors.cases.entries())
    expect(results[i], c.name).toEqual({ ok: c.expect.ok, outcome: c.expect.outcome, path: c.expect.path, errors: c.expect.errors });
});

test('respondents follow the logic: show/hide, skip, end and screen out', async ({ page, request }) => {
  const { url } = await publishViaApi(request, vectors.definition, 'Logic E2E');

  // Under 18 → screened out after page 1, with the screen-out message.
  await page.goto(url);
  await page.getByRole('radio', { name: 'Under 18' }).check();
  await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('heading', { name: 'Sorry' })).toBeVisible();
  await expect(page.getByText("You don't qualify.")).toBeVisible();

  // App users: the app rating appears (OR not needed), page 2 is skipped, poor speed asks why.
  const ctx = await page.context().browser()!.newContext();
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await expect(p2.getByText('Rate the app')).toHaveCount(0);
  await p2.getByRole('radio', { name: '35+' }).check();
  await p2.getByRole('checkbox', { name: 'App' }).check();
  await expect(p2.getByText('Rate the app')).toBeVisible();
  await p2.getByRole('radio', { name: '4 of 5 stars' }).check({ force: true });
  await p2.getByRole('button', { name: 'Next' }).click();
  await expect(p2.getByRole('heading', { name: 'Page 3 of 3' })).toBeVisible();
  await expect(p2.getByText("Why wasn't speed good?")).toHaveCount(0);
  await p2.getByRole('radiogroup', { name: 'Speed' }).getByRole('radio', { name: 'Poor' }).check();
  await expect(p2.getByLabel(/Why wasn't speed good\?/)).toBeVisible();
  await p2.getByLabel(/Why wasn't speed good\?/).fill('Slow on 4G');
  await p2.getByRole('button', { name: 'Submit' }).click();
  await expect(p2.getByRole('heading', { name: 'Thanks' })).toBeVisible();
  await ctx.close();

  // Panel respondents (hidden field) who use nothing continue to page 2 (NOT + OR on a hidden field).
  const ctx3 = await page.context().browser()!.newContext();
  const p3 = await ctx3.newPage();
  await p3.goto(`${url}?src=panel`);
  await p3.getByRole('radio', { name: '18-34' }).check();
  await p3.getByRole('checkbox', { name: 'None' }).check();
  await p3.getByRole('button', { name: 'Next' }).click();
  await expect(p3.getByText('Recommend the website?')).toBeVisible();
  await ctx3.close();
});

test('piped answers are shown as text, never as HTML', async ({ page, request }) => {
  const definition = {
    schemaVersion: 1,
    defaultLocale: 'en',
    hiddenFields: [],
    settings: { showProgressBar: true, allowBack: true, thankYou: { title: 'Thanks, {{q.q_e2ename001|friend}}', body: '' } },
    pages: [
      { key: 'p_e2epipe01', elements: [{ kind: 'question', key: 'q_e2ename001', type: 'short_text', title: 'Your name?', required: true, config: { maxLength: 200 } }] },
      {
        key: 'p_e2epipe02',
        elements: [{ kind: 'question', key: 'q_e2epipe001', type: 'long_text', title: 'Why, {{q.q_e2ename001}}?', required: false, config: { maxLength: 500 } }],
      },
    ],
  };
  const { url } = await publishViaApi(request, definition, 'Piping E2E');
  const payload = '<img src=x onerror="window.__xss=1">';
  await page.goto(url);
  await page.getByLabel(/Your name\?/).fill(payload);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(`Why, ${payload}?`)).toBeVisible();
  expect(await page.locator('main img[src="x"]').count()).toBe(0);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('heading', { name: `Thanks, ${payload}` })).toBeVisible();
  expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
});

function newTypesDefinition() {
  const q = (key: string, type: string, title: string, extra: Record<string, unknown>) => ({ kind: 'question', key, type, title, required: false, ...extra });
  return {
    schemaVersion: 1,
    defaultLocale: 'en',
    hiddenFields: [],
    settings: { showProgressBar: true, allowBack: true, thankYou: { title: 'Thank you!', body: '' } },
    pages: [
      {
        key: 'p_e2enew001',
        elements: [
          q('q_e2emat001', 'matrix', 'Rate these', {
            rows: [
              { key: 'o_e2erow001', label: 'Speed' },
              { key: 'o_e2erow002', label: 'Design' },
            ],
            options: [
              { key: 'o_e2ecol001', label: 'Poor' },
              { key: 'o_e2ecol002', label: 'Good' },
            ],
            config: { multiplePerRow: false, randomizeRows: false },
          }),
          q('q_e2erank01', 'ranking', 'Rank these', {
            options: [
              { key: 'o_e2erk0001', label: 'Price' },
              { key: 'o_e2erk0002', label: 'Quality' },
            ],
            config: { randomize: false },
          }),
          q('q_e2eslid01', 'slider', 'Budget', { config: { min: 0, max: 100, step: 10, unit: '%' } }),
          q('q_e2etime01', 'date', 'Preferred time', { config: { mode: 'time' } }),
          q('q_e2ephon01', 'phone', 'Phone', { config: {} }),
          q('q_e2efile01', 'file_upload', 'A screenshot', { config: { maxFiles: 2, maxSizeMb: 1, allowedTypes: ['image', 'text'] } }),
          { ...q('q_e2econ001', 'consent', 'Consent', { config: { statement: 'I agree to the terms.', linkUrl: 'https://example.com/terms' } }), required: true },
        ],
      },
    ],
  };
}

test('new question types: accessible, stacked matrix on phones, uploads reach the admin', async ({ page, request, browser }) => {
  const { url, id, call } = await publishViaApi(request, newTypesDefinition(), 'New types E2E');
  await page.goto(url);
  await expect(page.getByText('Rate these')).toBeVisible();
  await expect(page.locator('.matrix')).toBeVisible(); // lazy chunk loaded
  await expectNoSeriousViolations(page, 'new types');

  // Wide screens: a grid with column headers. Phones: one block per row, labels visible.
  await expect(page.locator('.matrix-head')).toBeVisible();
  const phone = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const mobile = await phone.newPage();
  await mobile.goto(url);
  await expect(mobile.locator('.matrix-row').first()).toBeVisible();
  await expect(mobile.locator('.matrix-head')).toBeHidden();
  await expect(mobile.locator('.matrix-cell-label').first()).toBeVisible();
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await phone.close();

  // Answer by keyboard and native controls.
  await page.getByRole('radiogroup', { name: 'Speed' }).getByRole('radio', { name: 'Good' }).check();
  await page.getByLabel('Price, rank').selectOption('2');
  await page.getByLabel('Quality, rank').selectOption('1');
  await page.getByLabel(/Budget/).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText(/60 %|60%/)).toBeVisible();
  await page.getByLabel(/Preferred time/).fill('09:30');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('+44 20 7946 0958');
  await page.getByLabel(/A screenshot/).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from e2e') });
  await expect(page.getByRole('list', { name: 'Uploaded files' })).toContainText('notes.txt');

  // Consent is required.
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('alert')).toContainText('Tick the box to agree');
  await expectNoSeriousViolations(page, 'new types with errors');
  await page.getByRole('checkbox', { name: 'I agree' }).check();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();

  // The admin sees the stored answers and can download the file once it's been scanned.
  const list = await call('GET', `/surveys/${id}/responses?status=completed`);
  const detail = await call('GET', `/surveys/${id}/responses/${list.data[0].id}`);
  const byKey = Object.fromEntries(detail.answers.map((a: { questionKey: string; display: string }) => [a.questionKey, a.display]));
  expect(byKey).toMatchObject({ q_e2emat001: 'Speed: Good', q_e2erank01: '1. Quality; 2. Price', q_e2eslid01: '60 %', q_e2etime01: '09:30', q_e2ephon01: '+442079460958', q_e2econ001: 'Agreed' });
  expect(detail.files).toEqual([expect.objectContaining({ filename: 'notes.txt', questionKey: 'q_e2efile01' })]);
  await expect.poll(async () => (await call('GET', `/surveys/${id}/responses/${list.data[0].id}`)).files[0].scanStatus, { timeout: 15_000 }).toBe('clean');
  const download = await request.get(`/api/v1/files/${detail.files[0].id}`);
  expect(download.status()).toBe(200);
  expect(await download.text()).toBe('hello from e2e');
});

test('a theme restyles respondent pages and its colours are checked', async ({ page, request }) => {
  const { url, call } = await publishViaApi(request, newTypesDefinition(), 'Themed E2E');
  const tooFaint = await request.post('/api/v1/themes', {
    data: { name: 'Faint', tokens: { primary: '#cccccc', background: '#ffffff', surface: '#ffffff', text: '#dddddd', font: 'system', radius: 'small' } },
    headers: { 'x-csrf-token': (await call('GET', '/auth/me')).csrfToken },
  });
  expect(tooFaint.status()).toBe(422);
  await call('POST', '/themes', {
    name: 'Brand',
    tokens: { primary: '#0f6b5c', background: '#f3f7f6', surface: '#ffffff', text: '#14201d', font: 'serif', radius: 'large' },
    isDefault: true,
  });
  await page.goto(url);
  await expect(page.getByText('Rate these')).toBeVisible();
  const vars = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return { primary: style.getPropertyValue('--primary').trim(), radius: style.getPropertyValue('--radius').trim() };
  });
  expect(vars).toEqual({ primary: '#0f6b5c', radius: '18px' });
  await expectNoSeriousViolations(page, 'themed page');
});

test('builder logic tools are accessible', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Logic Builder');
  await page.getByLabel('Work email').fill(`logic.${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByLabel('Organization name').fill('Logic Org');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'New survey' }).click();
  await page.getByLabel('Title').fill('Logic builder');
  await page.getByRole('button', { name: 'Create survey' }).click();
  await page.getByRole('button', { name: '+ Add question' }).click();
  await page.getByRole('button', { name: /^Single choice/ }).click();
  await page.getByLabel('Question', { exact: true }).fill('Do you drive?');
  await page.getByRole('button', { name: 'Add page' }).click();
  await page.getByRole('button', { name: '+ Add question' }).last().click();
  await page.getByRole('button', { name: /^Short text/ }).click();
  await page.getByLabel('Question', { exact: true }).fill('Which car?');
  await page.getByLabel('Show this question only when…').check();
  await expect(page.getByLabel('Answer or field')).toHaveValue(/q:/);
  await page.getByRole('button', { name: /Logic/ }).nth(1).click();
  await page.getByRole('button', { name: '+ Add rule' }).first().click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  await expectNoSeriousViolations(page, 'builder with logic');
  await page.getByRole('button', { name: 'Logic map' }).click();
  await expect(page.getByRole('dialog')).toContainText('is shown only when');
  await expectNoSeriousViolations(page, 'logic map');
});
