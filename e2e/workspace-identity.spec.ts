import { Page } from '@playwright/test';

import { test, expect, waitSettled } from './fixtures';

// WORKSPACE_IDENTITY_SRS §4 — 식별자(묶음 I)와 단일 실행자(묶음 X).
//
// 재현된 결함: 두 클라이언트가 붙은 채 newTab 을 한 번 보내면 둘 다 실행해
// 같은 탭 id 를 만들고 PTY 를 각자 생성한다 (SRS §2.1).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function newClient(browser: any) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  return { ctx, page };
}

// 활성 창의 (Pane id, 탭 id, toolId) 를 평면으로 돌려준다.
function shape(page: Page) {
  return page.evaluate(() => {
    const app = (window as any).app;
    const panes: any[] = [];
    const tabs: any[] = [];
    const windows: string[] = [];
    for (const w of app.ws.windows) {
      windows.push(w.id);
      const walk = (n: any) => {
        if (!n) return;
        if (n.type === 'pane') panes.push(n.id);
        for (const t of n.tabs || []) tabs.push({ id: t.id, toolId: t.toolId });
        for (const c of n.children || []) walk(c);
      };
      walk(w.layout);
    }
    return { windows, panes, tabs };
  });
}

const toolCount = async (request: any) =>
  ((await (await request.get('/api/state')).json()).tools || []).length;

test.describe('묶음 I — 엔터티 id 는 uuid 다', () => {
  test('TC-WID-1: 새로 만든 창·분할 칸·탭의 id 가 uuid 형식이다', async ({ page, request }) => {
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    const before = await shape(page);

    for (const action of ['newTab', 'splitV', 'newWindow']) {
      const r = await request.post('/api/commands', { data: { action, args: {} } });
      expect(r.status(), `${action} 이 거부됐다`).toBe(200);
    }
    await expect.poll(async () => (await shape(page)).windows.length, { timeout: 10000 })
      .toBeGreaterThan(before.windows.length);
    await expect.poll(async () => (await shape(page)).panes.length, { timeout: 10000 })
      .toBeGreaterThan(before.panes.length);

    const after = await shape(page);
    const newWindows = after.windows.filter((w) => !before.windows.includes(w));
    const newPanes = after.panes.filter((p) => !before.panes.includes(p));
    const newTabs = after.tabs.filter((t) => !before.tabs.some((b: any) => b.id === t.id));

    expect(newWindows.length, '새 창이 없다').toBeGreaterThan(0);
    expect(newPanes.length, '새 분할 칸이 없다').toBeGreaterThan(0);
    expect(newTabs.length, '새 탭이 없다').toBeGreaterThan(0);
    for (const id of [...newWindows, ...newPanes, ...newTabs.map((t) => t.id)]) {
      expect(id, `${id} 가 uuid 가 아니다`).toMatch(UUID_RE);
    }
  });

  test('TC-WID-2: 구 id 는 보존되고 schemaVersion 도 그대로다', async ({ page, request }) => {
    // 마이그레이션된 v2 파일은 구 형식 id(s1/r1/t1)를 담고 있다. 그 상태를 그대로
    // 주입해, uuid 전환이 기존 워크스페이스를 깨지 않는지 본다 (FR-WID-2).
    const tool = await (await request.post('/api/tools?cols=120&rows=40')).json();
    const legacyWs = {
      schemaVersion: 2,
      windows: [{
        id: 's1', name: 'Window',
        layout: {
          type: 'pane', id: 'r1', activeTab: 't1',
          tabs: [{ id: 't1', name: 'Shell', type: 'terminal', toolId: tool.id }],
        },
      }],
    };
    const get = await request.get('/api/workspace');
    const put = await request.put('/api/workspace', {
      headers: { 'If-Match': get.headers()['etag'] || '0', 'Content-Type': 'application/json' },
      data: JSON.stringify(legacyWs),
    });
    expect(put.status(), '구 형식 워크스페이스 주입 실패').toBeLessThan(300);

    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    const before = await shape(page);
    const legacy = [...before.windows, ...before.panes, ...before.tabs.map((t: any) => t.id)]
      .filter((id) => /^[srt]\d+$/.test(id));
    expect(legacy, '주입한 구 형식 id 가 로드되지 않았다').toEqual(
      expect.arrayContaining(['s1', 'r1', 't1']));

    await request.post('/api/commands', { data: { action: 'newTab', args: {} } });
    await expect.poll(async () => (await shape(page)).tabs.length, { timeout: 10000 })
      .toBeGreaterThan(before.tabs.length);

    const after = await shape(page);
    const all = [...after.windows, ...after.panes, ...after.tabs.map((t: any) => t.id)];
    for (const id of legacy) expect(all, `구 id ${id} 가 사라졌다`).toContain(id);
    const added = after.tabs.filter((t: any) => !before.tabs.some((b: any) => b.id === t.id));
    expect(added.length).toBe(1);
    expect(added[0].id, '새 탭이 구 형식으로 만들어졌다').toMatch(UUID_RE);

    const st = await (await request.get('/api/state')).json();
    expect(st.workspace?.schemaVersion).toBe(2);
  });

  test('TC-WID-3: 두 클라이언트가 동기화 전 각각 만들어도 id 가 겹치지 않는다', async ({ browser }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);
    await A.page.waitForTimeout(800);

    // 브로드캐스트가 아니라 각자 로컬 생성 — 단일 실행자 게이팅이 닿지 않는 경로다.
    // addTab 은 만든 탭의 {uuid, toolId} 를 돌려준다 (FR-RCR-7).
    const mk = (p: Page) => p.evaluate(() =>
      (window as any).app.addTab((window as any).app.focused, 'terminal'));
    const [ta, tb] = await Promise.all([mk(A.page), mk(B.page)]);

    expect(ta?.uuid, 'A 가 탭을 만들지 않았다').toBeTruthy();
    expect(tb?.uuid, 'B 가 탭을 만들지 않았다').toBeTruthy();
    expect(ta.uuid, '두 클라이언트가 같은 탭 id 를 만들었다').not.toBe(tb.uuid);

    await A.ctx.close(); await B.ctx.close();
  });
});

