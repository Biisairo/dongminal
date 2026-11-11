import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * PANEL_LAYOUT_SRS — 탭별 패널 상태와 저장 레이아웃.
 *
 * 새 탭(`context.newPage()`)은 `localStorage` 를 함께 쓰고 `sessionStorage` 는 비어 있다 —
 * 실제 브라우저에서 새 탭을 여는 것과 같다.
 */
const side = (page: Page, key: 'sbSide' | 'agSide') =>
  page.evaluate((k) => document.documentElement.dataset[k], key);
const agOpen = (page: Page) =>
  page.evaluate(() => document.getElementById('agents-panel')!.classList.contains('open'));
const agWidth = (page: Page) =>
  page.evaluate(() => Math.round(document.getElementById('agents-panel')!.getBoundingClientRect().width));
const SWAP = { left: ['activity'], right: ['sidebar'] };

async function arrange(page: Page) {
  await page.evaluate((s) => (window as any).app.testing.setPanelDock(s), SWAP);
  await page.locator('#agents-panel .ag-collapse').click();
  await expect(page.locator('#agents-panel')).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('agentsWidth', '400'));
}

test.describe('묶음 PLY — 저장 레이아웃', () => {
  test('PLY1 (TC-PLY-5): 저장하면 새 탭이 그 배치로 열린다. 폭은 비율이다', async ({ page, context }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await waitForInit(page);
    await arrange(page);
    expect(await page.evaluate(() => (window as any).app.testing.saveLayout())).toBe(true);

    const other = await context.newPage();
    await other.setViewportSize({ width: 1200, height: 900 });
    await waitForInit(other);
    expect(await side(other, 'sbSide')).toBe('right');
    expect(await side(other, 'agSide')).toBe('left');
    expect(await agOpen(other)).toBe(true);
    // 400 / 1600 = 0.25 → 1200 × 0.25 = 300
    expect(await agWidth(other)).toBe(300);
  });

  test('PLY2 (TC-PLY-5): 기본값으로 누르면 새 탭은 기본 배치로 열리고, 지금 탭은 그대로다', async ({ page, context }) => {
    await waitForInit(page);
    await arrange(page);
    await page.evaluate(() => (window as any).app.testing.saveLayout());
    expect(await page.evaluate(() => (window as any).app.testing.resetLayout())).toBe(true);
    expect(await side(page, 'sbSide')).toBe('right');

    const other = await context.newPage();
    await waitForInit(other);
    expect(await side(other, 'sbSide')).toBe('left');
    expect(await agOpen(other)).toBe(false);
  });

  test('PLY3 (TC-PLY-6): 바꾼 배치는 새로고침 뒤에도 남고, 저장하지 않으면 새 탭에 가지 않는다', async ({ page, context }) => {
    await waitForInit(page);
    await arrange(page);
    await page.reload();
    await waitForInit(page);
    expect(await side(page, 'sbSide')).toBe('right');
    expect(await agOpen(page)).toBe(true);

    const other = await context.newPage();
    await waitForInit(other);
    expect(await side(other, 'sbSide')).toBe('left');
  });
});
