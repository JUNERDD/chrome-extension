import { defineConfig } from '@playwright/test';

const fixturePort = 41_731;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${fixturePort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node tests/fixtures/server.mjs ${fixturePort}`,
    url: `http://127.0.0.1:${fixturePort}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
