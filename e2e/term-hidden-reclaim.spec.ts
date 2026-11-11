import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled, JSON_HDR } from './fixtures';

/**
 * V-OTR-17 — 숨은 칸은 되찾아도 재생하지 않고, 보일 때 한 번 갚는다
 * (OWNER_TRANSFER_REPLAY_SRS FR-OTR-10 · FR-OTR-5).
 *
 * 접수(2026-11-12): 다른 PC 가 쥐었던 창에서 탭을 바꾸면 터미널이 하얗거나 늦게 떴다.
 * 숨은 탭은 fit 하지 않아 자기 폭과 `term.cols` 가 계속 달랐고, `resendWindowSizes`
 * 가 부를 때마다 숨은 탭마다 전량 재생이 다시 걸렸다.
 *
 * 크로스 기기 프록시는 `browser.newContext()` 다. 소유권 주장은 `setFocus` 로 한다
 * (`term-reclaim.spec.ts` 와 같은 근거).
 *
 * **고정 대기의 예외 (`TEST-16`).** 아래의 `waitForTimeout` 은 **열리지 않는 WS** 를
 * 잰다 — 일어나지 않는 일에는 기다릴 신호가 없다.
 */

const FILL = 'yes dm-hrc-fill-0123456789-abcdefghij | head -n 20000';
const TABS = 4;

async function newClient(browser: any, width: number): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await waitForInit(page);
  return page;
}

type Sock = { tool: string; bytes: number; closed: boolean };

function trackSockets(page: Page): Sock[] {
  const out: Sock[] = [];
  page.on('websocket', (ws) => {
    const u = new URL(ws.url());
    if (u.pathname !== '/ws') return;
    const rec: Sock = { tool: u.searchParams.get('tool') || '', bytes: 0, closed: false };
    out.push(rec);
    ws.on('framereceived', (f) => { const p: any = f.payload; rec.bytes += typeof p === 'string' ? p.length : p.byteLength; });
    ws.on('close', () => { rec.closed = true });
  });
  return out;
}

const claim = (page: Page) => page.evaluate(() => (window as any).app.setFocus((window as any).app.focused));

test('TC-OTR-10: 다른 기기가 쥔 창의 탭을 오가도 탭마다 전량 재생은 한 벌이다', async ({ browser, request }) => {
  const local = await newClient(browser, 1440);
  await local.evaluate(async (n) => {
    const app = (window as any).app;
    for (let i = 1; i < n; i++) await app.addTab(app.focused, 'terminal');
    app.render();
  }, TABS);
  await waitSettled(local);
  const all: string[] = ((await (await request.get('/api/state')).json()).tools || []).map((t: any) => t.id);
  expect(all.length).toBe(TABS);
  for (const id of all) {
    const res = await request.post('/api/tools/input', { headers: JSON_HDR, data: { id, text: FILL, execute: true } });
    expect(res.ok()).toBe(true);
  }
  for (const id of all) {
    await expect.poll(async () => {
      const o = await request.get('/api/tools/output?id=' + id + '&strip=1');
      return o.ok() ? ((await o.json()).text || '').split('dm-hrc-fill').length : 0;
    }, { timeout: 30000 }).toBeGreaterThan(19000);
  }

  // 좁은 기기가 탭을 모두 열어 창을 쥔다 — 그 기기는 보이는 탭만 연결하므로(지연 연결)
  // 하나씩 열어야 PTY 넷이 모두 좁은 폭이 되고, 로컬의 터미널 넷이 모두 그 폭을 따라간다.
  const remote = await newClient(browser, 900);
  for (const id of all) {
    await remote.evaluate((tid) => {
      const a = (window as any).app;
      const loc = a.findToolLocation(tid);
      a.switchTab(loc.pane.id, loc.tab.id);
      a.setFocus(loc.pane.id);
    }, id);
    await waitSettled(remote);
  }
  const narrow = await remote.evaluate(() => (window as any).app.testing.focusedTerminal().term.cols);
  await expect.poll(() => local.evaluate((c) => [...(window as any).app.tools.values()].every((p: any) => p.term && p.term.cols === c), narrow), { timeout: 10000 }).toBe(true);

  const socks = trackSockets(local);
  for (let round = 0; round < 2; round++) {
    for (const id of all) {
      await local.evaluate((tid) => {
        const a = (window as any).app;
        const loc = a.findToolLocation(tid);
        a.switchTab(loc.pane.id, loc.tab.id);
        a.setFocus(loc.pane.id);
      }, id);
      await waitSettled(local);
      await local.waitForTimeout(1500);
    }
  }

  console.log('[dbg] ' + await local.evaluate(() => JSON.stringify([...(window as any).app.tools.values()].map((p: any) => ({ id: p.id.slice(-6), vis: p.el.classList.contains('vis'), cols: p.term && p.term.cols, own: p._ownCols, debt: p._widthDebt, live: p._seqLive, alt: p._srvAlt, ws: !!p.ws })))));
  const perTool = new Map<string, number>();
  for (const s of socks) perTool.set(s.tool, (perTool.get(s.tool) || 0) + 1);
  const summary = JSON.stringify([...perTool.entries()].map(([t, n]) => [t.slice(-6), n]));
  // 탭마다 정확히 한 벌 — 둘 이상이면 재생이 되풀이된 것이고, 0 이면 보일 때 빚을 갚지 않은 것이다.
  for (const id of all) expect(perTool.get(id) || 0, `${id.slice(-6)} 의 전량 재생 횟수: ${summary}`).toBe(1);
  const twins = socks.filter((s) => s.closed && s.bytes === 0);
  expect(twins.length, '열자마자 버려진 소켓이 있다').toBe(0);
});
