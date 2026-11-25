import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// PERF 3.4.9.2 — 설정 창 묶음 (D-41, perf/M3_DESIGN.md §3.4).
//
// 부팅은 `b/settings.js` 를 싣지 않는다. 설정 값의 부팅 적용(`_settingsApply`)은 묶음 없이 돈다. 설정 단추를 처음 누르면
// 묶음을 싣고 모달·섹션을 세운 뒤 연다.

function bundleRequests(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    const m = /\/b\/([\w-]+\.(?:js|css))\?/.exec(r.url());
    if (m) seen.push(m[1]);
  });
  return seen;
}

test('TC-LZ92-1: 부팅은 settings 묶음 없이 설정 값을 얹고, 설정을 처음 열 때 b/settings.js 가 실리고 섹션이 칠해진다', async ({ page, request }) => {
  const saved = await (await request.get('/api/settings')).json();
  await request.put('/api/settings', { data: { ...saved, tabFixedWidth: true, tabWidthPx: 180 } });
  try {
    const seen = bundleRequests(page);
    await waitForInit(page);
    // 부팅 적용: 묶음 없이 탭 폭이 섰다.
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--tab-w'))).toBe('180px');
    await expect(page.locator('body.tabfix')).toHaveCount(1);
    expect(seen.filter((n) => n.startsWith('settings.'))).toEqual([]);
    expect(await page.evaluate(() => Screens.ready('settings'))).toBe(false);

    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible();
    expect(seen.filter((n) => n.startsWith('settings.'))).toEqual(['settings.js']);
    await page.locator('#modal .mtab[data-tab="display"]').click();
    await expect(page.locator('#ds-tabw')).toHaveValue('180');
    // 닫고 다시 열어도 다시 싣지 않는다.
    await page.locator('#modal-close').click();
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible();
    expect(seen.filter((n) => n.startsWith('settings.'))).toEqual(['settings.js']);
  } finally {
    await request.put('/api/settings', { data: saved });
  }
});

test('TC-LZ92-2: 딥링크로 연 설정은 묶음을 싣고 그 탭을 고른다', async ({ page }) => {
  await waitForInit(page);
  await page.evaluate(() => (window as any).app.testing.openSettings('terminal'));
  await expect(page.locator('#panel-terminal')).toBeVisible();
  await expect(page.locator('#modal .mtab[data-tab="terminal"]')).toHaveAttribute('aria-selected', 'true');
});
