import { mkdirSync } from 'fs';

import { defineConfig, devices } from '@playwright/test';

// 이 실행의 격리된 DONGMINAL_HOME. global-setup 이 자기 실행의 홈을 지우지
// 않도록 setup/teardown 이 같은 값을 참조해야 한다 — playwright 는 webServer
// 를 globalSetup 보다 먼저 띄우므로, 이름으로만 판별하면 방금 뜬 서버의 홈을
// 삭제해 테스트 내내 영속화가 실패한다.
export const E2E_HOME = '/tmp/dongminal-e2e-' + Date.now() + '-' + process.pid;

// 도구 셸의 홈. E2E_HOME **아래의 별도 칸**이다 — 인스턴스 홈을 그대로 셸의
// 홈으로 주면 셸이 `.zsh_history`·`.zcompdump` 를 workspace·tools 와 같은
// 디렉터리에 쓰고, 그 쓰기가 인스턴스의 저장과 같은 자리에서 겹친다.
export const E2E_TOOL_HOME = E2E_HOME + '/tool-home';
// 서버는 globalSetup 보다 먼저 뜬다. 셸이 없는 홈을 받지 않도록 여기서 만든다.
mkdirSync(E2E_TOOL_HOME, { recursive: true });

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
      // 마우스 경로. 터치 전용 스펙은 hasTouch 가 없어 여기서 돌 수 없다.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /-touch\.spec\.ts$/,
    },
    {
      // FR-MTB-7: 실기기 터치 경로. hasTouch 없이는 브라우저가 호환 마우스
      // 이벤트를 합성하지 않으므로, 키바의 tap → click 경로 결함을 볼 수 없다.
      name: 'mobile-touch',
      use: { ...devices['Pixel 7'] },
      testMatch: /-touch\.spec\.ts$/,
    },
  ],
  webServer: {
    command: 'go run ./cmd/dongminal start --foreground',
    url: 'http://localhost:58147/api/ping',
    reuseExistingServer: false,
    env: {
      PORT: '58147',
      DONGMINAL_HOME: E2E_HOME,
      // 도구 셸의 홈. DONGMINAL_HOME 격리만으로는 셸의 홈이 사용자 홈에 남는다 —
      // 도구 셸은 로그인 셸이라 rc 를 읽고 히스토리를 쓰므로, 스펙이 타이핑한
      // 명령이 사용자의 히스토리에 섞여 들어갔다. webServer 자신의 HOME 은
      // 건드리지 않는다 (go 빌드 캐시가 그 아래 있다).
      DONGMINAL_TOOL_HOME: E2E_TOOL_HOME,
    },
    timeout: 60_000,
  },
});
