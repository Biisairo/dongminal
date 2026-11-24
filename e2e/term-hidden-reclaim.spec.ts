import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled, JSON_HDR, trackTermAttach, termAttaches } from './fixtures';

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

const FILL = 'yes otter-hrc-fill-0123456789-abcdefghij | head -n 20000';
const TABS = 4;

async function newClient(browser: any, width: number): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await waitForInit(page);
  return page;
}

const claim = (page: Page) => page.evaluate(() => (window as any).app.focus.setFocus((window as any).app.focused));

test('TC-OTR-10: 다른 기기가 쥔 창의 탭을 오가도 탭마다 전량 재생은 한 벌이다', async ({ browser, request }) => {
  const local = await newClient(browser, 1440);
  await local.evaluate(async (n) => {
    const app = (window as any).app;
    for (let i = 1; i < n; i++) await app.layout.tabAdd.addTab(app.focused, 'terminal');
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
      return o.ok() ? ((await o.json()).text || '').split('otter-hrc-fill').length : 0;
    }, { timeout: 30000 }).toBeGreaterThan(19000);
  }

  // 좁은 기기가 탭을 모두 열어 창을 쥔다 — 그 기기는 보이는 탭만 연결하므로(지연 연결)
  // 하나씩 열어야 PTY 넷이 모두 좁은 폭이 되고, 로컬의 터미널 넷이 모두 그 폭을 따라간다.
  const remote = await newClient(browser, 900);
  for (const id of all) {
    await remote.evaluate((tid) => {
      const a = (window as any).app;
      const loc = a.tool.life.findToolLocation(tid);
      a.layout.tabOps.switchTab(loc.pane.id, loc.tab.id);
      a.focus.setFocus(loc.pane.id);
    }, id);
    await waitSettled(remote);
  }
  const narrow = await remote.evaluate(() => (window as any).app.testing.focusedTerminal().term.cols);
  // PERF D-16(2.5): 잠든 터미널은 구독하지 않아 크기 통보도 받지 않는다 — 깨어 있는 것만 지금 그 폭을 따른다. 잠든 것은
  // 깰 때 `SIZE` → 스냅숏으로 그때의 폭을 받는다.
  await expect.poll(() => local.evaluate((c) => [...(window as any).app.tools.values()].filter((p: any) => p._sock.live).every((p: any) => p.term && p.term.cols === c), narrow), { timeout: 10000 }).toBe(true);

  // PERF C5: 탭마다의 붙음은 채널의 `term.open` 이다 — 옛 칸별 소켓 하나와 같다.
  await trackTermAttach(local);
  // PERF D-16(2.5): 깨울 때의 붙음은 재생이 아니라 깨움이다 — 따로 세어 뺀다.
  await local.evaluate(() => {
    const w = window as any;
    w.__wakes = {};
    for (const p of w.app.tools.values()) {
      const wake = p.wake.bind(p);
      p.wake = () => { w.__wakes[p.id] = (w.__wakes[p.id] || 0) + 1; wake() };
    }
  });
  for (let round = 0; round < 2; round++) {
    for (const id of all) {
      await local.evaluate((tid) => {
        const a = (window as any).app;
        const loc = a.tool.life.findToolLocation(tid);
        a.layout.tabOps.switchTab(loc.pane.id, loc.tab.id);
        a.focus.setFocus(loc.pane.id);
      }, id);
      await waitSettled(local);
      await local.waitForTimeout(1500);
    }
  }

  console.log('[dbg] ' + await local.evaluate(() => JSON.stringify([...(window as any).app.tools.values()].map((p: any) => ({ id: p.id.slice(-6), vis: p.el.classList.contains('vis'), cols: p.term && p.term.cols, own: p._ownCols, debt: p._widthDebt, live: p._seqLive, alt: p._srvAlt, ws: !!p.ws })))));
  const socks = await termAttaches(local);
  const perTool = new Map<string, number>();
  for (const s of socks) perTool.set(s.tool, (perTool.get(s.tool) || 0) + 1);
  const summary = JSON.stringify([...perTool.entries()].map(([t, n]) => [t.slice(-6), n]));
  // PERF D-16(2.5): 탭 하나를 1.5초씩 도는 동안 나머지 탭은 2초를 넘게 가려져 잠들고, 다시 보일 때 깨며 스냅숏을
  // 받는다. 깨움으로 붙은 것을 빼면 재생은 탭마다 많아야 한 벌(폭 빚 갚기)이다 — 그보다 많으면 재생이 되풀이된 것이다.
  // 붙음이 0 이면 보일 때 붙지 않은 것이다.
  const wakes: Record<string, number> = await local.evaluate(() => (window as any).__wakes);
  for (const id of all) {
    const n = perTool.get(id) || 0;
    expect(n, `${id.slice(-6)} 의 붙음 수: ${summary}`).toBeGreaterThanOrEqual(1);
    expect(n - (wakes[id] || 0), `${id.slice(-6)} 의 깨움 밖 재생 수: ${summary} 깨움 ${JSON.stringify(wakes)}`).toBeLessThanOrEqual(1);
  }
  // PERF 2.5: 깨자마자 소유가 바뀌어 폭 빚을 갚으면(FR-OTR) 깨움의 붙음은 바이트 없이 닫히고 곧 다시 붙는다 — 서버가 옛
  // 세션의 프레임을 버리므로 재생이 낭비되지 않는다. 그 경우만 뺀다.
  const twins = socks.filter((s, i) => s.closed && s.bytes === 0
    && !((wakes[s.tool] || 0) > 0 && socks.slice(i + 1).some((x) => x.tool === s.tool && x.bytes > 0)));
  expect(twins.length, '붙자마자 버려진 붙음이 있다: ' + JSON.stringify(socks.map((x: any) => [x.sid, x.tool.slice(-6), x.bytes, x.closed]))).toBe(0);
});
