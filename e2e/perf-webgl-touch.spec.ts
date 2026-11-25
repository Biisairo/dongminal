import { test, expect, waitForInit } from './fixtures';

// PERF 3.4.12.10 — 터치 기기는 addon-webgl 을 싣지 않는다 (perf/M3_BOOT_SCOPE.md §2, D-47).
// 터치 기기의 터미널은 DOM 렌더러다(`_gpuWant` 가 `_tsTouch` 로 거짓, D-TGR-6). 데스크톱 쪽(요청 1번)은
// `perf-uiact-bundle.spec.ts` TC-UAB-1 이 잰다.

test('TC-UAB-5: 터치 기기(pointer: coarse)는 addon-webgl 을 받지 않고 터미널은 DOM 렌더러로 선다', async ({ page }) => {
  let webgl = 0;
  page.on('request', (r) => { if (/\/vendor\/addon-webgl\.js(\?|$)/.test(r.url())) webgl++ });
  await waitForInit(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  expect(webgl).toBe(0);
  expect(await page.evaluate(() => typeof (window as any).WebglAddon)).toBe('undefined');
  await expect(page.locator('#area .xterm').first()).toBeVisible();
  expect(await page.evaluate(() => [...(window as any).app.tools.values()].some((p: any) => p._gpu))).toBe(false);
});
