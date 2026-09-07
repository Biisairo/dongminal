import { cpus } from 'os';

import { defineConfig, devices } from '@playwright/test';

import { isWin, tmpPath } from './e2e/osenv';

// 이 실행의 뿌리. **워커마다 그 아래 자기 인스턴스 홈을 갖는다**
// (E2E_PARALLEL_SRS FR-EPL-1) — `<run>/w0`, `<run>/w1` …
//
// **환경변수를 먼저 보는 것이 핵심이다.** 이 파일은 워커 프로세스마다 다시
// 평가되므로, 여기서 `Date.now()+pid` 로 만들면 워커마다 **다른 뿌리**가 나온다
// (실측: 워커가 자기만의 뿌리를 만들고 그 아래 없는 바이너리를 실행해 ENOENT).
// `globalSetup` 이 이 값을 `DM_E2E_RUN` 에 박고, 워커는 그것을 읽는다.
export const E2E_RUN_ENV = 'DM_E2E_RUN';
export const E2E_HOME =
  process.env[E2E_RUN_ENV] || tmpPath('dongminal-e2e-' + Date.now() + '-' + process.pid);

// 서버 바이너리. `globalSetup` 이 한 번 만들고 워커가 그것을 실행한다
// (FR-EPL-8) — `go run` 을 워커마다 부르면 같은 컴파일을 N 번 기다린다.
export const E2E_BIN = E2E_HOME + '/dongminal-e2e' + (isWin ? '.exe' : '');

// 워커 0 의 포트. 워커 i 는 `E2E_PORT0 + i` 를 쓴다 (FR-EPL-1).
export const E2E_PORT0 = 58147;

/**
 * 워커 수 (FR-EPL-7).
 *
 * **코어 수의 1/3 이다.** 워커 하나가 브라우저 하나와 앱 인스턴스 하나를 든다:
 * 서버·데몬·PTY 여럿, 그리고 저장소를 쉬지 않고 관측하는 `git` 자식 프로세스들.
 * 10코어에서 5워커로 돌렸더니 매 회차 서로 다른 예닐곱이 **부하성 타임아웃**으로
 * 무너졌다 — 관측이 제때 닿지 못한 것이지 앱이 틀린 것이 아니다(실측).
 *
 * 병렬의 값은 그 지점에서 이미 다 받았다: 22분이 6분이 된 것은 워커 5 였지만
 * 3 이어도 8분대이고, **초록이 아닌 6분보다 초록인 8분이 낫다.**
 *
 * 상한이 있는 또 하나의 이유는 PTY 다 — macOS 의 `kern.tty.ptmx_max` 는 기본
 * 511 이고 인스턴스마다 그것을 나눠 쓴다 (R-1).
 */
