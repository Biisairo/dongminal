import { Page } from '@playwright/test';

import { test, expect, waitSettled } from './fixtures';

/**
 * UX_BATCH5_SRS 묶음 B — 컨테이너 런타임의 상태별 갈래 (FR-SRT-5~8).
 *
 * **런타임을 요구하지 않는다.** 재는 것은 "상태를 받았을 때 무엇을 보이는가" 이고,
 * 그 상태는 `/api/sandbox/runtime` 의 응답 하나에서 온다 — 그래서 위조한다.
 * 실제 판정은 Go 단위(`internal/shared/sandbox/runtime_test.go`)의 몫이다.
 *
 * 고치는 결함은 §2.3 이다: `Wire` 가 바이너리 유무만 보므로 **데몬이 죽어도
 * 프로파일 목록이 정상으로 왔고**(실측 확인), 실패가 창을 만드는 순간까지 미뤄져
 * 사용자에게는 "버튼이 고장났다" 로 보였다.
 */

const SCRATCH = {
  name: 'scratch', image: 'debian:stable-slim', isolated: true, helper: false, work: 'copy',
};

type RT = {
  state: string; os?: string; path?: string; detail?: string;
  installCommand?: string; startCommand?: string; startTryable?: boolean;
};

// FR-SRT-1: **명령은 응답이 싣는다** — 화면이 `os` 로 다시 고르지 않는다 (D-3).
// 그래서 위조 응답도 그 필드를 갖는다: 여기서 생략하면 실제 계약과 다른 것을 잰다.
const OS_DEFAULTS: Record<string, Partial<RT>> = {
  darwin: {
    installCommand: 'brew install --cask docker',
    startCommand: 'open -a Docker', startTryable: true,
  },
  linux: {
    installCommand: 'curl -fsSL https://get.docker.com | sh',
    startCommand: 'sudo systemctl start docker', startTryable: false,
  },
};

async function withRuntime(page: Page, ...states: RT[]) {
  // 여러 개를 주면 부를 때마다 다음 것으로 넘어간다 — 마지막은 계속 반복된다.
  // FR-SRT-7 의 폴링("실행한 뒤 ok 가 되기를 기다린다")을 재려면 응답이 바뀌어야 한다.
  let i = 0;
  await page.route('**/api/sandbox/runtime', (route) => {
    const s = states[Math.min(i, states.length - 1)];
    i++;
    const os = s.os || 'darwin';
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        os, runtime: 'docker', path: '', detail: '',
        ...(OS_DEFAULTS[os] || {}), ...s,
      }),
    });
  });
}

async function withStart(page: Page, res: { started: boolean; command: string; detail?: string }) {
  await page.route('**/api/sandbox/runtime/start', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ detail: '', ...res }),
    }));
}

async function withProfiles(page: Page, list: unknown[]) {
  await page.route('**/api/sandbox/profiles', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) }));
}

async function goto(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#add-sandbox-window', { timeout: 15000 });
  // **화면이 멎을 때까지 기다린다** (E2E_QUIESCENCE_SRS FR-EQS-5·6). 뿌리 편집기
  // 창들은 초기 저장이 도는 동안 뒤늦게 선다 — 그 전에 창 수를 세면 기준값이
  // 0 이고, 나중에 센 값과 어긋난다 (러너 실측: 0 을 기대했는데 3 이었다).
  await waitSettled(page);
}

// FR-SRT-8: 새 껍데기를 만들지 않는다 — 기존 확인창 위에 선다.
const rt = (page: Page) => page.locator('.confirm-overlay:has(.sbx-rt)');
const pick = (page: Page) => page.locator('.confirm-overlay:has(.sbx-pick)');

