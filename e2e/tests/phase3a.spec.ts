/**
 * Phase 3A end to end: folders and approval before publishing through the admin app, API keys and
 * webhooks from the settings page (a real HTTP receiver checks the signature), comments on a draft,
 * and accessibility of the new screens.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { PASSWORD, signupInUi, unique } from './helpers';

const MAILPIT = 'http://localhost:8025';

async function expectNoSeriousViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`),
    context,
  ).toEqual([]);
}

/** Call the API from the signed-in page (its cookie and CSRF token). */
async function pageApi(page: Page) {
  const csrf = await page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).csrfToken as string);
  return (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    page.evaluate(
      async ({ method, path, body, headers, csrf }) => {
        const res = await fetch(`/api/v1${path}`, {
          method,
          headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf, ...headers },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: res.status === 204 ? null : await res.json() };
      },
      { method, path, body, headers, csrf },
    );
}

const definition = {
  schemaVersion: 1,
  defaultLocale: 'en',
  hiddenFields: [],
  settings: { showProgressBar: true, allowBack: true, thankYou: { title: 'Thanks!', body: '' } },
  pages: [
    {
      key: 'p_e2e3a0001',
      elements: [{ kind: 'question', key: 'q_e2e3aq001', type: 'short_text', title: 'What should we improve?', required: false, config: { maxLength: 500 } }],
    },
  ],
};

/** Invite someone, accept through the API in their own request context, return it (logged in). */
async function addCreator(page: Page, request: APIRequestContext) {
  const api = await pageApi(page);
  const email = unique('creator');
  expect((await api('POST', '/org/invitations', { email, role: 'creator' })).status).toBe(201);
  let token = '';
  await expect
    .poll(
      async () => {
        const search = await (await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
        const id = search.messages?.[0]?.ID;
        if (!id) return '';
        const message = await (await request.get(`${MAILPIT}/api/v1/message/${id}`)).json();
        token = /\/invite\/([A-Za-z0-9_-]+)/.exec(message.Text)?.[1] ?? '';
        return token;
      },
      { timeout: 20_000 },
    )
    .not.toBe('');
  const res = await request.post(`/api/v1/invitations/${token}/accept`, { data: { name: 'Cora Creator', password: PASSWORD } });
  expect(res.status()).toBe(200);
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return async (method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const r = await request.fetch(`/api/v1${path}`, { method, data, headers: { 'x-csrf-token': csrfToken, ...headers } });
    return { status: r.status(), body: r.status() === 204 ? null : await r.json() };
  };
}

test('folders organise surveys, and an approver publishes a creator’s draft', async ({ page, request }) => {
  await signupInUi(page, 'Approvals E2E');
  const creator = await addCreator(page, request);

  // Folders: create one and move a survey into it with the row's folder menu.
  const survey = (await creator('POST', '/surveys', { title: 'Needs sign-off' })).body;
  await page.goto('/surveys');
  await page.getByRole('button', { name: '+ New folder' }).click();
  await page.getByLabel('Folder name').fill('Launch reviews');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await expect(page.getByRole('button', { name: /Launch reviews/ })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: 'All surveys' }).click();
  await page.getByLabel('Move Needs sign-off to folder').selectOption({ label: 'Launch reviews' });
  await page.getByRole('button', { name: /Launch reviews/ }).click();
  await expect(page.getByRole('link', { name: 'Needs sign-off' })).toBeVisible();

  // Turn approvals on.
  await page.goto('/settings/org');
  await page.getByLabel('Require approval to publish').check();
  await page.getByRole('button', { name: 'Save approval settings' }).click();
  await expect(page.getByText('Saved.').last()).toBeVisible();

  // The creator publishes: it becomes a request for this exact revision.
  const draft = (await creator('GET', `/surveys/${survey.id}/draft`)).body;
  const saved = (await creator('PUT', `/surveys/${survey.id}/draft`, { definition }, { 'if-match': `"rev-${draft.revision}"` })).body;
  const asked = await creator('POST', `/surveys/${survey.id}/publish`, { revision: saved.revision, note: 'Ready for launch' });
  expect(asked.status).toBe(202);

  // The admin reviews and approves in the app.
  await page.goto('/approvals');
  await expect(page.getByText('“Ready for launch”')).toBeVisible();
  await page.getByRole('button', { name: 'Approve and publish' }).click();
  await page.getByRole('dialog').getByLabel('Note for the author (optional)').fill('Ship it');
  await page.getByRole('dialog').getByRole('button', { name: 'Approve and publish' }).click();
  await expect(page.getByText('Nothing waiting for approval')).toBeVisible();
  const live = (await creator('GET', `/surveys/${survey.id}`)).body;
  expect(live).toMatchObject({ status: 'live', currentVersionNumber: 1, pendingApproval: false });
  // The creator is told.
  const inbox = (await creator('GET', '/notifications')).body;
  expect(inbox.data[0].title).toBe('"Needs sign-off" was approved and published');
});

