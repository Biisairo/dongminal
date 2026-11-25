import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// PERF 3.4.12.8 — 모바일 묶음 (perf/M3_BOOT_SCOPE.md §3 `mobile`).
//
// 모바일 본체(MobileController·서랍·키바)는 `mobile` 묶음이고, 키바의 순수 함수는 라이브러리 묶음 `keybar` 다
// (`mobile`·`settings` 가 needs 로 싣는다). 부팅 쪽 껍데기 `MobileShell` 은 데스크톱의 답을 낸다. 모바일이어야 하면
// 부팅 때(첫 렌더 앞), 부팅 뒤에는 resize 로 모바일이 될 때 싣고 본체로 바꾼다. 본체가 서기 전에는 데스크톱이다.

const MOBILE_JS = /\/b\/mobile\.js(\?|$)/;
const KEYBAR_JS = /\/b\/keybar\.js(\?|$)/;

function countBundles(page: Page) {
  const seen = { mobile: 0, keybar: 0 };
  page.on('request', (r) => {
    if (MOBILE_JS.test(r.url())) seen.mobile++;
    if (KEYBAR_JS.test(r.url())) seen.keybar++;
  });
  return seen;
}

test('TC-MOBB-1: 데스크톱 부팅은 mobile·keybar 를 받지 않고, 설정을 열면 keybar 만 받는다', async ({ page }) => {
  const seen = countBundles(page);
  await waitForInit(page);
  expect(seen).toEqual({ mobile: 0, keybar: 0 });
  expect(await page.evaluate('typeof MobileController')).toBe('undefined');
  expect(await page.evaluate(() => (window as any).app.mobile.loaded)).toBe(false);
  await expect(page.locator('#mobile-keybar .mkb-btn')).toHaveCount(0);

  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await expect(page.locator('#ds-keybar .kbc-row').first()).toBeAttached({ timeout: 10000 });
  expect(seen).toEqual({ mobile: 0, keybar: 1 });
});

test('TC-MOBB-2: 폭을 줄이면 묶음을 실은 뒤 모바일 UI 가 선다(그 전에는 데스크톱)', async ({ page }) => {
  const seen = countBundles(page);
  await waitForInit(page, { viewport: { width: 1280, height: 720 } });
  await page.setViewportSize({ width: 1280, height: 720 });
  // 픽스처는 표시 모드를 desktop 으로 고정한다 — 폭을 따르게 푼다.
  await page.evaluate(() => sessionStorage.setItem('displayMode', 'auto'));
  expect(seen.mobile).toBe(0);

  let release: () => void = () => {};
  const held = new Promise<void>((res) => { release = res });
  await page.route(MOBILE_JS, async (r) => { await held; await r.continue() });
  await page.setViewportSize({ width: 420, height: 860 });
  await expect.poll(() => seen.mobile, { timeout: 10000 }).toBe(1);
  // 묶음이 오기 전: 데스크톱의 답
  expect(await page.evaluate(() => (window as any).app.isMobile)).toBe(false);
  await expect(page.locator('body')).not.toHaveClass(/\bmobile\b/);

  release();
  await expect(page.locator('body')).toHaveClass(/\bmobile\b/, { timeout: 10000 });
  await expect(page.locator('#mobile-keybar .mkb-btn').first()).toBeVisible();
  await page.click('#m-drawer-toggle');
  await expect(page.locator('#sidebar')).toHaveClass(/\bopen\b/);
  await expect(page.locator('body')).toHaveClass(/\bdrawer-open\b/);
  await page.locator('#drawer-close').click();
  await expect(page.locator('#sidebar')).not.toHaveClass(/\bopen\b/);

  // 다시 넓히면 본체가 데스크톱으로 되돌린다. 묶음은 더 받지 않는다.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator('body')).not.toHaveClass(/\bmobile\b/);
  expect(seen).toEqual({ mobile: 1, keybar: 1 });
});

test('TC-MOBB-3: 모바일 뷰포트로 부팅하면 첫 화면부터 키바·서랍이 선다', async ({ page }) => {
  const seen = countBundles(page);
  await waitForInit(page, { mode: 'mobile' });
  await expect(page.locator('body')).toHaveClass(/\bmobile\b/);
  expect(await page.evaluate(() => (window as any).app.mobile.loaded)).toBe(true);
  await expect(page.locator('#mobile-keybar .mkb-btn').first()).toBeVisible();
  await page.click('#m-drawer-toggle');
  await expect(page.locator('#sidebar')).toHaveClass(/\bopen\b/);
  await page.locator('#drawer-backdrop').dispatchEvent('click');
  await expect(page.locator('#sidebar')).not.toHaveClass(/\bopen\b/);
  expect(seen).toEqual({ mobile: 1, keybar: 1 });
});
