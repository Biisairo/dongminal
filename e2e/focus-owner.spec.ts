import { test, expect } from './fixtures';

// 묶음 E — 크로스 기기 창 포커스 소유권 (SRS §3.5 FR-XDF-*, §4.5 TC-XDF-*)
//
// 크로스 기기 프록시: browser.newContext() 는 BroadcastChannel 스코프와
// clientId(app.js:8, 페이지 로드마다 randomUUID)가 모두 격리되므로 다른
// 기기와 동등하다 (e2e/sync.spec.ts 가 이미 쓰는 패턴).
//
// 소유권 주장은 setFocus 를 직접 호출해 트리거한다 — 두 컨텍스트가 동시에
// OS 포커스를 보고할 수 있어(init-time claim, app.js:166) 클릭 기반 트리거는
// 순서가 결정론적이지 않다. 검증하는 대상은 클릭 결선이 아니라 전파이므로
// 트리거만 API 로 하고 **효과는 DOM(pn-dimmed)으로 확인**한다.

async function waitForInit(page) {
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// osFocused:false 로 띄우면 app.js:166 의 init-time claim 이 발동하지 않는다.
// 그 claim 은 document.hasFocus() 만 보므로, 늦게 접속한 Client 가 접속만으로
// 소유권을 빼앗아 스냅샷 복원(FR-XDF-11)을 검증할 수 없게 된다.
async function newClient(browser, opts: { osFocused?: boolean } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  if (opts.osFocused === false) {
    await ctx.addInitScript(() => {
      Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
    });
  }
  const page = await ctx.newPage();
  await waitForInit(page);
  return { ctx, page };
}

// claim 은 setFocus 경로로 소유권을 주장한다 (app.js:1548 — 클릭마다 무조건 주장).
const claim = (page) => page.evaluate(() => (window as any).app.setFocus((window as any).app.focused));

const clientIdOf = (page) => page.evaluate(() => (window as any).app.clientId);
const activeWindowOf = (page) => page.evaluate(() => (window as any).app.ws.activeWindow);

async function owners(request) {
  const r = await request.get('/api/focus');
  expect(r.ok()).toBeTruthy();
  return (await r.json()).owners || {};
}

test.describe('묶음 E — 크로스 기기 창 포커스 소유권', () => {
  test('TC-XDF-1: A 가 포커스한 Window 가 B 에서 dim 된다 (FR-XDF-5/6)', async ({ browser }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);

    await claim(A.page);

    await expect(B.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });
    await expect(A.page.locator('#area .pn.pn-dimmed')).toHaveCount(0);

    await A.ctx.close();
    await B.ctx.close();
  });

  test('TC-XDF-2: last-focus-wins — B 가 주장하면 A 가 dim 된다 (FR-XDF-2)', async ({ browser }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);

    await claim(A.page);
    await expect(B.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });

    await claim(B.page);
    await expect(A.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });
    await expect(B.page.locator('#area .pn.pn-dimmed')).toHaveCount(0);

    await A.ctx.close();
    await B.ctx.close();
  });

  test('TC-XDF-3: 한 Client 는 한 Window 만 소유한다 (FR-XDF-3)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const idA = await clientIdOf(A.page);

    const w1 = await activeWindowOf(A.page);
    await claim(A.page);
    await expect.poll(async () => (await owners(request))[w1], { timeout: 10000 }).toBe(idA);

    // 새 Window 를 만들면 switchWindow → _focusWindow 로 소유가 옮겨간다.
    await A.page.click('#add-window');
    await expect.poll(async () => await activeWindowOf(A.page), { timeout: 15000 }).not.toBe(w1);
    const w2 = await activeWindowOf(A.page);

    await expect.poll(async () => (await owners(request))[w2], { timeout: 10000 }).toBe(idA);
    expect((await owners(request))[w1]).toBeUndefined();

    await A.ctx.close();
  });

  test('TC-XDF-4: 소유권 스냅샷 조회 (FR-XDF-7)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const idA = await clientIdOf(A.page);
    const w1 = await activeWindowOf(A.page);

    await claim(A.page);
    await expect.poll(async () => (await owners(request))[w1], { timeout: 10000 }).toBe(idA);

    await A.ctx.close();
  });

  test('TC-XDF-5: 컨텍스트 종료 시 즉시 해제 (FR-XDF-9)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);
    const w1 = await activeWindowOf(A.page);

    await claim(A.page);
    await expect(B.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });

    await A.ctx.close();

    // grace period 없음 — 구독 해제가 곧 해제다.
    await expect(B.page.locator('#area .pn.pn-dimmed')).toHaveCount(0, { timeout: 10000 });
    expect((await owners(request))[w1]).toBeUndefined();

    await B.ctx.close();
  });

  test('TC-XDF-6: 늦게 참여한 Client 가 접속 직후 dim 을 본다 (FR-XDF-11)', async ({ browser }) => {
    const A = await newClient(browser);
    await claim(A.page);

    // C 는 A 의 주장 이후에 접속한다 — 증분 이벤트를 놓쳤으므로 스냅샷으로만 알 수 있다.
    // OS 포커스 없이 띄운다: 있으면 init-time claim 이 A 의 소유권을 빼앗아
    // 검증 대상(스냅샷 복원)이 아니라 획득 경로를 보게 된다.
    const C = await newClient(browser, { osFocused: false });
    await expect(C.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });

    await A.ctx.close();
    await C.ctx.close();
  });

  test('TC-XDF-7: SSE 재연결 시 소유권을 재획득한다 (FR-XDF-12)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const idA = await clientIdOf(A.page);
    const w1 = await activeWindowOf(A.page);

    await claim(A.page);
    await expect.poll(async () => (await owners(request))[w1], { timeout: 10000 }).toBe(idA);

    // 구독만 끊는다 (컨텍스트는 살아 있다) → 서버가 즉시 해제해야 한다.
    await A.page.evaluate(() => (window as any).app._cmdES.close());
    await expect.poll(async () => (await owners(request))[w1], { timeout: 10000 }).toBeUndefined();

    // 재연결 → onopen 에서 스냅샷 복원 + 재획득. 이것이 없으면 소유권이 영구히 빈다.
    await A.page.evaluate(() => { (window as any).app._windowFocused = true; (window as any).app._subscribeCommands(); });
    await expect.poll(async () => (await owners(request))[w1], { timeout: 10000 }).toBe(idA);

    await A.ctx.close();
  });

  test('TC-XDF-8: OS 포커스 없는 Client 는 재연결 시 주장하지 않는다 (FR-XDF-13)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const idA = await clientIdOf(A.page);
    const w1 = await activeWindowOf(A.page);

    await claim(A.page);
    await expect.poll(async () => (await owners(request))[w1], { timeout: 10000 }).toBe(idA);

    await A.page.evaluate(() => { (window as any).app._windowFocused = false; (window as any).app._cmdES.close(); });
    await expect.poll(async () => (await owners(request))[w1], { timeout: 10000 }).toBeUndefined();

    await A.page.evaluate(() => (window as any).app._subscribeCommands());
    // 재연결은 되지만 주장하지 않는다. 주장했다면 여기서 idA 가 돌아온다.
    await A.page.waitForTimeout(1500);
    expect((await owners(request))[w1]).toBeUndefined();

    await A.ctx.close();
  });

  test('TC-XDF-9: BroadcastChannel 경로가 없다 (FR-XDF-5)', async ({ browser }) => {
    const A = await newClient(browser);
    expect(await A.page.evaluate(() => !!(window as any).app._focusCh)).toBe(false);
    await A.ctx.close();
  });

  test('TC-XDF-10: dim 과 리사이즈 권한이 같은 상태를 읽는다 (FR-XDF-4)', async ({ browser }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);

    await claim(A.page);
    await expect(B.page.locator('#area .pn.pn-dimmed')).toHaveCount(1, { timeout: 10000 });

    // _resizeCheck 는 **toolId** 를 받는다 — app.focused 는 pane id 이므로 넘기면
    // _toolWindowId 가 null 을 돌려주고 "아직 어느 Window 에도 없음 → 허용"으로
    // 빠져 테스트가 무의미해진다.
    // _windowFocused 는 참으로 고정해 OS 포커스 요인을 제거하고 소유권만 남긴다.
    const probe = () => B.page.evaluate(() => {
      const app = (window as any).app;
      app._windowFocused = true;
      const el = document.querySelector('#area .pn-tab[data-toolid]') as HTMLElement | null;
      return { toolId: el?.dataset.toolid || null, allowed: el ? app._resizeCheck(el.dataset.toolid) : null };
    });

    const owned = await probe();
    expect(owned.toolId).toBeTruthy();
    expect(owned.allowed).toBe(false);

    // 소유권이 풀리면 같은 toolId 가 허용으로 돌아온다 — false 의 원인이
    // 소유권이었음을 못박는다 (다른 요인으로 false 가 나온 것이 아니다).
    await A.ctx.close();
    await expect(B.page.locator('#area .pn.pn-dimmed')).toHaveCount(0, { timeout: 10000 });
    const released = await probe();
    expect(released.toolId).toBe(owned.toolId);
    expect(released.allowed).toBe(true);

    await B.ctx.close();
  });

  test('TC-XDF-13: 자신이 소유자인 브로드캐스트는 상태를 바꾸지 않는다 (FR-XDF-14)', async ({ browser }) => {
    const A = await newClient(browser);
    const w1 = await activeWindowOf(A.page);

    await claim(A.page);
    await claim(A.page); // 같은 주장 반복 → 멱등
    await claim(A.page);

    const st = await A.page.evaluate((w) => {
      const app = (window as any).app;
      return { owner: app._windowFocusOwner[w], mine: app.clientId, dimmed: document.querySelectorAll('#area .pn.pn-dimmed').length };
    }, w1);
    expect(st.owner).toBe(st.mine);
    expect(st.dimmed).toBe(0);

    await A.ctx.close();
  });
});
