import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// 묶음 D (USER_CHECKLIST_FIXES_SRS §3.4 / §4.4) — restoreTool 의 대상 Pane 지정.
//
// 서버는 이미 준비되어 있다. translateLocationUUID 는 action 종류를 보지 않고
// args.location 을 uuid→좌표로 변환하며 restoreTool 은 화이트리스트에 있다.
// 클라이언트와 CLI 만 이를 쓰지 않았다 (§2.6).

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// Pane 2개를 만들고, 포커스된 Pane 에 탭을 하나 더 붙인다.
//
// 탭이 1개인 Pane 에서 detach 하면 그 Pane 이 제거되고 남은 Pane 이 자동으로
// 포커스를 받는다 — 그러면 location 을 무시하는 구현도 우연히 통과한다.
// 포커스 Pane 에 탭을 2개 두어 detach 후에도 Pane 이 살아 있게 한다.
async function twoPanes(page: Page, request: any) {
  const split = await request.post('/api/commands', {
    data: { action: 'splitV', args: { keepFocus: true } },
  });
  expect(split.status()).toBe(200);
  await expect.poll(() => paneInfo(page).then((i) => i.panes.length), { timeout: 10000 })
    .toBeGreaterThanOrEqual(2);

  const add = await request.post('/api/commands', { data: { action: 'newTab', args: {} } });
  expect(add.status()).toBe(200);
  await expect.poll(async () => {
    const i = await paneInfo(page);
    const f = i.panes.find((p) => p.id === i.focused);
    return f ? f.tabCount : 0;
  }, { timeout: 10000 }).toBeGreaterThanOrEqual(2);

  const info = await paneInfo(page);
  const focused = info.panes.find((p) => p.id === info.focused)!;
  const other = info.panes.find((p) => p.id !== info.focused)!;
  expect(focused.tabCount, '포커스 Pane 의 탭이 2개가 아니다').toBeGreaterThanOrEqual(2);
  expect(other, '포커스 밖의 Pane 을 찾지 못했다').toBeTruthy();
  return { info, focused, other };
}

async function paneInfo(page: Page) {
  return page.evaluate(() => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    const out: any[] = [];
    const walk = (n: any) => {
      if (!n) return;
      if (n.type === 'pane') { out.push(n); return }
      for (const c of n.children || []) walk(c);
    };
    walk(w?.layout);
    return {
      focused: app.focused as string,
      panes: out.map((p) => ({
        id: p.id as string,
        tabCount: p.tabs.length as number,
        tabUuids: p.tabs.map((t: any) => t.id) as string[],
        toolIds: p.tabs.map((t: any) => t.toolId) as string[],
      })),
    };
  });
}

// 지정한 도구를 백그라운드로 보낸다 (실제 detach 경로).
async function detach(page: Page, request: any, toolId: string) {
  const r = await request.post('/api/commands', { data: { action: 'detachTab', args: { toolId } } });
  expect(r.status()).toBe(200);
  await expect.poll(async () => {
    const bg = await (await request.get('/api/tools/background')).json();
    return (bg.background || []).some((b: any) => b.toolId === toolId);
  }, { timeout: 10000 }).toBe(true);
}

async function tabCountOf(page: Page, paneId: string) {
  return page.evaluate((pid) => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    const find = (n: any): any => {
      if (!n) return null;
      if (n.type === 'pane') return n.id === pid ? n : null;
      for (const c of n.children || []) { const r = find(c); if (r) return r }
      return null;
    };
    const pn = find(w?.layout);
    return pn ? pn.tabs.length : -1;
  }, paneId);
}

