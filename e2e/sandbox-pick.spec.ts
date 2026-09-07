import { Page } from '@playwright/test';

import { test, expect, waitSettled } from './fixtures';

// SANDBOX_PICK_COPY_SRS §4 — 선택창의 검증 V-SPK-1~9.
//
// **컨테이너 런타임을 요구하지 않는다.** 이 묶음이 재는 것은 "무엇을 묻는가" 이고
// 그 답은 `/api/sandbox/profiles` 의 응답 하나에서 나온다 — 창을 실제로 열지
// 않으므로(전부 취소로 끝난다) docker 가 없는 호스트에서도 돈다. 컨테이너가
// 실제로 도는지는 sandbox-window.spec.ts 의 몫이다.

const SCRATCH = { name: 'scratch', image: 'debian:stable-slim', isolated: true, helper: false, work: 'copy' };
const DEV = { name: 'dev', image: 'node:22', isolated: false, helper: true, work: 'mount' };

async function withProfiles(page: Page, list: unknown[]) {
  await page.route('**/api/sandbox/profiles', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) }));
}

/**
 * UX_BATCH5_SRS FR-SRT-5: 버튼이 프로파일보다 **먼저** 런타임 상태를 묻는다.
 *
 * 이 묶음이 재는 것은 그 뒤의 갈래(무엇을 묻는가)이므로 앞 갈래를 고정해야 한다 —
 * 고정하지 않으면 **docker 데몬이 죽은 호스트에서 전부 깨진다**: 런타임 모달이
 * 서서 선택창까지 닿지 못한다. 파일 머리의 "런타임을 요구하지 않는다" 가 계속
 * 참이려면 이것이 있어야 한다. 상태별 갈래 자체는 `sandbox-runtime.spec.ts` 다.
 */
async function withRuntimeOK(page: Page) {
  await page.route('**/api/sandbox/runtime', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        state: 'ok', os: 'darwin', runtime: 'docker', path: '/usr/local/bin/docker',
        detail: '', installCommand: '', startCommand: 'open -a Docker', startTryable: true,
      }),
    }));
}

async function goto(page: Page) {
  await withRuntimeOK(page);
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#add-sandbox-window', { timeout: 15000 });
  // **화면이 멎을 때까지 기다린다** (E2E_QUIESCENCE_SRS FR-EQS-5·6). 뿌리 편집기
  // 창들은 초기 저장이 도는 동안 뒤늦게 선다 — 그 전에 창 수를 세면 기준값이
  // 0 이고, 나중에 센 값과 어긋난다 (러너 실측: 0 을 기대했는데 3 이었다).
  await waitSettled(page);
}

const dialog = (page: Page) => page.locator('.confirm-overlay:has(.sbx-pick)');
const opt = (page: Page, name: string) =>
  dialog(page).locator('.sbx-opt', { hasText: name });

