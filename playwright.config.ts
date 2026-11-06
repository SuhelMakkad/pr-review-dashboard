import { defineConfig, devices } from '@playwright/test';

const port = 4329;

/** End-to-end tests run against the built app in demo mode: no GitHub, no AI quota, fixed clock. */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'light',
      use: {
        ...devices['Desktop Chrome'],
        colorScheme: 'light',
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'dark',
      use: {
        ...devices['Desktop Chrome'],
        colorScheme: 'dark',
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: 'rm -rf .data-e2e && node apps/server/dist/index.js',
    url: `http://127.0.0.1:${port}/api/status`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      REVIEW_DESK_MODE: 'demo',
      REVIEW_DESK_PORT: String(port),
      REVIEW_DESK_DATA_DIR: '.data-e2e',
      REVIEW_DESK_DEMO_NOW: '2026-11-05T10:00:00.000Z',
    },
  },
});
