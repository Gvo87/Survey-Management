import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'e2e-password-123';
export const RESPONDENT = 'http://localhost:5174';
export const unique = (prefix: string) =>
  `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;

/** Sign up through the UI and land on the survey list. */
export async function signupInUi(page: Page, orgName = 'E2E Org') {
  const email = unique('owner');
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Erin Example');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Organization name').fill(orgName);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Surveys', exact: true })).toBeVisible();
  return email;
}

/** API helper using a logged-in request context (cookie jar + CSRF header, like the web app). */
export async function apiSession(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/signup', {
    data: { name: 'Api User', email: unique('api'), password: PASSWORD, orgName: 'API Org' },
  });
  expect(res.status()).toBe(201);
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const r = await request.fetch(`/api/v1${path}`, {
      method,
      data,
      headers: { 'x-csrf-token': csrfToken, ...headers },
    });
    if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`);
    return r.status() === 204 ? null : r.json();
  };
  return { call };
}

let counter = 0;
const key = (prefix: string) => `${prefix}_e2e${String(counter++).padStart(6, '0')}`;
const options = (...labels: string[]) => labels.map((label) => ({ key: key('o'), label }));

/** A definition using every Phase 1 question type, as plain JSON. */
export function allTypesDefinition(required = true) {
  const q = (type: string, title: string, extra: Record<string, unknown>) => ({
    kind: 'question',
    key: key('q'),
    type,
    title,
    required,
    ...extra,
  });
  return {
    schemaVersion: 1,
    defaultLocale: 'en',
    hiddenFields: [],
    settings: {
      showProgressBar: true,
      allowBack: true,
      thankYou: { title: 'Thank you!', body: 'All done.' },
    },
    pages: [
      {
        key: key('p'),
        title: 'Choices',
        elements: [
          { kind: 'text', key: key('t'), body: 'Welcome to the accessibility check.' },
          q('single_choice', 'Pick a colour', {
            options: [...options('Red', 'Blue'), { key: key('o'), label: 'Other', isOther: true }],
            config: { randomize: false },
          }),
          q('multi_choice', 'Pick some fruit', {
            options: options('Apple', 'Pear', 'Plum'),
            config: { randomize: false, maxSelections: 2 },
          }),
          q('dropdown', 'Pick a country', {
            options: options('France', 'Japan'),
            config: { randomize: false },
          }),
          q('likert', 'It was easy to use', {
            options: ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'].map(
              (label, i) => ({ key: key('o'), label, value: i + 1 }),
            ),
            config: {},
          }),
        ],
      },
      {
        key: key('p'),
        title: 'Scales and text',
        elements: [
          q('rating', 'Rate the service', { config: { scale: 5, icon: 'star' } }),
          q('nps', 'How likely are you to recommend us?', {
            config: { lowLabel: 'Not likely', highLabel: 'Very likely' },
          }),
          q('short_text', 'Your nickname', { config: { maxLength: 50 } }),
          q('long_text', 'Any comments?', { config: { maxLength: 2000 } }),
          q('email', 'Email address', { config: {} }),
          q('date', 'Date of visit', { config: {} }),
        ],
      },
    ],
  };
}

/** Create and publish a survey through the API; returns its public URL and id. */
export async function publishViaApi(request: APIRequestContext, definition: object, title = 'E2E survey') {
  const { call } = await apiSession(request);
  const survey = await call('POST', '/surveys', { title });
  const draft = await call('GET', `/surveys/${survey.id}/draft`);
  const saved = await call(
    'PUT',
    `/surveys/${survey.id}/draft`,
    { definition },
    { 'if-match': `"rev-${draft.revision}"` },
  );
  const published = await call('POST', `/surveys/${survey.id}/publish`, { revision: saved.revision });
  return { id: survey.id as string, url: published.publicUrl as string, call };
}
