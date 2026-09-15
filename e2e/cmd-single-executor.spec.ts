import { test, expect, waitForInit, JSON_HDR } from './fixtures';

/**
 * M11_SRS FR-M11-10·11 (M11-B9) — **시선을 옮기는 명령은 한 곳에서만 돈다.**
 *
 * 접수: *"화면이 막 맘대로 바껴 … 한쪽에서 변화가 생기면 다른 브라우저에서 동작이
 * 생기는거같은데"*. 실측에서 `window-next` 하나가 두 브라우저를 함께 옮겼고,
 * `close-window` 는 그 창을 보지도 않던 쪽까지 끌고 갔다 (SRS §2.7).
 *
 * 크로스 기기 프록시는 `browser.newContext()` 다 — `clientId` 가 격리되므로 지명
 * (`execClientId`)의 효과를 그대로 잰다 (`focus-owner.spec.ts` 와 같은 근거).
 *
 * **재는 것은 "누가 움직였는가" 다**, 명령이 닿았는가가 아니다. 방송은 전부에게
 * 가고 게이트는 받는 쪽에 있으므로, 배달 수를 세면 고침을 지나쳐 초록이 된다.
 */

async function newClient(browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await waitForInit(page);
  return { ctx, page };
}

const activeOf = (page) => page.evaluate(() => (window as any).app.ws.activeWindow);
const windowIds = (page) => page.evaluate(() => (window as any).app.ws.windows.map((w) => w.id));
const switchTo = (page, id: string) => page.evaluate((w) => (window as any).app.switchWindow(w), id);
// 소유권 주장 — 지명(`Focus.Executor()`)은 **가장 최근에 주장한** 클라이언트다.
const claim = (page) => page.evaluate(() => (window as any).app.setFocus((window as any).app.focused));

/** 그 창의 첫 탭 uuid — `location` 이 받는 유일한 형식이다 (FR-IDU-*). */
const tabIn = (page, windowId: string) => page.evaluate((id) => {
  const ws = (window as any).app.ws.windows.find((x) => x.id === id);
  const find = (n) => (n.type === 'pane' ? n : (n.children || []).map(find).find(Boolean));
  return find(ws.layout).tabs[0].id;
}, windowId);

const cmd = (request, action: string, args: Record<string, unknown> = {}) =>
  request.post('/api/commands', { headers: JSON_HDR, data: { action, args } });

/** 창 n 개를 새로 만들고, 클라이언트와 **서버 색인**이 모두 그것을 알 때까지 기다린다. */
async function makeWindows(request, pages, n: number) {
  const made: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await cmd(request, 'newWindow', { keepFocus: true });
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.newWindows?.[0], '창이 만들어지지 않았다 — 지명된 클라이언트가 없다').toBeTruthy();
    made.push(j.newWindows[0]);
  }
  for (const p of pages) {
    await expect
      .poll(async () => (await windowIds(p)).filter((id) => made.includes(id)).length, { timeout: 20000 })
      .toBe(n);
  }
  // **서버의 색인까지 기다린다.** `location` 의 uuid 해석은 서버가 하고, 그 색인은
  // 브라우저가 workspace 를 저장해야 움직인다 — 기다리지 않으면 400 이 온다.
  await expect
    .poll(async () => {
      const st = await (await request.get('/api/state')).json();
      const ids = (st?.workspace?.windows || []).map((w) => w.id);
      return made.filter((id) => ids.includes(id)).length;
    }, { timeout: 20000 })
    .toBe(n);
  return made;
}

test.describe('M11 — 시선을 옮기는 명령의 실행자 (FR-M11-10·11)', () => {
  test('V-M11-25: window-next 는 한 브라우저만 옮긴다 (FR-M11-10)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);
    const [w1, w2] = await makeWindows(request, [A.page, B.page], 2);

    await switchTo(A.page, w1);
    await switchTo(B.page, w2);
    // B 가 나중에 주장하므로 B 가 실행자다.
    await claim(A.page);
    await claim(B.page);
    await expect.poll(() => activeOf(A.page)).toBe(w1);
    await expect.poll(() => activeOf(B.page)).toBe(w2);

    expect((await cmd(request, 'windowNext')).ok()).toBeTruthy();
    // 실행자(B)는 옮겨 가고, A 는 **그대로여야 한다**.
    await expect.poll(() => activeOf(B.page), { timeout: 10000 }).not.toBe(w2);
    expect(await activeOf(A.page), 'A 는 명령을 내지도 받지도 않았는데 화면이 옮겨졌다 (M11-B9)').toBe(w1);

    await A.ctx.close();
    await B.ctx.close();
  });

  test('V-M11-26: close-window 는 보고 있지 않던 브라우저를 끌고 가지 않는다 (FR-M11-10)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);
    // **아무도 보고 있지 않은 셋째 창**을 닫는다. 지목한 창을 활성으로 만든 뒤
    // 닫는 경로이므로, 게이팅이 없으면 **둘 다** 그 창으로 끌려갔다가 폴백한다.
    const [w1, w2, w3] = await makeWindows(request, [A.page, B.page], 3);

    await switchTo(A.page, w1);
    await switchTo(B.page, w2);
    await claim(A.page);
    await claim(B.page);   // B 가 실행자다
    await expect.poll(() => activeOf(A.page)).toBe(w1);
    await expect.poll(() => activeOf(B.page)).toBe(w2);

    const tabOfW3 = await tabIn(A.page, w3);
    expect((await cmd(request, 'closeWindow', { location: tabOfW3, force: true })).ok()).toBeTruthy();

    // 창은 사라진다 — 공유 트리이므로 둘 다 본다.
    await expect.poll(async () => (await windowIds(A.page)).includes(w3), { timeout: 15000 }).toBe(false);
    // 실행자가 아닌 A 의 시선은 **한 번도 움직이지 않아야 한다**.
    expect(await activeOf(A.page), '보고 있지도 않던 창이 닫혔는데 화면이 옮겨졌다 (M11-B9)').toBe(w1);

    await A.ctx.close();
    await B.ctx.close();
  });

  test('V-M11-27: close-window --force 도 keepFocus 를 지킨다 (FR-M11-11)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const [w1, , w3] = await makeWindows(request, [A.page], 3);

    await switchTo(A.page, w1);
    await claim(A.page);
    await expect.poll(() => activeOf(A.page)).toBe(w1);

    const tabOfW3 = await tabIn(A.page, w3);
    // `-n` = keepFocus. 다른 창을 닫되 **내 시선은 그대로**여야 한다.
    const r = await cmd(request, 'closeWindow', { location: tabOfW3, force: true, keepFocus: true });
    expect(r.ok(), `close 응답 ${r.status()} ${await r.text()}`).toBeTruthy();

    await expect.poll(async () => (await windowIds(A.page)).includes(w3), { timeout: 15000 }).toBe(false);
    expect(await activeOf(A.page), '`--no-focus` 를 주었는데 시선이 옮겨졌다 (FR-M11-11)').toBe(w1);

    await A.ctx.close();
  });
});