test.describe('FR-BGR-1/2: location 으로 복귀 대상 Pane 을 지정한다', () => {
  test('TC-BGR-1: 지정한 탭이 속한 Pane 에 복귀한다', async ({ page, request }) => {
    await waitForInit(page);
    const { focused, other } = await twoPanes(page, request);

    // 포커스 Pane 의 탭 하나를 백그라운드로. 탭이 2개였으므로 Pane 은 살아남고
    // 포커스도 그대로다 — 대상 Pane(other) 은 여전히 포커스 밖이다.
    const toolId = focused.toolIds[0];
    await detach(page, request, toolId);

    const otherBefore = await tabCountOf(page, other.id);
    const focusedBefore = await tabCountOf(page, focused.id);

    const r = await request.post('/api/commands', {
      data: { action: 'restoreTool', args: { toolId, location: other.tabUuids[0] } },
    });
    expect(r.status(), `restoreTool 이 ${r.status()} 로 거부됐다`).toBe(200);

    // 대상 Pane 에 붙었다.
    await expect.poll(() => tabCountOf(page, other.id), { timeout: 10000 }).toBe(otherBefore + 1);
    // 포커스 Pane 은 늘지 않았다 — location 이 실제로 반영됐다는 증거.
    expect(await tabCountOf(page, focused.id)).toBe(focusedBefore);

    await expect.poll(async () => {
      const bg = await (await request.get('/api/tools/background')).json();
      return (bg.background || []).some((b: any) => b.toolId === toolId);
    }, { timeout: 10000 }).toBe(false);
  });

  test('TC-BGR-3: Pane 의 두 번째 탭 uuid 를 줘도 그 Pane 에 붙는다 (T 성분 무시)', async ({ page, request }) => {
    await waitForInit(page);
    const { focused, other } = await twoPanes(page, request);

    // 대상 Pane 에 탭을 하나 더 붙인다 (포커스는 옮기지 않는다). 탭이 2개여야
    // "두 번째 탭 uuid 로 지목했는데 Pane 단위로 붙는다" 를 확인할 수 있다.
    const add = await request.post('/api/commands', {
      data: { action: 'newTab', args: { location: other.tabUuids[0], keepFocus: true } },
    });
    expect(add.status()).toBe(200);
    await expect.poll(() => tabCountOf(page, other.id), { timeout: 10000 }).toBe(2);

    const toolId = focused.toolIds[0];
    await detach(page, request, toolId);

    const otherNow = (await paneInfo(page)).panes.find((p) => p.id === other.id)!;
    expect(otherNow.tabUuids.length).toBe(2);
    const focusedBefore = await tabCountOf(page, focused.id);

    const r = await request.post('/api/commands', {
      data: { action: 'restoreTool', args: { toolId, location: otherNow.tabUuids[1] } },
    });
    expect(r.status()).toBe(200);

    await expect.poll(() => tabCountOf(page, other.id), { timeout: 10000 }).toBe(3);
    expect(await tabCountOf(page, focused.id)).toBe(focusedBefore);
  });

  test('TC-BGR-2: location 미지정이면 현재 포커스 Pane 에 복귀한다 (기존 동작)', async ({ page, request }) => {
    await waitForInit(page);
    const { focused, other } = await twoPanes(page, request);
    const toolId = other.toolIds[0];
    await detach(page, request, toolId);

    const beforeFocused = await tabCountOf(page, focused.id);
    const r = await request.post('/api/commands', {
      data: { action: 'restoreTool', args: { toolId } },
    });
    expect(r.status()).toBe(200);

    await expect.poll(() => tabCountOf(page, focused.id), { timeout: 10000 })
      .toBe(beforeFocused + 1);
  });

  test('TC-BGR-4: 좌표·toolId 를 location 으로 주면 서버가 거부한다', async ({ page, request }) => {
    await waitForInit(page);
    const { focused } = await twoPanes(page, request);
    const toolId = focused.toolIds[0];
    await detach(page, request, toolId);

    for (const bad of ['W1.P1.T1', toolId]) {
      const r = await request.post('/api/commands', {
        data: { action: 'restoreTool', args: { toolId, location: bad } },
      });
      expect(r.status(), `location=${bad} 이 통과했다`).toBe(400);
    }
    // 거부됐으니 도구는 백그라운드에 그대로 있다.
    const bg = await (await request.get('/api/tools/background')).json();
    expect((bg.background || []).some((b: any) => b.toolId === toolId)).toBe(true);
  });

  test('TC-BGR-6: 존재하지 않는 uuid 면 복귀하지 않고 목록에 남는다', async ({ page, request }) => {
    await waitForInit(page);
    const { focused } = await twoPanes(page, request);
    const toolId = focused.toolIds[0];
    await detach(page, request, toolId);

    const r = await request.post('/api/commands', {
      data: { action: 'restoreTool', args: { toolId, location: 't99999' } },
    });
    // 알려지지 않은 탭 uuid 는 서버의 IsKnownTabID 게이트에서 400 이다.
    expect(r.status()).toBe(400);

    await page.waitForTimeout(500);
    const bg = await (await request.get('/api/tools/background')).json();
    expect((bg.background || []).some((b: any) => b.toolId === toolId),
      '복귀 실패인데 백그라운드 목록에서 사라졌다').toBe(true);
  });

  // FR-BGR-5: 브라우저가 대상 Pane 을 못 찾은 경우에도 백그라운드 상태를 먼저
  // 해제해서는 안 된다. 서버 게이트를 통과한 uuid 가 브라우저 시점에는 이미
  // 사라진 경쟁 상황을 _restoreTool 직접 호출로 재현한다.
  test('TC-BGR-6b: 브라우저가 대상을 못 찾으면 백그라운드 해제도 하지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    const { focused } = await twoPanes(page, request);
    const toolId = focused.toolIds[0];
    await detach(page, request, toolId);

    await page.evaluate((tid) => {
      const app = (window as any).app;
      return app._restoreTool(tid, { windowId: 'sZZZ', paneId: 'rZZZ' });
    }, toolId);
    await page.waitForTimeout(500);

    const bg = await (await request.get('/api/tools/background')).json();
    expect((bg.background || []).some((b: any) => b.toolId === toolId),
      '대상이 없는데 백그라운드 상태가 해제됐다').toBe(true);
  });
});

