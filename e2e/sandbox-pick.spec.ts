import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

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

async function goto(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#add-sandbox-window', { timeout: 15000 });
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

  test('P2 (V-SPK-5): 프로파일 버튼이 작업 방식을 함께 보인다', async ({ page }) => {
    await withProfiles(page, [SCRATCH, DEV]);
    await goto(page);
    await page.locator('#add-sandbox-window').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });

    await expect(opt(page, 'scratch').locator('.sbx-work')).toHaveText('복사');
    await expect(opt(page, 'dev').locator('.sbx-work')).toHaveText('마운트');
    // FR-SPK-20: 복사는 등급을 낮추지 않는다 — scratch 는 여전히 경계다.
    await expect(opt(page, 'scratch').locator('.sbx-grade')).toHaveText('격리');
    await expect(opt(page, 'dev').locator('.sbx-grade')).toHaveText('비격리');
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
