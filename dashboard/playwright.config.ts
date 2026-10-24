import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 45000,
  expect: { timeout: 10000 }, reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure', channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Edge'], viewport: { width: 1280, height: 900 } } }, { name: 'mobile', use: { ...devices['Desktop Edge'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } }, { name: 'tablet', use: { ...devices['Desktop Edge'], viewport: { width: 768, height: 1024 } } }],
  webServer: { command: process.platform === 'win32' ? 'npm.cmd run dev' : 'npm run dev', url: 'http://127.0.0.1:3000', reuseExistingServer: !process.env.CI, timeout: 120000 }
});
