/**
 * Phase 3B end to end: a survey in two languages (browser detection, the language picker, right to left,
 * the translation editor), AI summaries (the API runs with AI_PROVIDER=fake), OIDC single sign-on against a
 * local mock identity provider (SSO_DOMAIN_VERIFICATION=auto), login-required respondents, and the
 * retention, usage, privacy-request and platform screens, with axe checks of every new screen.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';
import { startMockOidc } from '../../apps/api/test/mock-oidc';
import { PASSWORD, RESPONDENT, signupInUi, unique } from './helpers';

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
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const result = await page.evaluate(
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
    if (result.status >= 400) throw new Error(`${method} ${path} → ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  };
}

type Api = Awaited<ReturnType<typeof pageApi>>;

async function publish(api: Api, title: string, definition: object) {
  const survey = await api('POST', '/surveys', { title });
  const draft = await api('GET', `/surveys/${survey.id}/draft`);
  const saved = await api('PUT', `/surveys/${survey.id}/draft`, { definition }, { 'if-match': `"rev-${draft.revision}"` });
  const published = await api('POST', `/surveys/${survey.id}/publish`, { revision: saved.revision });
  return { id: survey.id as string, publicId: survey.publicId as string, url: published.publicUrl as string, versionId: published.version.id as string };
}

/** Answer a survey through the respondent API. */
async function respond(request: APIRequestContext, publicId: string, answers: Record<string, unknown>) {
  const loaded = await (await request.get(`${RESPONDENT}/r/v1/s/${publicId}`)).json();
  const res = await request.post(`${RESPONDENT}/r/v1/s/${publicId}/response/complete`, {
    headers: { 'x-response-key': randomBytes(16).toString('base64url') },
    data: { seq: 1, start: { versionId: loaded.version.id, locale: 'en' }, answers, currentPageKey: loaded.version.definition.pages.at(-1).key },
  });
  expect(res.status()).toBe(200);
}

const page1 = 'p_e2e3b0001';
const page2 = 'p_e2e3b0002';
const like = 'q_e2e3blike';
const why = 'q_e2e3bwhy1';
const bilingual = {
  schemaVersion: 1,
  defaultLocale: 'en',
  hiddenFields: [],
  settings: { showProgressBar: true, allowBack: true, thankYou: { title: 'Thanks! You said {{q.q_e2e3blike}}.', body: '' } },
  pages: [
    {
      key: page1,
      title: 'Start',
      elements: [
        {
          kind: 'question',
          key: like,
          type: 'single_choice',
          title: 'Do you like the product?',
          required: true,
          options: [
            { key: 'o_e2e3byes1', label: 'Yes' },
            { key: 'o_e2e3bno01', label: 'No' },
          ],
          config: { randomize: false },
        },
      ],
    },
    {
      key: page2,
      title: 'You said {{q.q_e2e3blike}}',
      elements: [{ kind: 'question', key: why, type: 'long_text', title: 'Why?', required: false, config: { maxLength: 500 } }],
    },
  ],
};
const french = {
  'survey.title': 'Votre avis',
  [`page.${page1}.title`]: 'Début',
  [`${like}.title`]: 'Aimez-vous le produit ?',
  [`${like}.option.o_e2e3byes1`]: 'Oui',
  [`${like}.option.o_e2e3bno01`]: 'Non',
  [`page.${page2}.title`]: 'Vous avez dit {{q.q_e2e3blike}}',
  [`${why}.title`]: 'Pourquoi ?',
  'thankYou.title': 'Merci ! Vous avez dit {{q.q_e2e3blike}}.',
  'ui.next': 'Suivant',
  'ui.back': 'Retour',
  'ui.submit': 'Envoyer',
  'ui.language': 'Langue',
};
const arabic = {
  'survey.title': 'رأيك',
  [`${like}.title`]: 'هل يعجبك المنتج؟',
  [`${like}.option.o_e2e3byes1`]: 'نعم',
  [`${like}.option.o_e2e3bno01`]: 'لا',
  'ui.next': 'التالي',
  'ui.language': 'اللغة',
};

