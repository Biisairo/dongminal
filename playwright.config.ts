import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:58147',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'go run cmd/dongminal/main.go',
    url: 'http://localhost:58147/api/ping',
    reuseExistingServer: false,
    env: {
      PORT: '58147',
      DONGMINAL_HOME: '/tmp/dongminal-e2e-' + Date.now(),
    },
    timeout: 60_000,
  },
});
