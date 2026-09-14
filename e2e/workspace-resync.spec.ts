import { test, expect, waitForInit } from './fixtures';

// V-M9-10 — 끊겼던 클라이언트는 복귀할 때 워크스페이스를 다시 받는다
// (M9_SRS FR-M9-10, D-M9-8)
//
// **이 검사가 재는 것은 증상이 아니라 보장이다.** 그 구분에 값을 치렀으므로
// 여기 적어 둔다 (M9_PROGRESS §2-12).
//
// 접수한 증상("다른 기기로 지운 탭이 내 화면에 남는다")은 지금 시스템에서 e2e 로
// 재현되지 않는다. 재연결한 클라이언트에는 `server_hello` 뒤에 `workspace_changed`
// 방송이 **따라오고**, 그 방송이 이미 있던 경로로 수렴을 만든다. 저장을 막고,
// 포커스 주장을 막고, 서버 반영을 기다린 뒤에 깨워도 그랬다 — 시도 넷 모두
// 구현 없이 초록이었다.
//
// 그러나 그 수렴은 **부수 효과**다. 어느 판에서 그 방송이 재연결과 겹치지 않게
// 되면 증상이 조용히 돌아오고, 그때 이 요구를 다시 찾을 근거가 없다. 그래서
// 재는 것을 "탭이 맞는가"(부수 경로가 대신 답한다)에서 **"재연결이 재수신을
// 부르는가"**(그 경로만이 답한다)로 옮긴다.

async function newClient(browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await waitForInit(page);
  return { ctx, page };
}

// 잠든 기기를 흉내낸다 (M9_PROGRESS §3-3). 구독을 끊고 새로 열리지 못하게 막는다.
const goOffline = (page) => page.evaluate(() => {
  const w = window as any;
  w.__origES = w.EventSource;
  try { w.app.bus._es.close() } catch {}
  w.EventSource = function () { throw new Error('offline') };
});

const goOnline = (page) => page.evaluate(() => {
  const w = window as any;
  if (w.__origES) w.EventSource = w.__origES;
  w.app.bus.reconnect();
});

const tabCount = (page) => page.evaluate(() => {
  const app = (window as any).app;
  let n = 0;
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'pane' && node.tabs) n += node.tabs.length;
    if (node.type === 'split' && node.children) for (const c of node.children) walk(c);
  };
  for (const win of app.ws.windows) walk(win.layout);
  return n;
});

const addTab = (page) => page.evaluate(async () => {
  const app = (window as any).app;
  const win = app.ws.windows.find((w) => w.id === app.ws.activeWindow);
  const pane = win.layout.type === 'pane' ? win.layout : win.layout.children[0];
  await app.addTab(pane.id, 'terminal', { windowId: win.id });
});

