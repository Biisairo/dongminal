import { test, expect, waitForInit, JSON_HDR } from './fixtures';

/**
 * ATTENTION_FIRING_SRS 묶음 D — **한 컴퓨터에서 한 번** (V-ATD-5).
 *
 * 접수: *"task finished 도 연달아 두 번 뜬다"* — 창을 2개 띄워 두었고, 서버의 방송은
 * 하나였다 (§1.13). 두 창은 `browser.newContext()` 둘로 세운다 — 출처는 같아도
 * 저장소·신원이 갈리므로 브라우저 안의 조율은 닿지 않고, 서버의 청구만 남는다.
 * 둘 다 127.0.0.1 에서 오므로 서버에게는 같은 컴퓨터다 (FR-ATD-5).
 *
 * **재는 것은 "몇 번 냈는가" 다**, 몇 번 받았는가가 아니다. 방송은 두 창에 다 가고
 * 게이트는 받는 쪽에 있다.
 */

async function newClient(browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await waitForInit(page);
  // 비프와 데스크톱 알림을 가로채 호출만 센다. 알림음을 켜 둔다 — 소리를 낼 수
  // 없는 창은 청구하지 않는다 (FR-ATD-3).
  await page.evaluate(() => {
    const w = window as any;
    w.__beeps = 0;
    w.__notifs = 0;
    w.app.attnSound = true;
    w.app.testing.attnBeep = () => { w.__beeps++; };
    const Spy: any = function () { w.__notifs++; return { close() {} }; };
    Spy.permission = 'granted';
    Spy.requestPermission = () => Promise.resolve('granted');
    w.Notification = Spy;
  });
  // 소리는 사용자 조작이 있었던 창만 맡는다 — 조작을 한 번 준다.
  await page.mouse.click(5, 5);
  return { ctx, page };
}

const counts = (page) => page.evaluate(() => ({ beeps: (window as any).__beeps, notifs: (window as any).__notifs }));

test.describe('알람 — 한 컴퓨터에서 한 번 (묶음 D)', () => {
  test('창 둘이 같은 알람을 받으면 표식은 둘 다, 배너·소리는 한 번씩 (V-ATD-5)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);

    const tab = A.page.locator('#area .pn.focused .pn-tab').first();
    await expect(tab).toHaveAttribute('data-toolid', /.+/, { timeout: 15000 });
    const toolId = (await tab.getAttribute('data-toolid')) as string;

    const claimed = (page) => page.waitForResponse((r) => r.url().includes('/api/tools/attention/claim'));
    const both = Promise.all([claimed(A.page), claimed(B.page)]);
    const r = await request.post('/api/tools/attention/set', { headers: JSON_HDR, data: { toolId, reason: 'signaled' } });
    expect(r.ok()).toBeTruthy();
    await both;

    // 응답을 받은 뒤 승낙받은 창이 내는 것은 같은 작업 안이다 — 한 프레임만 넘긴다.
    for (const p of [A.page, B.page]) await p.evaluate(() => new Promise((res) => requestAnimationFrame(() => res(null))));

    const a = await counts(A.page);
    const b = await counts(B.page);
    expect(a.notifs + b.notifs, `배너 A=${a.notifs} B=${b.notifs}`).toBe(1);
    expect(a.beeps + b.beeps, `소리 A=${a.beeps} B=${b.beeps}`).toBe(1);

    // FR-ATD-2: 표식은 두 창 모두에 선다.
    for (const p of [A.page, B.page]) {
      await expect.poll(() => p.evaluate((id) => (window as any).app.testing.attn.has(id), toolId)).toBe(true);
    }
    await request.post('/api/tools/attention/clear', { headers: JSON_HDR, data: { toolId } });
    await A.ctx.close();
    await B.ctx.close();
  });
});