// FR-BGR-7: location 미지정은 "대상을 정하지 않았다"는 뜻이므로, 포커스 Pane 이
// 해소되지 않아도 조용히 무효가 되어서는 안 된다. 명시 대상(TC-BGR-6b)과 달리
// 폴백이 정당한 유일한 경로다.
test.describe('FR-BGR-7: location 미지정 복귀는 조용히 무효가 되지 않는다', () => {
  test('TC-BGR-8: 포커스가 해소되지 않으면 활성 창의 첫 Pane 에 복귀한다', async ({ page, request }) => {
    await waitForInit(page);
    const { focused } = await twoPanes(page, request);
    const toolId = focused.toolIds[0];
    await detach(page, request, toolId);

    // 포커스를 존재하지 않는 Pane 으로 만든다 — delWindow 의 else 분기가
    // this.focused=null 로 두는 상태(app.js:1180)와 같은 계열이다.
    await page.evaluate(() => { (window as any).app.focused = 'rZZZ' });

    const r = await request.post('/api/commands', {
      data: { action: 'restoreTool', args: { toolId } },
    });
    expect(r.status()).toBe(200);

    await expect.poll(async () => {
      const bg = await (await request.get('/api/tools/background')).json();
      return (bg.background || []).some((b: any) => b.toolId === toolId);
    }, { timeout: 10000 }).toBe(false);

    // 활성 창 어딘가의 탭으로 돌아와 있어야 한다.
    await expect.poll(() => page.evaluate((tid) => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      let found = false;
      const walk = (n: any) => {
        if (!n) return;
        for (const t of n.tabs || []) if (t.toolId === tid) found = true;
        for (const c of n.children || []) walk(c);
      };
      walk(w?.layout);
      return found;
    }, toolId), { timeout: 10000 }).toBe(true);
  });

  test('TC-BGR-9: 창이 하나도 없는 과도 상태에서도 복귀한다', async ({ page, request }) => {
    await waitForInit(page);
    // 창·Pane·탭이 하나씩인 상태에서 그 탭을 detach 하면 창이 사라지고
    // delWindow 가 _mkWindow 를 await 하는 동안 ws.windows 가 빈다.
    const toolId = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      const walk = (n: any): string | null => {
        if (!n) return null;
        for (const t of n.tabs || []) if (t.toolId) return t.toolId;
        for (const c of n.children || []) { const r = walk(c); if (r) return r }
        return null;
      };
      return walk(w?.layout);
    });
    expect(toolId).toBeTruthy();

    // 그 순간을 명중시킨다 — 폴링해서 windows 가 비는 즉시 복귀를 건다.
    //
    // EDITOR_TAB_SRS FR-EDT-13: root 에디터 창이 항상 존재하므로 `ws.windows`
    // 는 이 과도 상태에서도 결코 0 이 되지 않는다 — 일반 창(`fixtures.ts`
    // `plainWindows` 와 같은 판정: `type` 이 `git`·`editor` 가 아닌 창)이 0 인
    // 순간을 잰다. 폴링 루프는 페이지 안에서 타이트하게 돌아야 하므로(매
    // 틱마다 Node 로 왕복할 수 없다) 같은 판정을 여기 인라인한다.
    const armed = page.evaluate(async (tid) => {
      const app = (window as any).app;
      const plainCount = () => app.ws.windows.filter((w: any) => w && w.type !== 'git' && w.type !== 'editor').length;
      const t0 = performance.now();
      while (performance.now() - t0 < 15000) {
        if (plainCount() === 0) { await app._restoreTool(tid); return true }
        await new Promise((r) => setTimeout(r, 1));
      }
      return false;
    }, toolId);

    const d = await request.post('/api/commands', { data: { action: 'detachTab', args: { toolId } } });
    expect(d.status()).toBe(200);
    expect(await armed, '창이 비는 과도 상태를 명중시키지 못했다').toBe(true);

    await expect.poll(async () => {
      const bg = await (await request.get('/api/tools/background')).json();
      return (bg.background || []).some((b: any) => b.toolId === toolId);
    }, { timeout: 10000 }).toBe(false);

    await expect.poll(() => page.evaluate((tid) => {
      const app = (window as any).app;
      let found = false;
      for (const w of app.ws.windows) {
        const walk = (n: any) => {
          if (!n) return;
          for (const t of n.tabs || []) if (t.toolId === tid) found = true;
          for (const c of n.children || []) walk(c);
        };
        walk(w.layout);
      }
      return found;
    }, toolId), { timeout: 10000 }).toBe(true);
  });
});