test.describe('묶음 B — 런타임 상태별 갈래', () => {
  test('S1 (V-SRT-1 / FR-SRT-5·6): 미설치면 설치 안내와 그 OS 의 명령이 나온다',
    async ({ page }) => {
      await withRuntime(page, { state: 'missing', os: 'darwin' });
      await withProfiles(page, [SCRATCH]);
      await goto(page);
      await page.locator('#add-sandbox-window').click();

      await expect(rt(page)).toBeVisible({ timeout: 10000 });
      await expect(rt(page)).toHaveAttribute('data-state', 'missing');
      // **그 OS 의 명령 하나**다 — 셋을 다 보이면 둘은 잡음이다 (FR-SRT-6).
      await expect(rt(page).locator('.sbx-rt-cmd')).toHaveText('brew install --cask docker');
      await expect(rt(page).locator('.sbx-rt-copy')).toBeVisible();
      // 설치하고도 같은 모달을 다시 보지 않으려면 이 문장이 있어야 한다 —
      // `Wire` 가 기동 때 한 번 도는 것이 근거다 (§2.3).
      await expect(rt(page)).toContainText('다시 시작');
      // 고를 프로파일이 없다 — 선택창은 뜨지 않는다.
      await expect(pick(page)).toHaveCount(0);
    });

  test('S2 (V-SRT-2 / FR-SRT-5·7): 미실행이면 실행할지 묻는다', async ({ page }) => {
    await withRuntime(page, { state: 'stopped', os: 'darwin', path: '/usr/local/bin/docker' });
    await withProfiles(page, [SCRATCH]);
    await goto(page);
    await page.locator('#add-sandbox-window').click();

    await expect(rt(page)).toBeVisible({ timeout: 10000 });
    await expect(rt(page)).toHaveAttribute('data-state', 'stopped');
    // 설치되어 있다는 사실과 실행할 것인지 — 둘 다 말한다.
    await expect(rt(page).locator('.sbx-rt-start')).toBeVisible();
    await expect(pick(page)).toHaveCount(0);
  });

  /**
   * FR-SRT-7 의 요점: 실행이 끝나면 **원래 하려던 일로 이어진다.** 사용자가 버튼을
   * 다시 누르게 하면 "실행했는데 아무 일도 없었다" 가 된다.
   */
  test('S3 (V-SRT-3 / FR-SRT-7): 실행해서 ok 가 되면 프로파일 선택창으로 이어진다',
    async ({ page }) => {
      // 첫 조회는 stopped, 그 다음부터 ok — 폴링이 그 전이를 본다.
      await withRuntime(page,
        { state: 'stopped', os: 'darwin' },
        { state: 'ok', os: 'darwin' });
      await withStart(page, { started: true, command: 'open -a Docker' });
      await withProfiles(page, [SCRATCH]);
      await goto(page);
      await page.locator('#add-sandbox-window').click();
      await expect(rt(page)).toBeVisible({ timeout: 10000 });

      await rt(page).locator('.sbx-rt-start').click();
      // 진행 중에는 닫히지 않는다 — 상태만 바뀐다.
      await expect(rt(page).locator('.sbx-rt-note')).toBeVisible({ timeout: 5000 });
      // ok 가 되면 모달이 스스로 닫히고 하려던 일이 이어진다.
      await expect(rt(page)).toHaveCount(0, { timeout: 30000 });
      await expect(pick(page)).toBeVisible({ timeout: 10000 });
    });

  test('S4 (V-SRT-4 / FR-SRT-7): 기동이 실패하면 사유가 그 자리에 남고 닫히지 않는다',
    async ({ page }) => {
      await withRuntime(page, { state: 'stopped', os: 'darwin' });
      await withStart(page, {
        started: false, command: 'open -a Docker',
        detail: "Unable to find application named 'Docker'",
      });
      await withProfiles(page, [SCRATCH]);
      await goto(page);
      await page.locator('#add-sandbox-window').click();
      await expect(rt(page)).toBeVisible({ timeout: 10000 });

      await rt(page).locator('.sbx-rt-start').click();
      // 사유를 읽을 자리가 남아야 한다 — 닫으면 그 자리가 사라진다 (FR-GIT-175 와 같은 근거).
      await expect(rt(page).locator('.sbx-rt-note')).toContainText('Unable to find', { timeout: 10000 });
      await expect(rt(page)).toBeVisible();
    });

  test('S5 (V-SRT-5 / FR-SRT-5): ok 면 종전 흐름 그대로다', async ({ page }) => {
    await withRuntime(page, { state: 'ok', os: 'darwin' });
    await withProfiles(page, [SCRATCH]);
    await goto(page);
    await page.locator('#add-sandbox-window').click();

    // 런타임 모달은 서지 않는다 — 물을 것이 없다.
    await expect(pick(page)).toBeVisible({ timeout: 10000 });
    await expect(rt(page)).toHaveCount(0);
  });

  /**
   * FR-SRT-3 / D-5: linux 의 데몬 기동은 권한을 요구한다. 서버가 `sudo` 를 부르면
   * 비밀번호를 받을 길이 없어 무응답으로 멈추므로, 실행 버튼 대신 **칠 명령**을 준다.
   *
   * OS 의 출처가 서버 응답인 것도 여기서 드러난다 — 브라우저는 darwin 이다 (D-3).
   */
  test('S6 (V-SRT-6 / FR-SRT-3·7): linux 에서는 실행 버튼 대신 명령을 준다',
    async ({ page }) => {
      await withRuntime(page, { state: 'stopped', os: 'linux' });
      await withProfiles(page, [SCRATCH]);
      await goto(page);
      await page.locator('#add-sandbox-window').click();
      await expect(rt(page)).toBeVisible({ timeout: 10000 });

      await expect(rt(page).locator('.sbx-rt-start')).toHaveCount(0);
      await expect(rt(page).locator('.sbx-rt-cmd')).toHaveText('sudo systemctl start docker');
      await expect(rt(page).locator('.sbx-rt-copy')).toBeVisible();
    });

  /**
   * FR-SRT-8: 본문은 `textContent` 로 넣는다. 여기 오는 문자열은 런타임이 만든
   * 진단이며, `innerHTML` 에 끼우면 그 내용이 마크업으로 해석된다 (`_notify` 의
   * 근거와 같다).
   */
  test('S7 (V-SRT-7 / FR-SRT-8): 진단 문자열이 마크업으로 해석되지 않는다',
    async ({ page }) => {
      await withRuntime(page, { state: 'stopped', os: 'darwin' });
      await withStart(page, {
        started: false, command: 'open -a Docker',
        detail: '<img src=x onerror="window.__pwned=1"> failed',
      });
      await withProfiles(page, [SCRATCH]);
      await goto(page);
      await page.locator('#add-sandbox-window').click();
      await expect(rt(page)).toBeVisible({ timeout: 10000 });
      await rt(page).locator('.sbx-rt-start').click();

      await expect(rt(page).locator('.sbx-rt-note')).toContainText('failed', { timeout: 10000 });
      // 글자로 남아 있어야 한다 — 요소가 되면 해석된 것이다.
      await expect(rt(page).locator('.sbx-rt-note img')).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    });

  test('S8 (V-SRT-8 / FR-SRT-5): 런타임 모달을 닫으면 창을 만들지 않는다',
    async ({ page }) => {
      await withRuntime(page, { state: 'missing', os: 'darwin' });
      await withProfiles(page, [SCRATCH]);
      await goto(page);
      const before = await page.evaluate(() => (window as any).app.ws.windows.length);
      await page.locator('#add-sandbox-window').click();
      await expect(rt(page)).toBeVisible({ timeout: 10000 });

      await rt(page).locator('.confirm-cancel').click();
      await expect(rt(page)).toHaveCount(0);
      await expect(pick(page)).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).app.ws.windows.length)).toBe(before);
    });
});