test.describe('묶음 X — 생성 명령은 한 클라이언트만 수행한다', () => {
  test('TC-SXE-6: 클라이언트 2개 + newTab 1회 → 탭 1개, 도구 1개만 생성된다', async ({ browser, request }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);
    await A.page.waitForTimeout(800);

    const before = await shape(A.page);
    const toolsBefore = await toolCount(request);

    const r = await request.post('/api/commands', { data: { action: 'newTab', args: {} } });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.delivered, '구독 중인 브라우저가 없다').toBeGreaterThan(0);

    await expect.poll(async () => (await shape(A.page)).tabs.length, { timeout: 10000 })
      .toBe(before.tabs.length + 1);
    await A.page.waitForTimeout(1000); // 늦게 오는 두 번째 생성이 있으면 여기서 드러난다

    const afterA = await shape(A.page);
    const afterB = await shape(B.page);
    expect(afterA.tabs.length, 'A 에 탭이 2개 늘었다 — 두 클라이언트가 각자 만들었다')
      .toBe(before.tabs.length + 1);
    expect(afterB.tabs.length, 'B 의 트리가 A 와 다르다').toBe(before.tabs.length + 1);

    expect(await toolCount(request), 'PTY 가 2개 생겼다 — 하나는 고아다')
      .toBe(toolsBefore + 1);

    // FR-SXE-7: 응답의 echo id 가 실제로 수렴한 트리와 일치해야 한다.
    const echoed = (body.newTabs || [])[0];
    expect(echoed, 'newTabs echo 가 없다').toBeTruthy();
    const landed = afterA.tabs.find((t: any) => t.id === echoed.uuid);
    expect(landed, `echo 된 탭 ${echoed.uuid} 가 트리에 없다`).toBeTruthy();
    expect(landed!.toolId, 'echo 된 toolId 가 아무도 보지 않는 PTY 를 가리킨다')
      .toBe(echoed.toolId);

    await A.ctx.close(); await B.ctx.close();
  });

  test('TC-SXE-7: focus 는 게이팅되지 않는다 — 두 클라이언트 모두 수행한다', async ({ browser, request }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);
    await A.page.waitForTimeout(800);

    // 분할해 Pane 을 2개로 만든 뒤, 두 번째 Pane 의 탭을 대상으로 focus 를 보낸다.
    await request.post('/api/commands', { data: { action: 'splitV', args: {} } });
    await expect.poll(async () => (await shape(A.page)).panes.length, { timeout: 10000 })
      .toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await shape(B.page)).panes.length, { timeout: 10000 })
      .toBeGreaterThanOrEqual(2);

    const st = await (await request.get('/api/state')).json();
    const tabs: any[] = [];
    for (const w of st.workspace?.windows || []) {
      const walk = (n: any) => {
        if (!n) return;
        for (const t of n.tabs || []) tabs.push(t);
        for (const c of n.children || []) walk(c);
      };
      walk(w.layout);
    }
    const target = tabs[tabs.length - 1];
    const r = await request.post('/api/commands', { data: { action: 'focus', args: { location: target.id } } });
    expect(r.status()).toBe(200);

    // 두 클라이언트 모두 자기 뷰의 포커스를 그 탭이 있는 Pane 으로 옮겨야 한다.
    for (const [name, p] of [['A', A.page], ['B', B.page]] as const) {
      await expect.poll(() => p.evaluate((tid) => {
        const app = (window as any).app;
        const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
        let owner: string | null = null;
        const walk = (n: any) => {
          if (!n) return;
          if (n.type === 'pane' && (n.tabs || []).some((t: any) => t.id === tid)) owner = n.id;
          for (const c of n.children || []) walk(c);
        };
        walk(w?.layout);
        return owner !== null && app.focused === owner;
      }, target.id), { timeout: 10000 }).toBe(true);
      void name;
    }

    await A.ctx.close(); await B.ctx.close();
  });
});

