/** Respondents never lose answers: resume after closing the tab, and retry while offline. */
import { expect, test } from '@playwright/test';
import { publishViaApi } from './helpers';

const twoPages = () => ({
  schemaVersion: 1,
  defaultLocale: 'en',
  hiddenFields: [],
  settings: { showProgressBar: true, allowBack: true, thankYou: { title: 'Thanks!', body: 'Recorded.' } },
  pages: [
    {
      key: 'p_resil00001',
      elements: [
        {
          kind: 'question',
          key: 'q_resil00001',
          type: 'short_text',
          title: 'Your team',
          required: true,
          config: { maxLength: 100 },
        },
      ],
    },
    {
      key: 'p_resil00002',
      elements: [
        {
          kind: 'question',
          key: 'q_resil00002',
          type: 'rating',
          title: 'Rate us',
          required: true,
          config: { scale: 5, icon: 'number' },
        },
      ],
    },
  ],
});

test('resumes where the respondent left off after the tab is closed', async ({ page, request }) => {
  const { url } = await publishViaApi(request, twoPages());
  await page.goto(url);
  await page.getByLabel(/Your team/).fill('Platform');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Page 2 of 2' })).toBeFocused();

  await page.reload(); // same browser: local copy plus the server copy
  await expect(page.getByRole('heading', { name: 'Page 2 of 2' })).toBeVisible();
  await page.goto('about:blank'); // "close the tab" and come back later
  await page.goto(url);
  await expect(page.getByText('Rate us')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel(/Your team/)).toHaveValue('Platform');
});

test('keeps answers and retries while offline, creating exactly one response', async ({
  page,
  context,
  request,
}) => {
  const { id, url, call } = await publishViaApi(request, twoPages());
  await page.goto(url);
  await page.getByLabel(/Your team/).fill('Data');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('radio', { name: '4 of 5', exact: true }).check({ force: true });

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText("We can't reach the server")).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByRole('heading', { name: 'Thanks!' })).toBeVisible({ timeout: 30_000 });

  const responses = await call('GET', `/surveys/${id}/responses`);
  expect(responses.data).toHaveLength(1);
  expect(responses.data[0].status).toBe('completed');
});
