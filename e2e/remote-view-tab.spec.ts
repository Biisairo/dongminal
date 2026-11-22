import type { Browser, Page } from '@playwright/test';
import { test, expect, waitForInit } from './fixtures';

/**
 * UX_BATCH12_SRS FR-VTL-1·2 (TC-VTL-1).
 *
 * 사용자 보고(2026-11-16): 이슈 트리의 leaf 탭을 보는데 그 칸이 부모 탭으로 바뀌었다. 같은
 * 워크스페이스를 연 다른 브라우저의 저장이 단일 슬롯 모드의 `pn.activeTab` 을 덮었다.
 *
 * `browser.newContext()` 는 sessionStorage·clientId 가 격리되므로 다른 기기와 같다
 * (`focus-owner.spec.ts` 와 같은 방식).
 */
async function newClient(browser: Browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await waitForInit(page);
  return { ctx, page };
}

const paneState = (page: Page, rid: string) => page.evaluate((id: string) => {
  const a = (window as any).app;
  const win = a.testing.aw();
  const pn = a.testing.flattenPanes(win.layout).find((x: any) => x.id === id);
  return pn ? { tabs: pn.tabs.map((t: any) => t.id), shown: a.slot.paneTab(pn) } : null;
}, rid);

test.describe('다른 브라우저의 저장이 보이는 탭을 바꾸지 않는다 (FR-VTL)', () => {
  test('B 가 같은 칸의 다른 탭을 골라도 A 의 보이는 탭이 그대로다', async ({ browser }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);
    const { rid, tabs } = await A.page.evaluate(async () => {
      const a = (window as any).app;
      const id = a.focused;
      await a.layout.tabAdd.addTab(id, undefined, { keepFocus: true });
      await a.layout.tabAdd.addTab(id, undefined, { keepFocus: true });
      const pn = a.testing.flattenPanes(a.testing.aw().layout).find((x: any) => x.id === id);
      a.layout.tabOps.switchTab(id, pn.tabs[1].id);
      return { rid: id, tabs: pn.tabs.map((t: any) => t.id) };
    });
    const watched = tabs[1];
    await expect.poll(async () => (await paneState(B.page, rid))?.tabs.length, { timeout: 10000 }).toBe(tabs.length);

    await B.page.evaluate(({ id, tid }) => (window as any).app.layout.tabOps.switchTab(id, tid), { id: rid, tid: tabs[2] });
    await expect.poll(async () => {
      const r = await A.page.request.get('/api/workspace');
      const ws = await r.json();
      const flat = (n: any): any[] => (n ? (n.tabs ? [n] : (n.children || []).flatMap(flat)) : []);
      const pn = ws.windows.flatMap((w: any) => flat(w.layout)).find((p: any) => p.id === rid);
      return pn && pn.activeTab;
    }, { timeout: 10000, message: 'B 의 저장이 서버에 닿지 않았다' }).toBe(tabs[2]);
    // A 가 B 의 저장을 받아 적용할 때까지 기다린다 — 적용하면 A 의 판(ETag)이 서버 판과 같아진다.
    await expect.poll(async () => {
      const etag = (await A.page.request.get('/api/state')).headers()['etag'];
      return etag && etag === await A.page.evaluate(() => (window as any).app.wsETag);
    }, { timeout: 10000, message: 'A 가 B 의 저장을 받지 못했다' }).toBe(true);

    expect((await paneState(A.page, rid))?.shown, '다른 브라우저의 저장이 A 의 보이는 탭을 바꿨다').toBe(watched);
    await A.ctx.close();
    await B.ctx.close();
  });

  test('A 가 보던 탭을 B 가 닫으면 A 는 받은 값을 따른다', async ({ browser }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);
    const { rid, tabs } = await A.page.evaluate(async () => {
      const a = (window as any).app;
      const id = a.focused;
      await a.layout.tabAdd.addTab(id, undefined, { keepFocus: true });
      await a.layout.tabAdd.addTab(id, undefined, { keepFocus: true });
      const pn = a.testing.flattenPanes(a.testing.aw().layout).find((x: any) => x.id === id);
      a.layout.tabOps.switchTab(id, pn.tabs[1].id);
      return { rid: id, tabs: pn.tabs.map((t: any) => t.id) };
    });
    await expect.poll(async () => (await paneState(B.page, rid))?.tabs.length, { timeout: 10000 }).toBe(tabs.length);

    await B.page.evaluate(async ({ id, tid, keep }) => {
      const a = (window as any).app;
      a.layout.tabOps.switchTab(id, keep);
      await a.layout.tabOps.closeTab(id, tid, undefined, { force: true });
    }, { id: rid, tid: tabs[1], keep: tabs[0] });
    await expect.poll(async () => (await paneState(A.page, rid))?.tabs.length, { timeout: 10000 }).toBe(tabs.length - 1);

    const got = await paneState(A.page, rid);
    expect(got?.tabs).not.toContain(tabs[1]);
    expect(got?.shown, '보던 탭이 사라졌으면 받은 값을 따른다').toBe(tabs[0]);
    await A.ctx.close();
    await B.ctx.close();
  });
});
