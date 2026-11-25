import { Page, Route } from '@playwright/test';

import { test, expect, waitForInit, waitShellReady, SPLIT_H } from './fixtures';

// PERF 3.4.12.4 — 터미널 찾기 묶음 (D-43, perf/M3_BOOT_SCOPE.md §3 `search`).
//
// 부팅은 vendor addon-search 와 찾기 줄 본문(search 묶음)을 받지 않는다. 찾기 줄을 처음 열면 묶음을 싣고 살아 있는
// 터미널 모두에 붙인다. 그 뒤 새로 연 터미널은 실린 묶음으로 바로 붙는다.

const SEARCH_REQ = /\/(b\/search\.js|vendor\/addon-search\.js)(\?|$)/;

function countSearch(page: Page) {
  const seen = { n: 0 };
  page.on('request', (r) => { if (SEARCH_REQ.test(r.url())) seen.n++ });
  return seen;
}

async function typeLine(page: Page, text: string) {
  await page.click('#area .pn.focused .xterm-screen');
  await page.keyboard.type('echo ' + text);
  await page.keyboard.press('Enter');
  await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText(text, { timeout: 10000 });
}

async function find(page: Page, q: string) {
  await page.keyboard.press('Control+f');
  await expect(page.locator('#search-bar')).toBeVisible();
  await page.locator('#search-input').fill(q);
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('#search-count')).toHaveText(/^\d+\/\d+$/, { timeout: 10000 });
}

test('TC-SRB-1: 부팅은 search 묶음을 받지 않고, Ctrl+F 가 묶음을 실은 뒤 찾기 줄을 열어 결과를 보인다', async ({ page }) => {
  const seen = countSearch(page);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r });
  await page.route(/\/b\/search\.js/, async (route: Route) => { await held; await route.continue() });
  await waitForInit(page);
  await waitShellReady(page);
  expect(seen.n, '부팅이 찾기 묶음을 받았다').toBe(0);
  expect(await page.evaluate(() => Screens.ready('search'))).toBe(false);
  await typeLine(page, 'srb1_needle');

  // 묶음이 오기 전에는 줄을 열지 않는다 — 열린 줄에서 찾기가 빈손이 되지 않게.
  await page.keyboard.press('Control+f');
  await expect.poll(() => seen.n).toBe(1);
  await expect(page.locator('#search-bar')).toBeHidden();
  release();
  await expect(page.locator('#search-bar')).toBeVisible();
  await page.locator('#search-input').fill('srb1_needle');
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('#search-count')).toHaveText(/^\d+\/\d+$/, { timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-bar')).toBeHidden();

  // 두 번째 열기는 다시 받지 않는다.
  await find(page, 'srb1_needle');
  expect(seen.n).toBe(1);
});

test('TC-SRB-2: 찾기 묶음이 실린 뒤 새로 연 터미널에서도 찾는다', async ({ page }) => {
  const seen = countSearch(page);
  await waitForInit(page);
  await waitShellReady(page);
  await typeLine(page, 'srb2_first');
  await find(page, 'srb2_first');
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-bar')).toBeHidden();

  const before = await page.locator('#area .pn').count();
  await page.click(SPLIT_H);
  await expect(page.locator('#area .pn')).toHaveCount(before + 1, { timeout: 10000 });
  await waitShellReady(page);
  expect(await page.evaluate(() => !!(window as any).app.tool.search.focusedTerminal()?.search),
    '새 터미널에 찾기 addon 이 붙지 않았다').toBe(true);
  await typeLine(page, 'srb2_second');
  await find(page, 'srb2_second');
  expect(seen.n).toBe(1);
});
