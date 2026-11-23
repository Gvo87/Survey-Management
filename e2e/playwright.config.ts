import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the running stack (API + worker, admin app, respondent app).
 * Locally they reuse `pnpm dev` if it's running; otherwise Playwright starts the servers.
 * Requires Postgres, Redis and Mailpit (`docker compose up -d`) and migrations.
 */
const reuse = !process.env.CI;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @survey/api dev',
      url: 'http://localhost:3000/readyz',
      reuseExistingServer: reuse,
      timeout: 120_000,
      cwd: '..',
    },
    {
      command: 'pnpm --filter @survey/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: reuse,
      timeout: 120_000,
      cwd: '..',
    },
    {
      command: 'pnpm --filter @survey/respondent dev',
      url: 'http://localhost:5174/preview',
      reuseExistingServer: reuse,
      timeout: 120_000,
      cwd: '..',
    },
  ],
});
