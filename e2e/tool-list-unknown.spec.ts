import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled } from './fixtures';

// TOOL_LIST_UNKNOWN_SRS §5 — TC-TLU-4~11.
//
// 데몬을 실제로 죽여 재접속 창을 만들 수도 있으나, 그러면 검증이 데몬의 재기동
// 속도에 매달린다. 여기서 재려는 것은 **클라이언트가 `toolsKnown:false` 를 어떻게
// 읽는가** 하나이므로 `/api/state` 응답을 가로채 그 한 비트만 바꾼다 — 결정적이고,
// 서버가 그 비트를 정하는 규칙(FR-TLU-2)은 Go 테스트가 따로 잰다.

const toolKeys = (page: Page) => page.evaluate(() => [...(window as any).app.tools.keys()]);
const windowCount = (page: Page) =>
  page.evaluate(() => ((window as any).app.ws.windows || []).length);
const activeWindowOf = (page: Page) => page.evaluate(() => (window as any).app.ws.activeWindow);

const addWindow = (page: Page) =>
  page.evaluate(async () => {
    const r = await (window as any).app._mkWindow();
    (window as any).app.render();
    return r.win;
  });

// 열린 WebSocket 을 센다. term-pane 은 자기 소켓을 `ws` 에 들고 있으므로 재연결이
// 일어나면 인스턴스가 갈린다 — 그 사실을 id 로 표시해 두고 뒤에 비교한다.
async function markSockets(page: Page) {
  await page.evaluate(() => {
    let n = 0;
    for (const p of (window as any).app.tools.values()) {
      if (p && p.ws) p.ws.__mark = ++n;
    }
    (window as any).__marked = n;
  });
}

async function socketsReplaced(page: Page): Promise<number> {
  return page.evaluate(() => {
    let replaced = 0;
    for (const p of (window as any).app.tools.values()) {
      if (!p) continue;
      if (!p.ws || !p.ws.__mark) replaced++;
    }
    return replaced;
  });
}

/**
 * 다음 `/api/state` 응답의 도구 목록과 `toolsKnown` 을 바꾼다.
 *
 * 워크스페이스는 **서버가 준 것을 그대로 흘려보낸다** — 도구를 모르는 순간에도
 * 워크스페이스는 참이라는 것이 FR-TLU-4 이고, 이 스텁이 그것을 흉내내지 않으면
 * 검증이 재는 것이 달라진다.
 */
async function stubState(page: Page, opts: { known: boolean; tools?: unknown[] }) {
  await page.route('**/api/state', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.tools = opts.tools ?? [];
    body.toolsKnown = opts.known;
    await route.fulfill({
      response: res,
      body: JSON.stringify(body),
      headers: { ...res.headers(), 'content-type': 'application/json' },
    });
  });
}

// 인자 없는 `_onWorkspaceChanged` 는 rev 비교를 건너뛰고 무조건 받아 적용한다
// (`app-cmd.js` 의 `typeof rev==='number'`). SSE 가 나르는 것과 같은 경로다.
const applyState = (page: Page) =>
  page.evaluate(() => (window as any).app._onWorkspaceChanged());