test.describe('V-M9-10 — 재연결은 워크스페이스를 다시 받는다', () => {
  test('TC-M9-10a: 재연결이 rev 없는 재수신을 부른다 (FR-M9-10, D-M9-8)', async ({ browser }) => {
    const A = await newClient(browser);

    // `_onWorkspaceChanged` 의 인자를 붙잡는다. **rev 가 없어야 한다** — 무엇을
    // 놓쳤는지 모르므로 "낡았다" 로 걸러지면 안 된다 (FR-WSC-17).
    await A.page.evaluate(() => {
      const w = window as any;
      w.__resync = [];
      const orig = w.app._onWorkspaceChanged.bind(w.app);
      w.app._onWorkspaceChanged = function (rev) {
        w.__resync.push(rev === undefined ? 'no-rev' : rev);
        return orig(rev);
      };
    });

    await goOffline(A.page);
    await A.page.evaluate(() => { (window as any).__resync = [] });
    await goOnline(A.page);

    // 재연결 하나가 계기다. 끊겼던 동안의 사건은 재생되지 않으므로, 이 호출이
    // 그 구간을 메우는 유일한 길이다.
    await expect.poll(() => A.page.evaluate(() => (window as any).__resync),
      { timeout: 15000 }).toContain('no-rev');

    await A.ctx.close();
  });

  test('TC-M9-10d: 최초 연결에서는 부르지 않는다 (FR-M9-10 — "다시" 붙으면)', async ({ browser }) => {
    // 첫 연결에는 메울 구간이 없다 — 부팅이 방금 `/api/state` 로 받았다. 거기서
    // 한 번 더 받으면 **그 사이의 로컬 변경을 덮는다.** 전량 e2e 가 그것을
    // 잡았고(`session.spec.ts` "rename via double-click" 이 6/6 실패), 그래서
    // 이 검사가 있다. 잡히지 않으면 증상은 "이름을 고치는 중에 그 행이 사라진다"
    // 처럼 이 요구와 무관해 보이는 자리에서 난다.
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      const w = window as any;
      w.__resyncEarly = [];
      // `app` 이 서기 **전에** 건다 — 최초 `sse:open` 은 부팅 중에 난다.
      const iv = setInterval(() => {
        if (!w.app || !w.app._onWorkspaceChanged || w.__hooked) return;
        w.__hooked = true;
        clearInterval(iv);
        const orig = w.app._onWorkspaceChanged.bind(w.app);
        w.app._onWorkspaceChanged = function (rev) {
          w.__resyncEarly.push(rev === undefined ? 'no-rev' : rev);
          return orig(rev);
        };
      }, 1);
      sessionStorage.setItem('displayMode', 'desktop');
    });
    const page = await ctx.newPage();
    await waitForInit(page);
    await page.waitForTimeout(2000); // TEST-16: 최초 연결의 재수신이 **없음**을 잰다

    const early = await page.evaluate(() => (window as any).__resyncEarly || []);
    expect(early.filter((r) => r === 'no-rev')).toEqual([]);

    await ctx.close();
  });

  test('TC-M9-10b: 주기 폴링을 더하지 않는다 (D-M9-8)', async ({ browser }) => {
    const A = await newClient(browser);

    // 재연결 없이 가만히 둔다. 메울 구간이 있는 순간은 재연결 하나이고,
    // 그 밖의 시각에 묻는 것은 답을 이미 아는 물음이다.
    await A.page.evaluate(() => {
      const w = window as any;
      w.__resync = [];
      const orig = w.app._onWorkspaceChanged.bind(w.app);
      w.app._onWorkspaceChanged = function (rev) {
        w.__resync.push(rev === undefined ? 'no-rev' : rev);
        return orig(rev);
      };
    });
    // **예외 (`TEST-16`)**: 재수신이 **일어나지 않음**을 잰다. 조건으로 바꿀 수
    // 있는 사건이 없다 — 재는 것이 사건의 부재이므로 관측 창이 곧 단정이다.
    // 6초는 서버 인사 주기(15초)보다 짧게 두되, 주기 폴링이 들어온다면 그것이
    // 이 창 안에 한 번은 돌 만한 길이다.
    await A.page.waitForTimeout(6000);

    const seen = await A.page.evaluate(() => (window as any).__resync);
    expect(seen.filter((r) => r === 'no-rev')).toEqual([]);

    await A.ctx.close();
  });

  test('TC-M9-10c: 재연결 뒤 탭 집합이 서버와 같다 (FR-M9-10 의 DoD)', async ({ browser }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);

    await addTab(B.page);
    await addTab(B.page);
    const grown = await tabCount(B.page);
    await expect.poll(() => tabCount(A.page), { timeout: 15000 }).toBe(grown);

    await goOffline(A.page);
    await B.page.evaluate(() => {
      const app = (window as any).app;
      const win = app.ws.windows.find((w) => w.id === app.ws.activeWindow);
      const pane = win.layout.type === 'pane' ? win.layout : win.layout.children[0];
      const tab = pane.tabs[pane.tabs.length - 1];
      app.closeTab(pane.id, tab.id, win.id);
    });
    await expect.poll(() => tabCount(B.page), { timeout: 15000 }).toBe(grown - 1);
    expect(await tabCount(A.page)).toBe(grown);

    await goOnline(A.page);
    await expect.poll(() => tabCount(A.page), { timeout: 15000 }).toBe(grown - 1);

    await A.ctx.close();
    await B.ctx.close();
  });
});