test('API keys and webhooks are managed from settings; deliveries are signed', async ({ page, request }) => {
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  try {
    await signupInUi(page, 'Platform E2E');
    await page.goto('/settings/api');

    await page.getByRole('button', { name: 'New API key' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Reporting');
    await page.getByRole('button', { name: 'Create key' }).click();
    const key = (await page.getByTestId('new-api-key').textContent())!.trim();
    expect(key).toMatch(/^sk_live_/);
    const viaKey = await request.get('/api/v1/surveys', { headers: { authorization: `Bearer ${key}` } });
    expect(viaKey.status()).toBe(200);
    // Default scopes don't include writing.
    expect((await request.post('/api/v1/surveys', { headers: { authorization: `Bearer ${key}` }, data: { title: 'x' } })).status()).toBe(403);

    await page.getByRole('button', { name: 'Add endpoint' }).click();
    await page.getByLabel('Endpoint URL').fill(hookUrl);
    await page.getByRole('dialog').getByRole('button', { name: 'Add endpoint' }).click();
    const secret = (await page.locator('code', { hasText: 'whsec_' }).textContent())!.trim();
    await page.getByRole('button', { name: 'Send test' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Test: HTTP 200' })).toBeVisible();

    const ping = received.at(-1)!;
    expect(JSON.parse(ping.body).type).toBe('ping');
    const timestamp = String(ping.headers['survey-webhook-timestamp']);
    const expected = createHmac('sha256', secret).update(`${timestamp}.${ping.body}`).digest('hex');
    expect(ping.headers['survey-webhook-signature']).toBe(`v1=${expected}`);

    await page.getByRole('button', { name: 'Deliveries' }).click();
    await expect(page.getByRole('dialog').getByText('ping')).toBeVisible();
    await expectNoSeriousViolations(page, 'deliveries dialog');
  } finally {
    server.close();
  }
});

test('comments, approvals, audit log and settings screens are accessible', async ({ page }) => {
  await signupInUi(page, 'A11y 3A');
  const api = await pageApi(page);
  const survey = (await api('POST', '/surveys', { title: 'Commented survey' })).body;
  const draft = (await api('GET', `/surveys/${survey.id}/draft`)).body;
  await api('PUT', `/surveys/${survey.id}/draft`, { definition }, { 'if-match': `"rev-${draft.revision}"` });

  await page.goto(`/surveys/${survey.id}/comments`);
  // The card around the question's heading.
  const question = page
    .getByRole('heading', { name: 'Q1. What should we improve?' })
    .locator('xpath=ancestor::*[.//button[normalize-space()="Add a comment"]][1]');
  await question.getByRole('button', { name: 'Add a comment' }).click();
  await question.getByLabel('Comment on this question').fill('Ask about pricing too?');
  await question.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByText('Ask about pricing too?')).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Ask about pricing too?')).toHaveCount(0);
  await expectNoSeriousViolations(page, 'comments');

  for (const [path, heading] of [
    ['/approvals', 'Approvals'],
    ['/settings/teams', 'Teams'],
    ['/settings/api', 'API and webhooks'],
    ['/settings/integrations', 'Integrations'],
    ['/settings/audit', 'Audit log'],
    ['/settings/notifications', 'Notifications'],
    ['/notifications', 'Notifications'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expectNoSeriousViolations(page, path);
  }
});