test.describe('묶음 L — 도구 목록을 모를 때 하지 않는 일', () => {
  test('TC-TLU-4·5 (FR-TLU-5·6): 모르는 스냅숏은 도구도 창도 지우지 않는다', async ({ page }) => {
    await waitForInit(page);
    await addWindow(page);
    const keys0 = await toolKeys(page);
    const wins0 = await windowCount(page);
    expect(keys0.length).toBeGreaterThan(0);

    await markSockets(page);
    await stubState(page, { known: false, tools: [] });
    await applyState(page);

    expect(await toolKeys(page), '모르는 목록으로 도구를 파괴했다').toEqual(keys0);
    expect(await windowCount(page), '모르는 목록으로 창을 지웠다').toBe(wins0);
    expect(await socketsReplaced(page), '재연결이 일어났다').toBe(0);
  });

  test('TC-TLU-11 (FR-TLU-5): 아는 빈 목록은 여전히 도구를 거둔다', async ({ page }) => {
    await waitForInit(page);
    expect((await toolKeys(page)).length).toBeGreaterThan(0);

    await stubState(page, { known: true, tools: [] });
    await applyState(page);

    expect(await toolKeys(page), '청소가 죽었다 — 아는 빈 목록은 거두어야 한다').toEqual([]);
  });

  test('TC-TLU-7 (FR-TLU-8): 모르는 스냅숏이 실어 온 구조 변경은 적용된다', async ({ page }) => {
    await waitForInit(page);
    const wins0 = await windowCount(page);

    // 다른 클라이언트가 창을 하나 더 만든 상황. 워크스페이스에는 있고, 도구
    // 목록은 모른다 — 구조는 도구를 몰라도 참이다.
    //
    // 창 안의 탭은 **이미 있는 도구**를 가리킨다. 새 도구를 가리키게 하면
    // 이 검증이 재려는 것(구조가 적용되는가)에 "모르는 도구를 담은 pane 도
    // 살아남는가"가 섞인다 — 그것은 FR-TLU-6 이 따로 재는 자리다.
    await page.evaluate(async () => {
      const app = (window as any).app;
      const toolId = [...app.tools.keys()][0];
      const r = await fetch('/api/workspace');
      const rev = r.headers.get('ETag') || '0';
      const ws = await r.json();
      ws.windows.push({
        id: 'tlu-remote-win',
        name: 'remote',
        layout: {
          type: 'pane', id: 'tlu-remote-pane', activeTab: 'tlu-remote-tab',
          tabs: [{ id: 'tlu-remote-tab', name: 'Shell', type: 'terminal', toolId }],
        },
      });
      await fetch('/api/workspace', {
        method: 'PUT',
        headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
        body: JSON.stringify(ws),
      });
      app.wsETag = null;
    });

    await stubState(page, { known: false, tools: [] });
    await applyState(page);

    expect(await windowCount(page)).toBe(wins0 + 1);
  });
});

test.describe('묶음 M — 죽은 도구 청소와 슬롯 키', () => {
  test('TC-TLU-9·10 (FR-TLU-10): 칸 1 의 살아 있는 도구가 파괴되지 않는다', async ({ page }) => {
    await waitForInit(page);
    const win = await activeWindowOf(page);
    // 칸을 하나 더 열고 같은 창을 담는다 — 같은 도구의 인스턴스가 칸마다 선다
    // (FR-WSL-20). 칸 1 의 키는 `toolId@1` 이다.
    await page.evaluate((id) => {
      const app = (window as any).app;
      app.slotAdd();
      app.slotOpen(1, id);
      app.slotFocusTo(0);
      app.render();
    }, win);

    const keys = await toolKeys(page);
    const slotted = keys.filter((k: string) => k.includes('@1'));
    expect(slotted.length, '칸 1 인스턴스가 서지 않았다 — 전제가 깨졌다').toBeGreaterThan(0);

    await markSockets(page);
    await applyState(page);

    expect(await toolKeys(page), '칸 1 인스턴스가 파괴됐다').toEqual(keys);
    expect(await socketsReplaced(page), '칸 1 인스턴스가 다시 붙었다').toBe(0);
  });

  test('TC-TLU-11b (FR-TLU-10): 서버가 모르는 도구는 두 칸 모두에서 거둔다', async ({ page }) => {
    await waitForInit(page);
    const win = await activeWindowOf(page);
    await page.evaluate((id) => {
      const app = (window as any).app;
      app.slotAdd();
      app.slotOpen(1, id);
      app.slotFocusTo(0);
      app.render();
    }, win);
    expect((await toolKeys(page)).some((k: string) => k.includes('@1'))).toBe(true);

    await stubState(page, { known: true, tools: [] });
    await applyState(page);

    expect(await toolKeys(page), '청소가 슬롯 인스턴스를 남겼다').toEqual([]);
  });
});