test.describe('묶음 P — 선택창은 언제나 뜬다', () => {
  test('P1 (V-SPK-1·3): scratch 하나뿐이어도 창과 작업 폴더 입력이 나온다',
    async ({ page }) => {
      await withProfiles(page, [SCRATCH]);
      await goto(page);
      await page.locator('#add-sandbox-window').click();

      // 고치기 전에는 `mustAsk` 가 거짓이라 창 없이 곧바로 열렸다 (§2.1 실측).
      await expect(dialog(page)).toBeVisible({ timeout: 10000 });
      const input = dialog(page).locator('.sbx-workdir input');
      await expect(input).toBeVisible();
      // FR-SPK-4: 비어 있는 것이 기본이다 — 승계는 사용자가 고르지 않은 자리를
      // 조용히 컨테이너로 들여보내는 일이다.
      await expect(input).toHaveValue('');
    });

  /**
   * P2 — **개정** (UX_BATCH6_SRS FR-SBM-1·4).
   *
   *   이전 계약: 프로파일 버튼이 자기 작업 방식을 배지로 보였다 (FR-SPK-5)
   *   새   계약: 작업 방식은 **고르는 값**이므로 전용 줄에 서고, 버튼에 겹쳐
   *              표기하지 않는다 — 두 자리가 같은 것을 말하면 어느 쪽이 지금
   *              값인지 알 수 없다
   *   이유:      접수 ② — "마운트가 없어도 마운트 선택 가능"
   *
   * 등급 배지는 그대로다. 등급은 프로파일의 성질이고 작업 방식은 이번 선택이다
   * (FR-SBM-4).
   */
  test('P2 (V-SBM-1·4): 작업 방식은 고르는 줄에 서고 등급은 프로파일의 것이다',
    async ({ page }) => {
      await withProfiles(page, [SCRATCH, DEV]);
      await goto(page);
      await page.locator('#add-sandbox-window').click();
      await expect(dialog(page)).toBeVisible({ timeout: 10000 });

      const picks = dialog(page).locator('.sbx-work-opt');
      await expect(picks).toHaveCount(2);
      await expect(picks.nth(0)).toHaveText('마운트');
      await expect(picks.nth(1)).toHaveText('복사');
      // FR-SBM-2: 기본 선택은 첫 프로파일(scratch)의 방식 — 복사다.
      await expect(dialog(page).locator('.sbx-work-opt.on')).toHaveText('복사');
      // 버튼에는 방식 배지가 없다.
      await expect(opt(page, 'scratch').locator('.sbx-work')).toHaveCount(0);
      // FR-SBM-4/6: 등급은 프로파일의 정책이다.
      await expect(opt(page, 'scratch').locator('.sbx-grade')).toHaveText('격리');
      await expect(opt(page, 'dev').locator('.sbx-grade')).toHaveText('비격리');
    });

  // V-SBM-1: **scratch 하나뿐이어도 마운트를 고를 수 있다.** 접수한 말의 핵이다.
  test('P2b (V-SBM-1): scratch 하나뿐이어도 마운트를 고른다', async ({ page }) => {
    await withProfiles(page, [SCRATCH]);
    await goto(page);
    await page.locator('#add-sandbox-window').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });
    const mount = dialog(page).locator('.sbx-work-opt[data-work="mount"]');
    await expect(mount).toBeVisible();
    await mount.click();
    await expect(mount).toHaveClass(/\bon\b/);
  });

  /**
   * V-SBM-3 (FR-SBM-5): 마운트 + 폴더를 고르면 **그 사실을 말한다.**
   *
   * 등급 배지와 다른 자리여야 한다 — 배지는 프로파일의 성질이고 이 줄은 이번
   * 선택의 결과다. 폴더를 비우면 사라진다: 넣을 것이 없으면 새는 것도 없다.
   */
  test('P2c (V-SBM-5): 마운트에 폴더를 넣으면 경고가 서고 지우면 사라진다',
    async ({ page }) => {
      await withProfiles(page, [SCRATCH]);
      await goto(page);
      await page.locator('#add-sandbox-window').click();
      const warn = dialog(page).locator('.sbx-work-warn');
      const input = dialog(page).locator('.sbx-workdir input');

      await dialog(page).locator('.sbx-work-opt[data-work="mount"]').click();
      await expect(warn).not.toHaveClass(/\bvis\b/);   // 폴더가 없으면 조용하다
      await input.fill('/tmp/some-dir');
      await expect(warn).toHaveClass(/\bvis\b/);
      await expect(warn).toContainText('격리 경계가 아닙니다');
      // 복사로 되돌리면 사라진다 — 복사에는 돌아오는 통로가 없다.
      await dialog(page).locator('.sbx-work-opt[data-work="copy"]').click();
      await expect(warn).not.toHaveClass(/\bvis\b/);
      await dialog(page).locator('.sbx-work-opt[data-work="mount"]').click();
      await expect(warn).toHaveClass(/\bvis\b/);
      await input.fill('');
      await expect(warn).not.toHaveClass(/\bvis\b/);
    });

  test('P3 (V-SPK-6·7): scratch 하나뿐이면 dev 안내와 설정 버튼이 나온다',
    async ({ page }) => {
      await withProfiles(page, [SCRATCH]);
      await goto(page);
      await page.locator('#add-sandbox-window').click();
      const hint = dialog(page).locator('.sbx-hint');
      await expect(hint).toContainText('dev 프로파일', { timeout: 10000 });

      // 설정으로 가는 길이 실제로 열린다 — 안내만 있고 길이 없으면 같은 자리에서 막힌다.
      await hint.locator('.sbx-settings').click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.locator('#modal-overlay')).toHaveClass(/open/);
      await expect(page.locator('#panel-sandbox')).toBeVisible();
    });

  test('P4: 프로파일이 둘이면 안내를 내지 않는다', async ({ page }) => {
    await withProfiles(page, [SCRATCH, DEV]);
    await goto(page);
    await page.locator('#add-sandbox-window').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });
    await expect(dialog(page).locator('.sbx-hint')).toHaveCount(0);
  });

  test('P5 (V-SPK-8): Esc 로 닫으면 창이 열리지 않는다', async ({ page }) => {
    await withProfiles(page, [SCRATCH]);
    await goto(page);
    const before = await page.locator('#windows .si').count();
    await page.locator('#add-sandbox-window').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    // 잠시 두어도 창이 늘지 않는다 — 취소는 취소다.
    await page.waitForTimeout(500);
    expect(await page.locator('#windows .si').count()).toBe(before);
  });

  test('P6 (V-SPK-2): 프로파일이 없으면 창 대신 사유를 알린다', async ({ page }) => {
    await withProfiles(page, []);
    await goto(page);
    await page.locator('#add-sandbox-window').click();
    await expect(dialog(page)).toHaveCount(0);
    // FR-SBX-20: 눌러도 아무 일이 없으면 버튼이 고장난 것으로 보인다.
    await expect(page.locator('body')).toContainText('컨테이너 런타임', { timeout: 10000 });
  });

  test('P7 (V-SPK-25): /api/sandbox/profiles 가 work 를 주고 workspace 를 주지 않는다',
    async ({ request }) => {
      const r = await request.get('/api/sandbox/profiles');
      expect(r.ok()).toBeTruthy();
      const list = await r.json();
      // 런타임이 없는 호스트에서는 빈 목록이다 — 그 경우 잴 것이 없다.
      test.skip(!Array.isArray(list) || list.length === 0, '샌드박스 프로파일이 없다');
      for (const p of list) {
        expect(['mount', 'copy', 'none']).toContain(p.work);
        // FR-SPK-24: 옛 불리언을 함께 두지 않는다 — 어느 것이 진실인지 판정하는
        // 자리가 생긴다.
        expect(p).not.toHaveProperty('workspace');
      }
      const scratch = list.find((p: { name: string }) => p.name === 'scratch');
      if (scratch) {
        expect(scratch.work).toBe('copy');
        expect(scratch.isolated).toBe(true);
      }
    });
});
