import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// PERF 3.4.12.3 — 진단 오버레이 묶음 (perf/M3_BOOT_SCOPE.md §3 `diag`).
//
// 부팅 묶음은 diag.js 를 담지 않는다. 페이지의 인라인 스크립트가 `?diag=1` 일 때만 `b/diag.js` 를
// `b/boot.js` 바로 뒤에 싣는다 — 실리는 순서가 종전(부팅 묶음의 끝)과 같다.

const BUNDLE = /\/b\/diag\.js\?/;

function countBundle(page: Page) {
  const seen = { n: 0 };
  page.on('request', (r) => { if (BUNDLE.test(r.url())) seen.n++ });
  return seen;
}

test('TC-DGB-1: 파라미터가 없으면 b/diag.js 를 받지 않고 오버레이도 없다', async ({ page }) => {
  const seen = countBundle(page);
  await waitForInit(page);
  expect(seen.n).toBe(0);
  expect(await page.evaluate('typeof DiagOverlay')).toBe('undefined');
  await expect(page.locator('#diag-ov')).toHaveCount(0);
});

test('TC-DGB-2: ?diag=1 이면 b/diag.js 를 한 번 받고 오버레이가 선다', async ({ page }) => {
  const seen = countBundle(page);
  await page.goto('/?diag=1');
  await expect(page.locator('#diag-ov')).toHaveCount(1);
  expect(seen.n).toBe(1);
  await expect(page.locator('#diag-ov .dg-log')).toContainText('innerW/H=', { timeout: 10000 });
});
