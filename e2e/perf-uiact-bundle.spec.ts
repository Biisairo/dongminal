import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// PERF 3.4.12.10 — 사용자 동작·채팅 부품 묶음 (perf/M3_BOOT_SCOPE.md §3 `uiact`·`chat`, D-47).
//
// 끌어 놓기의 옮기기·주의 센터 그리기·경로 후보·터미널 올리기/내려받기의 본체는 `[uiact]`, 채팅 창 열기·사람 명령·
// 망 그림 계산은 `[chat]` 이다. 처음 쓸 때 싣는다. 데스크톱은 addon-webgl 을 종전대로 부팅 때 받는다(D-40).

const UIACT = /\/b\/uiact\.js(\?|$)/;
const CHAT = /\/b\/chat\.js(\?|$)/;
const WEBGL = /\/vendor\/addon-webgl\.js(\?|$)/;

function count(page: Page) {
  const seen = { uiact: 0, chat: 0, webgl: 0 };
  page.on('request', (r) => {
    const u = r.url();
    if (UIACT.test(u)) seen.uiact++;
    if (CHAT.test(u)) seen.chat++;
    if (WEBGL.test(u)) seen.webgl++;
  });
  return seen;
}

test('TC-UAB-1: 부팅은 uiact·chat 을 받지 않고 데스크톱은 addon-webgl 을 한 번 받는다', async ({ page }) => {
  const seen = count(page);
  await waitForInit(page);
  expect(seen.uiact).toBe(0);
  expect(seen.chat).toBe(0);
  expect(seen.webgl).toBe(1);
  expect(await page.evaluate(() => [
    typeof (window as any).PathSuggest, typeof (window as any).meshDirectPeer, (window as any).app.chat.human,
    typeof (window as any).WebglAddon,
  ])).toEqual(['undefined', 'undefined', null, 'object']);
});

test('TC-UAB-2: 탭을 끌기 시작하면 uiact 를 싣고, 본문 가장자리에 놓으면 분할한다', async ({ page }) => {
  const seen = count(page);
  await waitForInit(page);
  await page.evaluate(async () => { const a = (window as any).app; await a.layout.tabAdd.addTab(a.focused, 'terminal') });
  await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(2, { timeout: 15000 });
  expect(seen.uiact).toBe(0);
  await page.evaluate(() => {
    const tab = document.querySelector('#area .pn.focused .pn-tab') as HTMLElement;
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  });
  await expect.poll(() => seen.uiact).toBe(1);
  await expect.poll(() => page.evaluate(() => Screens.ready('uiact'))).toBe(true);
  await page.evaluate(() => {
    const body = document.querySelector('#area .pn.focused .pn-body') as HTMLElement;
    const r = body.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientX: r.right - 4, clientY: r.top + r.height / 2 };
    body.dispatchEvent(new DragEvent('dragover', at));
    body.dispatchEvent(new DragEvent('drop', at));
  });
  await expect(page.locator('#area .pn')).toHaveCount(2, { timeout: 10000 });
  expect(seen.uiact).toBe(1);
});

test('TC-UAB-3: 주의 센터는 배지를 처음 누를 때 uiact 를 싣고 열린다', async ({ page }) => {
  const seen = count(page);
  await waitForInit(page);
  await page.evaluate(() => {
    const a = (window as any).app;
    const id = document.querySelector('#area .pn-tab[data-toolid]')!.getAttribute('data-toolid');
    a.testing.attn.set(id, { reason: 'idle' });
    a.testing.attnRefresh();
  });
  await expect(page.locator('#attn-badge')).toBeVisible();
  expect(seen.uiact).toBe(0);
  await page.locator('#attn-badge').click();
  await expect(page.locator('#attn-center.open .attn-item')).toHaveCount(1);
  expect(seen.uiact).toBe(1);
  await page.locator('#attn-badge').click();
  await expect(page.locator('#attn-center.open')).toHaveCount(0);
});

test('TC-UAB-4: 채팅 탭을 고르면 chat 을 싣고 채팅 창이 선다', async ({ page }) => {
  const seen = count(page);
  await waitForInit(page);
  expect(seen.chat).toBe(0);
  await page.locator('#sb-tabs .sb-tab[data-panel="chat"]').click();
  await expect.poll(() => page.evaluate(() => { const w = (window as any).app.testing.aw(); return w && w.type || '' })).toBe('chat');
  await expect(page.locator('#area .chat-window-empty')).toBeVisible();
  expect(seen.chat).toBe(1);
  expect(await page.evaluate(() => (window as any).app.chat.human !== null)).toBe(true);
});
