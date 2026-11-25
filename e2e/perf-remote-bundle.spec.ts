import { Page } from '@playwright/test';

import { test, expect, waitForInit, JSON_HDR } from './fixtures';

// PERF 3.4.12.5 — 원격 명령 묶음 (perf/M3_BOOT_SCOPE.md §3 `remote`).
//
// 부팅 묶음은 원격 명령 본체(tool-cmd-remote.js)와 open-url.js 를 담지 않는다. 첫 명령이 `b/remote.js` 를 싣고,
// 실리는 동안 받은 명령은 받은 순서대로 줄을 섰다가 실린 뒤 그 순서대로 돈다.

const BUNDLE = /\/b\/remote\.js(\?|$)/;

function countBundle(page: Page) {
  const seen = { n: 0 };
  page.on('request', (r) => { if (BUNDLE.test(r.url())) seen.n++ });
  return seen;
}

const firstTab = (page: Page) => page.evaluate(() => {
  const a = (window as any).app;
  const w = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
  const find = (n: any): any => (n.type === 'pane' ? n : (n.children || []).map(find).find(Boolean));
  const t = find(w.layout).tabs[0];
  return { id: t.id as string, name: t.name as string };
});

test('TC-RMB-1: 부팅 때 b/remote.js 를 받지 않는다', async ({ page }) => {
  const seen = countBundle(page);
  await waitForInit(page);
  expect(seen.n).toBe(0);
  expect(await page.evaluate(() => Screens.ready('remote'))).toBe(false);
  expect(await page.evaluate('typeof OpenUrl')).toBe('undefined');
});

test('TC-RMB-2: otterctl 명령 둘을 잇달아 보내면 묶음이 실린 뒤 받은 순서대로 돈다', async ({ page, request }) => {
  const seen = countBundle(page);
  await waitForInit(page);
  const tab = await firstTab(page);

  let release: () => void = () => {};
  const held = new Promise<void>((res) => { release = res });
  await page.route(BUNDLE, async (r) => {
    await held;
    await r.continue();
  });

  for (const name of ['rmb-first', 'rmb-second']) {
    const r = await request.post('/api/commands', { headers: JSON_HDR, data: { action: 'renameTab', args: { location: tab.id, name } } });
    expect(r.ok()).toBe(true);
  }
  // 둘 다 닿아 줄에 섰고, 묶음이 붙잡혀 있는 동안 아무것도 돌지 않았다.
  await expect.poll(() => page.evaluate(() => ((window as any).app.tool.cmd._remoteQ || []).length)).toBe(2);
  expect((await firstTab(page)).name).toBe(tab.name);
  expect(seen.n).toBe(1);

  release();
  await expect.poll(() => page.evaluate(() => Screens.ready('remote'))).toBe(true);
  await expect.poll(async () => (await firstTab(page)).name).toBe('rmb-second');
  expect(seen.n).toBe(1);
  expect(await page.evaluate(() => (window as any).app.tool.cmd._remoteQ)).toBeNull();
});