test('a survey in two languages: browser detection, the picker, right to left and the translation editor', async ({ page, browser }) => {
  await signupInUi(page, 'Languages E2E');
  const api = await pageApi(page);
  const survey = await publish(api, 'Your opinion', bilingual);
  await api('PUT', `/surveys/${survey.id}/versions/${survey.versionId}/translations/fr`, { strings: french });
  await api('PUT', `/surveys/${survey.id}/versions/${survey.versionId}/translations/ar`, { strings: arabic });

  // A browser set to French gets French without asking.
  const context = await browser.newContext({ locale: 'fr-FR' });
  const respondent = await context.newPage();
  await respondent.goto(survey.url);
  await expect(respondent.getByRole('heading', { level: 1, name: 'Votre avis' })).toBeVisible();
  await expect(respondent.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(respondent.getByRole('group', { name: /Aimez-vous le produit/ })).toBeVisible();

  // Switch to Arabic: the page mirrors.
  await respondent.getByLabel('Langue').selectOption('ar');
  await expect(respondent.getByRole('heading', { level: 1, name: 'رأيك' })).toBeVisible();
  await expect(respondent.locator('html')).toHaveAttribute('dir', 'rtl');
  const next = await respondent.getByRole('button', { name: 'التالي' }).boundingBox();
  const width = respondent.viewportSize()!.width;
  expect(next!.x + next!.width / 2).toBeLessThan(width / 2); // the primary button sits on the left in RTL
  await expectNoSeriousViolations(respondent, 'respondent, right to left');

  // Back to French and answer: logic and piping work in French.
  await respondent.getByLabel('اللغة').selectOption('fr');
  await expect(respondent.locator('html')).toHaveAttribute('dir', 'ltr');
  await respondent.getByRole('radio', { name: 'Oui' }).check();
  await respondent.getByRole('button', { name: 'Suivant' }).click();
  await expect(respondent.getByRole('heading', { name: 'Vous avez dit Oui' })).toBeVisible();
  await respondent.getByRole('button', { name: 'Envoyer' }).click();
  await expect(respondent.getByRole('heading', { name: 'Merci ! Vous avez dit Oui.' })).toBeVisible();
  await context.close();
  const responses = await api('GET', `/surveys/${survey.id}/responses?status=all`);
  expect(responses.data[0].locale).toBe('fr');

  // The translation editor: fill a missing string on the live version, then add a language.
  await page.goto(`/surveys/${survey.id}/translations`);
  await page.getByRole('button', { name: /^French/ }).click();
  await page.getByLabel('French for Button or message: Submitting…').fill('Envoi…');
  await page.getByRole('button', { name: 'Save French' }).click();
  await expect(page.getByText('Saved. Respondents see the new text now.')).toBeVisible();
  await expectNoSeriousViolations(page, 'translation editor');
  await page.getByLabel('Language', { exact: true }).selectOption('de');
  await page.getByRole('button', { name: 'Add language' }).click();
  await expect(page.getByRole('heading', { name: /German \(de\)/ })).toBeVisible();
});

test('AI summaries are off until an admin opts in, then are labelled and link to answers', async ({ page, request }) => {
  await signupInUi(page, 'AI E2E');
  const api = await pageApi(page);
  const survey = await publish(api, 'Feedback', {
    schemaVersion: 1,
    defaultLocale: 'en',
    hiddenFields: [],
    settings: { showProgressBar: false, allowBack: true, thankYou: { title: 'Thanks!', body: '' } },
    pages: [{ key: 'p_e2eai0001', elements: [{ kind: 'question', key: 'q_e2eaitext', type: 'long_text', title: 'What should we improve?', required: true, config: { maxLength: 500 } }] }],
  });
  for (const text of ['Support is slow', 'Slow support on weekends', 'Great design', 'Great onboarding, slow support'])
    await respond(request, survey.publicId, { q_e2eaitext: text });

  await page.goto(`/surveys/${survey.id}/results`);
  await expect(page.getByText('AI summaries are off for your organization')).toBeVisible();

  await page.goto('/settings/org');
  await expect(page.getByText(/third-party processor/)).toBeVisible();
  await page.getByLabel('Turn on AI summaries for this organization').check();
  await expect(page.getByText('AI summaries are on.')).toBeVisible();
  await expectNoSeriousViolations(page, 'org settings with AI and retention');

  await page.goto(`/surveys/${survey.id}/results`);
  await page.getByRole('button', { name: 'Summarize with AI' }).click();
  const summary = page.getByRole('region', { name: 'AI summary' });
  await expect(summary.getByText(/AI-generated · fake-summarizer/)).toBeVisible({ timeout: 20_000 });
  await expect(summary.getByText('Based on 4 answers.')).toBeVisible();
  await summary.getByText(/Sample answers/).first().click();
  await expectNoSeriousViolations(page, 'results with an AI summary');
  await summary.getByRole('link', { name: 'View response' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/surveys/${survey.id}/responses/[0-9a-f-]{36}$`));
});

test('OIDC single sign-on: settings, then just-in-time sign-in from the login page', async ({ page, browser }) => {
  const idp = await startMockOidc({ clientId: 'e2e-client', clientSecret: 'e2e-secret' });
  const domain = `sso${Date.now()}.example`;
  try {
    await signupInUi(page, 'SSO E2E');
    await page.goto('/settings/sso');
    await page.getByLabel('Domain').fill(domain);
    await page.getByRole('button', { name: 'Add domain' }).click();
    await expect(page.getByText('Verified', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add OpenID Connect' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Mock IdP');
    await dialog.getByLabel('Issuer URL').fill(idp.issuer);
    await dialog.getByLabel('Client ID').fill('e2e-client');
    await dialog.getByLabel('Client secret').fill('e2e-secret');
    await dialog.getByLabel('Role for people added on their first sign-in').selectOption('analyst');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Mock IdP')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Require single sign-on' })).toBeDisabled();
    await expectNoSeriousViolations(page, 'single sign-on settings');

    // Someone new signs in through the identity provider and becomes a member.
    idp.setUser({ sub: 'e2e-user-1', email: `pat@${domain}`, name: 'Pat Provisioned' });
    const context = await browser.newContext();
    const visitor = await context.newPage();
    await visitor.goto('/login');
    await visitor.getByRole('button', { name: 'Sign in with SSO' }).click();
    await expectNoSeriousViolations(visitor, 'login page, single sign-on mode');
    await visitor.getByLabel('Email').fill(`pat@${domain}`);
    await visitor.getByRole('button', { name: 'Continue with single sign-on' }).click();
    await expect(visitor.getByRole('heading', { name: 'Surveys', exact: true })).toBeVisible();
    const me = await visitor.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()) as { user: { email: string; name: string }; activeOrg: { role: string } });
    expect(me.user).toMatchObject({ email: `pat@${domain}`, name: 'Pat Provisioned' });
    expect(me.activeOrg.role).toBe('analyst');
    await context.close();

    // Now that a sign-in worked, enforcement can be switched on.
    await page.reload();
    await page.getByRole('button', { name: 'Require single sign-on' }).click();
    await expect(page.getByText('Password sign-in is off for your verified domains')).toBeVisible();
  } finally {
    await idp.close();
  }
});

test('login-required survey: a member signs in on the admin app and answers once', async ({ page, browser, request }) => {
  await signupInUi(page, 'Members E2E');
  const api = await pageApi(page);
  const memberEmail = unique('member');
  await api('POST', '/org/invitations', { email: memberEmail, role: 'analyst' });
  let token = '';
  await expect
    .poll(
      async () => {
        const search = await (await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${memberEmail}`)}`)).json();
        const id = search.messages?.[0]?.ID;
        if (!id) return '';
        const message = await (await request.get(`${MAILPIT}/api/v1/message/${id}`)).json();
        token = /\/invite\/([A-Za-z0-9_-]+)/.exec(message.Text)?.[1] ?? '';
        return token;
      },
      { timeout: 20_000 },
    )
    .not.toBe('');
  expect((await request.post(`/api/v1/invitations/${token}/accept`, { data: { name: 'Mo Member', password: PASSWORD } })).status()).toBe(200);

  const survey = await publish(api, 'Team retro', {
    schemaVersion: 1,
    defaultLocale: 'en',
    hiddenFields: [],
    settings: { showProgressBar: false, allowBack: true, thankYou: { title: 'Thanks, teammate!', body: '' } },
    pages: [{ key: 'p_e2emem001', elements: [{ kind: 'question', key: 'q_e2ememtxt', type: 'short_text', title: 'One word for this quarter', required: true, config: { maxLength: 50 } }] }],
  });
  await page.goto(`/surveys/${survey.id}/distribute`);
  await page.getByLabel(/Respondents must sign in/).check();
  await page.getByRole('button', { name: 'Save access settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  const context = await browser.newContext();
  const respondent = await context.newPage();
  await respondent.goto(survey.url);
  await expect(respondent.getByText('This survey is for members of the organization that runs it.')).toBeVisible();
  await expectNoSeriousViolations(respondent, 'sign in to answer');
  await respondent.getByRole('link', { name: 'Sign in to continue' }).click();
  await respondent.getByLabel('Email').fill(memberEmail);
  await respondent.getByLabel('Password').fill(PASSWORD);
  await respondent.getByRole('button', { name: 'Log in' }).click();
  // Back on the respondent site, signed in (the one-time token is gone from the address bar).
  await expect(respondent.getByLabel(/One word for this quarter/)).toBeVisible();
  expect(respondent.url()).toBe(survey.url);
  await respondent.getByLabel(/One word for this quarter/).fill('Productive');
  await respondent.getByRole('button', { name: 'Submit' }).click();
  await expect(respondent.getByRole('heading', { name: 'Thanks, teammate!' })).toBeVisible();
  // Once only, on any device: a fresh sign-in sees the response is done.
  await respondent.goto(`http://localhost:5173/respond/${survey.publicId}`);
  await expect(respondent.getByRole('heading', { name: "You've already responded" })).toBeVisible();
  await context.close();

  const list = await api('GET', `/surveys/${survey.id}/responses`);
  await page.goto(`/surveys/${survey.id}/responses/${list.data[0].id}`);
  await expect(page.getByText(`Mo Member · ${memberEmail}`)).toBeVisible();
});

test('retention, usage, privacy requests and the platform console', async ({ page, request }) => {
  const adminEmail = await signupInUi(page, 'Governance E2E');
  const api = await pageApi(page);
  const subject = unique('subject');
  const survey = await publish(api, 'Contact form', {
    schemaVersion: 1,
    defaultLocale: 'en',
    hiddenFields: [],
    settings: { showProgressBar: false, allowBack: true, thankYou: { title: 'Thanks!', body: '' } },
    pages: [{ key: 'p_e2egov001', elements: [{ kind: 'question', key: 'q_e2egovmail', type: 'email', title: 'Your email', required: true, config: {} }] }],
  });
  await respond(request, survey.publicId, { q_e2egovmail: subject });
  await respond(request, survey.publicId, { q_e2egovmail: unique('other') });

  // Retention default.
  await page.goto('/settings/org');
  await page.getByLabel('Keep responses until someone deletes them').uncheck();
  await page.getByLabel('Delete responses after (days)').fill('90');
  await page.getByRole('button', { name: 'Save retention' }).click();
  await expect(page.getByText('Saved.').last()).toBeVisible();

  // A survey's own retention period.
  await page.goto(`/surveys/${survey.id}/settings`);
  await page.getByRole('radio', { name: 'Delete responses after a number of days' }).check();
  await page.getByLabel('Days to keep responses').fill('30');
  await page.getByRole('button', { name: 'Save retention' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expectNoSeriousViolations(page, 'survey settings with retention');
  expect((await api('GET', `/surveys/${survey.id}`)).effectiveRetentionDays).toBe(30);

  // Usage.
  await page.goto('/settings/usage');
  await expect(page.getByText('Responses this month')).toBeVisible();
  await expect.poll(async () => (await api('GET', '/org/usage')).months.at(-1).responses, { timeout: 20_000 }).toBe(2);
  await page.reload();
  await expectNoSeriousViolations(page, 'usage');

  // A subject export, then an erasure.
  await page.goto('/settings/privacy');
  await page.getByLabel('Email address').fill(subject);
  await page.getByRole('button', { name: 'Export their data' }).click();
  await expect(page.getByText('Found 0 contacts, 0 campaign emails, 1 response, 0 uploaded files.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('link', { name: 'Download (JSON)' })).toBeVisible();
  await expectNoSeriousViolations(page, 'privacy requests');
  await page.getByRole('button', { name: 'Erase their data…' }).click();
  await page.getByRole('dialog').getByLabel('Type the email address again to confirm').fill(subject);
  await page.getByRole('dialog').getByRole('button', { name: 'Erase for good' }).click();
  await expect(page.getByText(/^Removed .*1 response,/)).toBeVisible({ timeout: 20_000 });
  expect((await api('GET', `/surveys/${survey.id}/responses?status=all`)).data).toHaveLength(1);

  // The platform console (this test makes its admin a super admin directly in the database).
  const envFile = resolve(__dirname, '../../.env');
  if (!process.env.DATABASE_OWNER_URL && existsSync(envFile)) process.loadEnvFile(envFile);
  const owner = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await owner.connect();
  try {
    await owner.query('update users set is_super_admin = true where email = $1', [adminEmail]);
  } finally {
    await owner.end();
  }
  const otherOrg = `Suspend me ${Date.now()}`;
  const signedUp = await request.post('/api/v1/auth/signup', { data: { name: 'Other Admin', email: unique('other-admin'), password: PASSWORD, orgName: otherOrg } });
  expect(signedUp.status()).toBe(201);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible();
  await page.getByLabel('Search').fill(otherOrg);
  await page.getByRole('button', { name: `Manage ${otherOrg}` }).click();
  await page.getByRole('dialog').getByLabel('Status').selectOption('suspended');
  await page.getByRole('dialog').getByLabel(/Reason/).fill('E2E check');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('tr', { hasText: otherOrg }).getByText('Suspended')).toBeVisible();
  await expectNoSeriousViolations(page, 'platform console');
});
