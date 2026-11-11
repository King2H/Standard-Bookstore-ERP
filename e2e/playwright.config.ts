import { defineConfig } from '@playwright/test';

/**
 * The key journeys, end to end (#33, owner decisions 1a, 2a): through the
 * screens of a running bookstore. In CI it is the production images started
 * with deploy/compose.yaml (E2E_BASE_URL=https://localhost); locally, the
 * development servers (npm run dev:api, npm run dev:web).
 *
 * The journeys share one shop and each sets up its own books and people.
 * Day close closes the shop's day, so it runs last, after the others.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: './report' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    // The install's own certificate authority signs its certificate.
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'journeys', testIgnore: /day-close/ },
    { name: 'day-close', testMatch: /day-close/, dependencies: ['journeys'] },
  ],
});
