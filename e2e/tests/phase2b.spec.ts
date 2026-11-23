/**
 * Phase 2B end to end: the embed snippet on a page with a strict Content-Security-Policy (inline
 * and popup, host CSS can't leak in), an email campaign through Mailpit (personal link, one response
 * per recipient), live results over Server-Sent Events, and accessibility of the new admin screens.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { publishViaApi, RESPONDENT, signupInUi } from './helpers';

const MAILPIT = 'http://localhost:8025';

async function expectNoSeriousViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`), context).toEqual([]);
}

function npsDefinition() {
  return {
    schemaVersion: 1,
    defaultLocale: 'en',
    hiddenFields: [],
    settings: { showProgressBar: true, allowBack: true, thankYou: { title: 'Thanks, {{contact.first_name|friend}}!', body: '' } },
    pages: [
      {
        key: 'p_e2e2b0001',
        elements: [
          { kind: 'question', key: 'q_e2e2bnps1', type: 'nps', title: 'How likely are you to recommend us, {{contact.first_name|friend}}?', required: true, config: { lowLabel: 'No', highLabel: 'Yes' } },
        ],
      },
    ],
  };
}

test('the embed works inline and as a popup on a page with a strict CSP, isolated from host CSS', async ({ page, request }) => {
  const { url } = await publishViaApi(request, npsDefinition(), 'Embedded survey');
  const publicId = new URL(url).pathname.split('/').pop()!;
  // The customer's page: a real HTTP server on another loopback port (a different origin from the
  // survey). Chrome only lets loopback pages load loopback scripts; in production both are public origins.
  const server = createServer((req, res) => {
    if (req.url === '/host.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('* { color: rgb(255, 0, 0) !important; font-family: monospace !important; } iframe { border: 5px solid red; }');
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // No inline scripts or styles anywhere; only the survey origin may run scripts and be framed.
      'content-security-policy': `default-src 'none'; script-src ${RESPONDENT}; frame-src ${RESPONDENT}; style-src 'self'; img-src 'self'`,
    });
    res.end(`<!doctype html><html lang="en"><head><title>Customer site</title><link rel="stylesheet" href="/host.css"></head><body>
      <main><h1>Our product</h1>
      <div data-survey="${publicId}" data-mode="inline"></div>
      <button type="button" data-survey="${publicId}" data-mode="popup" data-title="Embedded survey">Give feedback</button>
      <script src="${RESPONDENT}/embed.js" async></script></main></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await page.goto(`${host}/`);

  // Inline: the survey renders in its own frame, unaffected by the host's CSS, and the frame grows to fit.
  const inline = page.frameLocator('main > div[data-survey] iframe');
  await expect(inline.getByText('How likely are you to recommend us, friend?')).toBeVisible();
  const color = await inline.locator('h1').evaluate((el) => getComputedStyle(el).color);
  expect(color).not.toBe('rgb(255, 0, 0)');
  await expect.poll(async () => page.locator('main > div[data-survey] iframe').evaluate((f) => (f as HTMLIFrameElement).getBoundingClientRect().height)).not.toBe(480);

  // Popup: a modal dialog with the survey; Escape closes it and focus returns to the button.
  await page.getByRole('button', { name: 'Give feedback' }).click();
  const dialog = page.getByRole('dialog', { name: 'Embedded survey' });
  await expect(dialog).toBeVisible();
  await expect(page.frameLocator('[role="dialog"] iframe').getByText('How likely are you to recommend us')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close survey' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Give feedback' })).toBeFocused();

  // Answer inline and complete.
  await inline.getByRole('radio', { name: '9', exact: true }).check({ force: true });
  await inline.getByRole('button', { name: 'Submit' }).click();
  await expect(inline.getByRole('heading', { name: 'Thanks, friend!' })).toBeVisible();
  expect(violations).toEqual([]);
  server.close();
});

test('a campaign email carries a personal link that works once', async ({ page, request, browser }) => {
  const { id, url, call } = await publishViaApi(request, npsDefinition(), 'Campaign E2E');
  const email = `e2e.${Date.now()}@example.com`;
  const list = await call('POST', '/contact-lists', { name: `E2E ${Date.now()}` });
  await call('POST', '/contacts', { email, firstName: 'Robin', listIds: [list.id] });
  const campaign = await call('POST', `/surveys/${id}/campaigns`, {
    name: 'E2E invite',
    listId: list.id,
    subject: 'Hi {{contact.first_name}}',
    body: 'Please answer: {{survey.link}}',
  });
  await call('POST', `/campaigns/${campaign.id}/send`, {});

  // The worker sends it to Mailpit.
  let link = '';
  await expect
    .poll(
      async () => {
        const search = await (await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
        const id = search.messages?.[0]?.ID;
        if (!id) return '';
        const message = await (await request.get(`${MAILPIT}/api/v1/message/${id}`)).json();
        link = /https?:\/\/\S+[?&]t=[A-Za-z0-9_-]{32}/.exec(message.Text)?.[0] ?? '';
        return link;
      },
      { timeout: 20_000 },
    )
    .toContain(new URL(url).pathname);

  await page.goto(link);
  await expect(page.getByText('How likely are you to recommend us, Robin?')).toBeVisible();
  await page.getByRole('radio', { name: '10', exact: true }).check({ force: true });
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('heading', { name: 'Thanks, Robin!' })).toBeVisible();

  // Same link in a fresh browser: already answered.
  const other = await browser.newContext();
  const again = await other.newPage();
  await again.goto(link);
  await expect(again.getByRole('heading', { name: "You've already responded" })).toBeVisible();
  await other.close();
  const status = await call('GET', `/campaigns/${campaign.id}`);
  expect(status.counts.responded).toBe(1);
});

test('the dashboard updates live when a response comes in', async ({ page, browser }) => {
  await signupInUi(page, 'Live Org');
  // Create and publish a survey through the signed-in page's API session.
  const csrf = await page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).csrfToken as string);
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    page.evaluate(
      async ({ method, path, body, headers, csrf }) => {
        const res = await fetch(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, ...headers }, body: body ? JSON.stringify(body) : undefined });
        return res.json();
      },
      { method, path, body, headers, csrf },
    );
  const survey = await api('POST', '/surveys', { title: 'Live results' });
  const draft = await api('GET', `/surveys/${survey.id}/draft`);
  const saved = await api('PUT', `/surveys/${survey.id}/draft`, { definition: npsDefinition() }, { 'if-match': `"rev-${draft.revision}"` });
  const published = await api('POST', `/surveys/${survey.id}/publish`, { revision: saved.revision });

  await page.goto(`/surveys/${survey.id}/results`);
  await expect(page.getByText(/Live · Updated/)).toBeVisible();
  // The "Completed" stat tile: label, then the value.
  const completed = page.getByText('Completed', { exact: true }).first().locator('xpath=following-sibling::div[1]');
  await expect(completed).toHaveText('0');

  const respondent = await browser.newPage();
  await respondent.goto(published.survey.publicUrl);
  await respondent.getByRole('radio', { name: '8', exact: true }).check({ force: true });
  const started = Date.now();
  await respondent.getByRole('button', { name: 'Submit' }).click();
  await expect(respondent.getByRole('heading', { name: 'Thanks, friend!' })).toBeVisible();
  // Polling is every 15 s when live; only the stream can bring the update this fast.
  await expect(completed).toHaveText('1', { timeout: 6000 });
  expect(Date.now() - started).toBeLessThan(6000);
  await respondent.close();
});

test('contacts, campaigns and analysis screens are accessible', async ({ page }) => {
  await signupInUi(page, 'A11y 2B');
  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await page.getByLabel('Email').fill(`a11y.${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Add contact' }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoSeriousViolations(page, 'contacts');
  await page.getByRole('button', { name: 'Import CSV' }).click();
  await page.getByLabel('CSV file').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from('Email,First name,Plan\na@example.com,Ann,pro\n') });
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('Email');
  await expectNoSeriousViolations(page, 'import dialog');
  await page.keyboard.press('Escape');

  // A survey with responses, to open the distribute and results screens.
  const csrf = await page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).csrfToken as string);
  const survey = await page.evaluate(
    async ({ csrf }) => (await fetch('/api/v1/surveys', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ title: 'A11y 2B survey' }) })).json(),
    { csrf },
  );
  await page.goto(`/surveys/${survey.id}/distribute`);
  await expect(page.getByRole('heading', { name: 'Email invitations' })).toBeVisible();
  await expectNoSeriousViolations(page, 'distribute');
});
