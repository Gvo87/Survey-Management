/** Build → publish → respond (desktop and mobile) → analyze → export, all through the UI. */
import { readFileSync } from 'node:fs';
import { devices, expect, test } from '@playwright/test';
import { signupInUi } from './helpers';

test('a creator builds, publishes and analyzes a survey', async ({ page, browser }) => {
  await signupInUi(page);

  // Build
  await page.getByRole('button', { name: 'New survey' }).click();
  await page.getByLabel('Title').fill('E2E customer survey');
  await page.getByRole('button', { name: 'Create survey' }).click();
  await expect(page).toHaveURL(/\/edit$/);

  const addQuestion = async (type: RegExp, title: string, required = false) => {
    await page.getByRole('button', { name: '+ Add question' }).last().click();
    await page.getByRole('button', { name: type }).click();
    await page.getByLabel('Question', { exact: true }).fill(title);
    if (required) await page.getByLabel('Required').check();
  };
  await addQuestion(/^Net Promoter Score/, 'How likely are you to recommend us?', true);
  await addQuestion(/^Single choice/, 'Which plan are you on?');
  await addQuestion(/^Short text/, 'Anything else?');
  await expect(page.getByText('All changes saved')).toBeVisible();

  // The live preview shows the draft.
  const preview = page.frameLocator('iframe[title^="Respondent preview"]');
  await expect(preview.getByText('Anything else?')).toBeVisible();

  // Publish
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Version 1 is live.')).toBeVisible();
  const publicUrl = await page.locator('a[href*="/s/"]').first().getAttribute('href');
  expect(publicUrl).toMatch(/\/s\/[A-Za-z0-9]+$/);

  // Respond on desktop…
  const desktop = await browser.newPage();
  await desktop.goto(publicUrl!);
  await desktop.getByRole('button', { name: 'Submit' }).click();
  await expect(desktop.getByRole('alert')).toContainText('This question is required');
  await desktop.getByRole('radio', { name: '9', exact: true }).check({ force: true });
  await desktop.getByRole('radio', { name: 'Option 1' }).check();
  await desktop.getByLabel(/Anything else/).fill('Great product, "really"');
  await desktop.getByRole('button', { name: 'Submit' }).click();
  await expect(desktop.getByRole('heading', { name: 'Thank you!' })).toBeVisible();

  // …and on a phone.
  const phoneContext = await browser.newContext({ ...devices['Pixel 7'] });
  const phone = await phoneContext.newPage();
  await phone.goto(publicUrl!);
  await phone.getByRole('radio', { name: '3', exact: true }).check({ force: true });
  await phone.getByRole('button', { name: 'Submit' }).click();
  await expect(phone.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  await phoneContext.close();

  // Analyze
  await page.getByRole('link', { name: 'Results' }).click();
  await expect(page.locator('main')).toContainText('Completed2');
  await expect(async () => {
    await page.reload();
    await expect(page.locator('main')).toContainText('2 answered', { timeout: 2000 });
  }).toPass({ timeout: 30_000 }); // aggregates are updated by the worker
  await expect(page.getByText('Net Promoter Score', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Responses' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);

  // Export
  await page.getByRole('link', { name: 'Results' }).click();
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download CSV' }).click(),
  ]);
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain('How likely are you to recommend us?');
  expect(csv).toContain('"Great product, ""really"""');
  expect(csv.trim().split('\r\n')).toHaveLength(3);
});
