/**
 * Automated WCAG 2.1 A/AA checks (axe-core). Acceptance criterion: zero serious or critical
 * violations for every Phase 1 question type. Automated checks catch roughly a third of issues,
 * so docs/a11y-p1.md records the manual screen-reader pass as well.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { allTypesDefinition, publishViaApi, signupInUi } from './helpers';

async function expectNoSeriousViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} → ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 3)
          .join(' | ')}`,
    ),
    context,
  ).toEqual([]);
}

test('respondent pages with every question type have no serious accessibility violations', async ({
  page,
  request,
}) => {
  const { url } = await publishViaApi(request, allTypesDefinition(true));
  await page.goto(url);
  await expect(page.getByText('Pick a colour')).toBeVisible();
  await expectNoSeriousViolations(page, 'page 1');

  // Error state: summary, inline errors, aria-invalid.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expectNoSeriousViolations(page, 'page 1 with errors');

  // Keyboard only: arrow keys move within radio groups, space toggles checkboxes.
  await page.getByRole('radio', { name: 'Red' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: 'Blue' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Apple' }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('checkbox', { name: 'Apple' })).toBeChecked();
  await page.getByLabel(/Pick a country/).selectOption({ label: 'Japan' });
  await page.getByRole('radio', { name: 'Agree', exact: true }).check({ force: true });
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByText('Rate the service')).toBeVisible();
  await expectNoSeriousViolations(page, 'page 2');
});

test('admin pages have no serious accessibility violations', async ({ page }) => {
  await page.goto('/login');
  await expectNoSeriousViolations(page, 'login');
  await signupInUi(page);
  await expectNoSeriousViolations(page, 'survey list');
  await page.getByRole('button', { name: 'New survey' }).click();
  await page.getByLabel('Title').fill('A11y survey');
  await page.getByRole('button', { name: 'Create survey' }).click();
  await page.getByRole('button', { name: '+ Add question' }).click();
  await page.getByRole('button', { name: /^Multiple choice/ }).click();
  await page.getByLabel('Question', { exact: true }).fill('Which channels?');
  await expect(page.getByText('All changes saved')).toBeVisible();
  await expectNoSeriousViolations(page, 'builder');
});
