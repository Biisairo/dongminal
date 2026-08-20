import { defineConfig, devices } from '@playwright/test';

// 이 실행의 격리된 DONGMINAL_HOME. global-setup 이 자기 실행의 홈을 지우지
// 않도록 setup/teardown 이 같은 값을 참조해야 한다 — playwright 는 webServer
// 를 globalSetup 보다 먼저 띄우므로, 이름으로만 판별하면 방금 뜬 서버의 홈을
// 삭제해 테스트 내내 영속화가 실패한다.
export const E2E_HOME = '/tmp/dongminal-e2e-' + Date.now() + '-' + process.pid;

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e',
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
      DONGMINAL_HOME: E2E_HOME,
    },
    timeout: 60_000,
  },
});
