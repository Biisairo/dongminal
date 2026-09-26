import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled, JSON_HDR } from './fixtures';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-11 (D-OPT-2) — 터미널 지연 연결 · FR-OPT-4-12 (D-OPT-4) — 칸 SSE presence.
 *
 * **고정 대기의 예외 (`TEST-16`).** 아래의 `waitForTimeout` 은 **열리지 않는 WS**·
 * **오지 않는 방송**을 잰다 — 일어나지 않는 일에는 기다릴 신호가 없다.
 */

const HIDDEN = 3;
const FILL = 'yes dm-tlc-fill | head -n 3000';

// 포커스 칸에 터미널 탭 HIDDEN 개를 더하고, 칸마다 출력을 채운 뒤 첫 탭으로 돌아간다.
// 배경 창 하나(터미널 하나)도 만든다 — 다른 창의 도구도 숨은 도구다.
async function seedHidden(page: Page, request: any): Promise<{ first: string; hidden: string[]; all: string[] }> {
  const r = await page.evaluate(async (n) => {
    const app = (window as any).app;
    const pane = app.focused;
    const first = app.testing.focusedTerminal().id;
    for (let i = 0; i < n; i++) await app.addTab(pane, 'terminal');
    const bg = await app.testing.mkWindow({ keepFocus: true });
    app.render();
    return { first, pane, bg: bg && bg.win };
  }, HIDDEN);
  await waitSettled(page);
  const all: string[] = ((await (await request.get('/api/state')).json()).tools || []).map((t: any) => t.id);
  for (const id of all) {
    const res = await request.post('/api/tools/input', { headers: JSON_HDR, data: { id, text: FILL, execute: true } });
    expect(res.ok()).toBe(true);
  }
  // 첫 탭으로 돌아간다 — 나머지는 숨는다.
  await page.evaluate(({ first }) => {
    const app = (window as any).app;
    const loc = app.findToolLocation(first);
    app.switchTab(loc.pane.id, loc.tab.id);
  }, r);
  await waitSettled(page);
  // 스크롤백이 채워질 때까지 — 재생 바이트를 재려면 채워져 있어야 한다.
  for (const id of all) {
    await expect.poll(async () => {
      const o = await request.get('/api/tools/output?id=' + id + '&strip=1');
      return o.ok() ? ((await o.json()).text || '').split('dm-tlc-fill').length : 0;
    }, { timeout: 20000 }).toBeGreaterThan(3000);
  }
  return { first: r.first, hidden: all.filter((x) => x !== r.first), all };
}

type Boot = { ws: string[]; bytes: number };

// 새로고침 한 번에 열린 터미널 WS 와 그 WS 로 받은 바이트.
async function measureBoot(page: Page): Promise<Boot> {
  const box: Boot = { ws: [], bytes: 0 };
  page.on('websocket', (ws) => {
    const u = new URL(ws.url());
    if (u.pathname !== '/ws') return;
    box.ws.push(u.searchParams.get('tool') || '');
    ws.on('framereceived', (f) => {
      const p: any = f.payload;
      box.bytes += typeof p === 'string' ? p.length : p.byteLength;
    });
  });
  await page.reload();
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await waitSettled(page);
  await expect.poll(() => page.evaluate(() => {
    for (const p of (window as any).app.tools.values()) if (!p.ws || p.ws.readyState !== 1) return false;
    return true;
  }), { timeout: 15000 }).toBe(true);
  // TEST-16: 숨은 도구의 WS 가 **열리지 않음**을 잰다.
  await page.waitForTimeout(1500);
  return box;
}

test('TLC1 (IPC-5): 새로고침은 보이는 터미널의 WS 만 연다', async ({ page, request }, info) => {
  await waitForInit(page);
  const s = await seedHidden(page, request);
  const boot = await measureBoot(page);
  info.annotations.push({ type: 'measure', description: `tools=${s.all.length} ws=${boot.ws.length} bytes=${boot.bytes}` });
  console.log(`[TLC1] tools=${s.all.length} ws=${boot.ws.length} bytes=${boot.bytes}`);
  expect(boot.ws, '숨은 도구의 WS 를 열었다').toEqual([s.first]);
  // 숨은 도구도 살아 있는 도구로 안다 — clean() 이 그 탭을 지우지 않는다.
  const known = await page.evaluate(() => [...(window as any).app.toolIds].sort());
  expect(known).toEqual([...s.all].sort());
  const tabs = await page.evaluate((first) => {
    const app = (window as any).app;
    return app.findToolLocation(first).pane.tabs.length;
  }, s.first);
  expect(tabs).toBe(HIDDEN + 1);
});