// ---------------------------------------------------------------------------
// 묶음 U — 모든 식별자가 uuid 다 (WORKSPACE_IDENTITY_SRS §3.4)
// ---------------------------------------------------------------------------

test.describe('묶음 U — 식별자 통일', () => {
  // TC-UNI-5: 새로 만든 도구의 toolId 가 uuid 형식이다.
  // 이전에는 서버 카운터("267")였고 재기동 후 재사용됐다 (SRS §2.7 (3)).
  test('TC-UNI-5: 새 도구의 toolId 가 uuid 다', async ({ page, request }) => {
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    const r = await request.post('/api/commands', { data: { action: 'newTab' } });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.newTabs?.length).toBeGreaterThan(0);
    expect(body.newTabs[0].toolId).toMatch(UUID_RE);
  });

  // TC-UNI-14: location 정책(FR-DMC-9)은 식별자 형식 변경에 흔들리지 않는다 —
  // 탭 uuid 만 받고 toolId 는 uuid 형식이 되어도 거부한다.
  // (toolId pass-through 계약은 CoordinateOf 단위 테스트 TC-UNI-12 가 덮는다.)
  test('TC-UNI-14: location 은 탭 uuid 만 받고 uuid toolId 는 거부한다', async ({ page, request }) => {
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    const created = await (await request.post('/api/commands', { data: { action: 'newTab' } })).json();
    const { uuid: tabUuid, toolId } = created.newTabs[0];
    expect(tabUuid).toMatch(UUID_RE);
    expect(toolId).toMatch(UUID_RE);
    // FR-EQS-6: 탭을 만든 것은 브라우저다. `location` 조회는 **서버의**
    // 워크스페이스를 훑으므로, 그 PUT 이 나간 뒤라야 찾을 수 있다 (§2.2).
    await waitSettled(page);

    const byTool = await request.post('/api/commands', { data: { action: 'focus', args: { location: toolId } } });
    expect(byTool.status()).toBe(400);

    const byTab = await request.post('/api/commands', { data: { action: 'focus', args: { location: tabUuid } } });
    expect(byTab.status()).toBe(200);
    expect((await byTab.json()).ok).toBe(true);
  });

  // TC-UNI-16: who-am-i 계약(/api/whoami)의 uuid·short 가 uuid 파생이다.
  test('TC-UNI-16: whoami 의 uuid·short 가 uuid 파생이다', async ({ page, request }) => {
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    const created = await (await request.post('/api/commands', { data: { action: 'newTab' } })).json();
    const toolId = created.newTabs[0].toolId;
    // FR-EQS-6: whoami 의 좌표도 서버의 워크스페이스에서 나온다 (§2.2).
    await waitSettled(page);

    const who = await (await request.get(`/api/whoami?toolId=${encodeURIComponent(toolId)}`)).json();
    expect(who.uuid).toMatch(UUID_RE);
    expect(who.short).toBe(String(who.uuid).slice(0, 8));
  });

  // TC-UNI-4: clientId 가 uuid 형식이다 (Math.random 폴백 제거, FR-UNI-4/5).
  test('TC-UNI-4: clientId 가 uuid 다', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    const cid = await page.evaluate(() => (window as any).app.clientId);
    expect(cid).toMatch(UUID_RE);
  });

  // TC-UNI-1/3: newUUID 가 보안 컨텍스트가 아닌 환경에서도 동작하고, 폴백조차
  // 불가능하면 조용히 저품질 id 를 내는 대신 예외를 던진다.
  // --expose 로 LAN 에 노출하면 crypto.randomUUID 가 undefined 다 (SRS §2.7 (1)).
  test('TC-UNI-1/3: randomUUID 없이도 uuid 를 만들고, crypto 가 없으면 던진다', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    const out = await page.evaluate(() => {
      const src = (window as any).newUUID.toString();
      const mk = (cryptoObj: any) => new Function('crypto', `return (${src})()`)(cryptoObj);
      const fallback = mk({ getRandomValues: (a: Uint8Array) => crypto.getRandomValues(a) });
      let threw = false;
      try { mk({}); } catch { threw = true; }
      return { fallback, threw };
    });

    expect(out.fallback).toMatch(UUID_RE);
    expect(out.fallback[14]).toBe('4');            // version 4
    expect('89ab').toContain(out.fallback[19]);    // variant 10
    expect(out.threw).toBe(true);
  });
});