function workerCount(): number {
  const env = parseInt(process.env.PW_WORKERS || '', 10);
  if (Number.isFinite(env) && env > 0) return env;
  const n = cpus().length || 2;
  return Math.max(2, Math.min(Math.floor(n / 3), 4));
}

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  /**
   * 재시도는 **한 번**이다 (CI_E2E_MATRIX_SRS FR-CEM-17).
   *
   * 재시도의 값은 "산발적 실패를 한 번 더 눌러 본다" 이고 그 값은 **두 번째
   * 시도에서 거의 다 나온다** — 세 번째는 값이 아니라 비용이다. 실패 하나가
   * 세 번 도는 동안 나머지가 밀렸고, Windows 4샤드 회차에서 한 샤드가 23분에
   * 74항목만 지난 채 247항목을 남기고 잘린 것이 그 계산의 결과였다.
   */
  retries: process.env.CI ? 1 : 0,
  /**
   * 실패의 상한 (FR-CEM-18).
   *
   * 어느 샤드가 20건을 넘겨 실패하고 있다면 그것은 **개별 결함이 아니라 계통의
   * 문제**다 — 남은 항목을 마저 돌려도 같은 사유가 반복될 뿐이고, 그 반복이
   * 러너의 한 시간을 먹는다. 거기서 멈추고 목록을 넘긴다.
   *
   * 로컬은 상한이 없다(0). 고치는 사람은 전체 목록을 봐야 한다.
   */
  maxFailures: process.env.CI ? 20 : 0,
  /**
   * E2E_PARALLEL_SRS D-1·D-2: 갈리는 단위는 **파일**이다.
   *
   * 막고 있던 것은 `fullyParallel` 이 아니라 **서버의 단일성**이었다 — 테스트
   * 전부가 한 인스턴스를 공유하고 픽스처가 매 테스트 앞에서 그 워크스페이스를
   * 비웠다(E2E_QUIESCENCE_SRS). 워커마다 인스턴스를 하나씩 주면 그 규약이
   * 그대로 성립한다: 비우는 대상이 자기 인스턴스다.
   *
   * `fullyParallel` 은 `false` 로 남는다. 파일 **안**의 순서 의존은 실재하고
   * (git 스펙의 여러 묶음), 그것을 흩는 것은 이 문서의 범위가 아니다.
   */
  workers: workerCount(),
  fullyParallel: false,
  /**
   * `html` 은 실패했을 때 올리는 산출물이고, `parity-reporter` 는 **동등성**을
   * 결과에서 읽게 한다 (CI_E2E_MATRIX_SRS FR-CEM-27) — 어느 OS 에서 몇 개가
   * 실제로 돌았고 몇 개가 어떤 사유로 건너뛰어졌는지. 두 OS 의 그 한 줄을
   * 나란히 놓으면 "같은 테스트가 같은 결과를 냈는가" 를 눈으로 가를 수 있다.
   */
  reporter: [['html'], ['./e2e/parity-reporter.ts']],
  /**
   * REFACTOR_STABILIZATION_SRS: 단정과 테스트의 기준 시간.
   *
   * playwright 의 기본값은 expect 5초 · 테스트 30초다. 스펙 하나만 돌릴 때는
   * 넉넉하지만 **1200개를 이어 돌리면 그렇지 않다** — 도구가 쌓이고 관측이
   * 밀리며, 그 지연이 단정 하나하나에 얹힌다. 실측에서 매 회차 서로 다른 한둘이
   * 이 5초에 걸려 무너졌고, 그때마다 그 스펙에 개별 타임아웃을 덧붙이는 식으로
   * 대응해 왔다.
   *
   * 기준선을 한 자리에서 올린다. 이것은 **재시도로 실패를 덮는 것과 다르다**
   * (그것은 이 SRS 의 비목표다): 실패는 여전히 실패로 남고, 다만 부하에서 앱이
   * 실제로 답하는 데 걸리는 시간을 기준이 인정한다.
   *
   * **병렬이 그 부하를 한 번 더 올렸다** (E2E_PARALLEL_SRS D-6). 워커마다 앱
   * 인스턴스가 하나씩 돌고, 그 인스턴스들이 같은 CPU 위에서 `git` 을 다툰다 —
   * 회차마다 **서로 다른** 예닐곱이 10초에 걸렸고 하나씩 격리해 돌리면 모두
   * 통과했다. Windows 는 그 위에 셸·파일 접근의 느림이 얹히므로 한 단계 더 준다.
   */
  expect: { timeout: isWin ? 20_000 : 15_000 },
  /**
   * CI_E2E_MATRIX_SRS FR-CEM-6: 테스트 하나의 상한.
   *
   * Windows 만 두 배인 것은 실측이다 — 그 OS 는 셸(pwsh·PSReadLine) 기동과 파일
   * 접근이 느려 항목당 시간이 다른 둘의 몇 배다. 60초는 monaco 가 처음 서는
   * 항목에서 **검사가 아니라 기다림**에 걸렸다 (러너 실측: `doc-render` 가 파일
   * 하나를 연 뒤 다음 하나를 열 시간이 남지 않았다).
   *
   * 이것은 실패를 덮는 것이 아니다. 실패는 그대로 실패로 남고, 다만 그 OS 에서
   * 앱이 **실제로 답하는 데 걸리는 시간**을 상한이 인정한다.
   */
  timeout: isWin ? 120_000 : 60_000,
  use: {
    // FR-EPL-2: 실제 값은 워커 픽스처가 자기 포트로 덮는다 (`e2e/fixtures.ts`).
    // 여기 있는 것은 그 픽스처를 쓰지 않는 자리를 위한 기본값이다.
    baseURL: 'http://localhost:' + E2E_PORT0,
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 720 },
    /**
     * 조작 하나의 상한 (CI_E2E_MATRIX_SRS FR-CEM-20).
     *
     * 기본값은 **없음**이다 — `click` 하나가 테스트 예산 전부를 먹는다. 그래서
     * 나타나지 않을 요소를 누르려던 검사가 Windows 에서 120초를 기다리고, 재시도가
     * 그것을 한 번 더 돌려 **실패 하나에 4분**을 썼다(러너 실측: 샤드 시간의
     * 대부분이 그 기다림이었다).
     *
     * 조작이 20초 안에 되지 않으면 그것은 느린 것이 아니라 **되지 않는 것**이다.
     * 단정(`expect`)의 상한은 그대로 두므로 "언제 나타나는가" 를 재는 검사는
     * 영향받지 않는다.
     */
    actionTimeout: 20_000,
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
  // `webServer` 는 없다 (D-3). 그것은 실행당 하나이고 워커를 모른다 — 서버는
  // 워커 스코프 픽스처가 띄운다.
});