test('TLC2 (IPC-5): 숨은 탭은 처음 그려질 때 붙고 전량을 재생한다', async ({ page, request }) => {
  await waitForInit(page);
  const s = await seedHidden(page, request);
  const boot = await measureBoot(page);
  expect(boot.ws).toEqual([s.first]);
  const target = s.hidden[0];
  await page.evaluate((id) => {
    const app = (window as any).app;
    const loc = app.findToolLocation(id);
    app.switchTab(loc.pane.id, loc.tab.id);
  }, target);
  await expect.poll(() => boot.ws.includes(target), { timeout: 10000 }).toBe(true);
  await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('dm-tlc-fill', { timeout: 15000 });
});

test('TLC3 (IPC-5): 원격 워크스페이스 변경이 붙지 않은 도구의 탭을 지우지 않고, 죽은 도구의 탭은 지운다', async ({ page, request }) => {
  await waitForInit(page);
  const s = await seedHidden(page, request);
  await measureBoot(page);
  const [gone, kept] = s.hidden;
  const res = await request.delete('/api/tools/' + gone, { headers: JSON_HDR });
  expect(res.ok()).toBe(true);
  // 지우기는 방송하지 않는다 — 다음 워크스페이스 변경이 목록을 싣는다. 그 경로를 부른다.
  await page.evaluate(() => (window as any).app.testing.onWorkspaceChanged());
  await expect.poll(() => page.evaluate((id) => !!(window as any).app.findToolLocation(id), gone), { timeout: 15000 }).toBe(false);
  expect(await page.evaluate((id) => !!(window as any).app.findToolLocation(id), kept), '붙지 않은 도구의 탭이 사라졌다').toBe(true);
  expect(await page.evaluate((id) => (window as any).app.toolIds.has(id), gone)).toBe(false);
});

test('TLC4 (IPC-11): 칸 구독은 presence 로 열리고 방송을 받지 않는다', async ({ page }) => {
  await waitForInit(page);
  await page.evaluate(() => (window as any).app.slotAdd());
  await expect.poll(() => page.evaluate(() => (window as any).app.bus.channels().map((c: any) => c.url)), { timeout: 10000 })
    .toContainEqual(expect.stringContaining('presence=1'));
  // 칸 구독에 온 메시지를 센다. 인사(server_hello)는 keepalive 라 뺀다.
  await page.evaluate(() => {
    const es = (window as any).app.bus._extra.get('slot:1').es;
    (window as any).__slotMsgs = [];
    es.addEventListener('message', (e: MessageEvent) => {
      const a = JSON.parse(e.data).action;
      if (a !== 'server_hello') (window as any).__slotMsgs.push(a);
    });
  });
  // 방송을 일으킨다 — 워크스페이스 저장은 workspace_changed 를 모두에게 보낸다.
  await page.evaluate(() => {
    const got: string[] = [];
    (window as any).app.bus.subscribe('workspace_changed', () => got.push('workspace_changed'), { owner: 'tlc4' });
    (window as any).__mainMsgs = got;
  });
  await page.evaluate(async () => { const app = (window as any).app; await app.testing.mkWindow({ keepFocus: true }); app.save() });
  await expect.poll(() => page.evaluate(() => (window as any).__mainMsgs.length), { timeout: 10000 }).toBeGreaterThan(0);
  // TEST-16: 칸 구독에 방송이 **오지 않음**을 잰다.
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as any).__slotMsgs), '칸 구독이 방송을 받았다').toEqual([]);
});

test('TLC5 (IPC-5): 그려지지 않은 창의 칸을 나누어도 새 도구는 그 칸 도구의 cwd 를 잇는다', async ({ page, request }) => {
  await waitForInit(page);
  const s = await seedHidden(page, request);
  await measureBoot(page);
  const ref = await page.evaluate((hidden) => {
    const app = (window as any).app;
    for (const id of hidden) {
      const loc = app.findToolLocation(id);
      if (loc && loc.win.id !== app.ws.activeWindow) return { tool: id, win: loc.win.id, pane: loc.pane.id, drawn: !!app.toolAny(id) };
    }
    return null;
  }, s.hidden);
  expect(ref, '다른 창의 도구가 없다').not.toBeNull();
  expect(ref!.drawn, '다른 창의 도구가 이미 그려졌다').toBe(false);
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && /\/api\/tools\?/.test(r.url())),
    page.evaluate((r) => (window as any).app.split('horizontal', { targetWindow: r.win, targetPane: r.pane, keepFocus: true }), ref!),
  ]);
  expect(new URL(req.url()).searchParams.get('cwdTool'), '그려지지 않은 도구의 cwd 를 잇지 않았다').toBe(ref!.tool);
});
