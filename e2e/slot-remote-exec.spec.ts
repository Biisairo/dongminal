import { test, expect, waitForInit, JSON_HDR } from './fixtures';

/**
 * PERF 4.3 — 칸 [1] 이상에 포커스가 있어도 원격 명령이 실행된다.
 *
 * 칸마다 신원이 다르고(FR-WSL-10) 서버는 가장 최근에 포커스를 주장한 신원을 실행자로
 * 지명한다(FR-SXE-4). 칸 [1] 이 지명되면 그 창은 자기 것으로 알아보고 **한 번** 실행해야 한다.
 * 기기 둘(브라우저 컨텍스트 둘)일 때는 여전히 가장 최근에 주장한 기기만 실행한다.
 *
 * 재는 것: 응답(`newTabs`·`timedOut`)과 트리, 그리고 지명 신원·실행 횟수(버스·`_execRemote` 감시).
 */

async function newClient(browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
  const page = await ctx.newPage();
  await waitForInit(page);
  // 받은 지명과 실제 실행을 센다 — 채널은 `bus.route`, 실행은 `tool.cmd._execRemote` 를 부른다.
  await page.evaluate(() => {
    const a = (window as any).app;
    const w = window as any;
    w.__exec = [];
    w.__named = [];
    const route = a.bus.route.bind(a.bus);
    a.bus.route = (m) => { if (m && m.execClientId) w.__named.push(m.execClientId); route(m) };
    const exec = a.tool.cmd._execRemote.bind(a.tool.cmd);
    a.tool.cmd._execRemote = (action, args) => { w.__exec.push(action); exec(action, args) };
  });
  return { ctx, page };
}

const cmd = (request, action: string, args: Record<string, unknown> = {}) =>
  request.post('/api/commands', { headers: JSON_HDR, data: { action, args } });
const execOf = (page, action: string) =>
  page.evaluate((a) => (window as any).__exec.filter((x) => x === a).length, action);
const lastNamed = (page) => page.evaluate(() => (window as any).__named.slice(-1)[0] || null);
const slotIds = (page) => page.evaluate(() => (window as any).app.slot._slotIdentities());
const mkBgWindow = (page) => page.evaluate(async () => {
  const r = await (window as any).app.testing.mkWindow({ keepFocus: true });
  (window as any).app.render();
  return r.win;
});
const owners = async (request) => ((await (await request.get('/api/focus')).json()).owners || {}) as Record<string, string>;
const tabUuids = (page) => page.evaluate(() => {
  const out: string[] = [];
  for (const w of (window as any).app.ws.windows) for (const p of (window as any).app.flattenPanes(w.layout)) for (const t of p.tabs || []) out.push(t.uuid || t.id);
  return out;
});

/**
 * 칸 둘에 서로 다른 창을 두고 칸 [1] 에 포커스를 준 뒤, 칸 [1] 이 **새 창을 주장**하게 한다 —
 * 소유가 바뀌어야 주장 순번이 오른다(`focus.rs` claim). 칸 [1] 의 신원을 돌려준다.
 */
async function focusSlot1(page, request) {
  const w2 = await mkBgWindow(page);
  const w3 = await mkBgWindow(page);
  await page.evaluate(() => (window as any).app.slot.ops.slotAdd());
  await page.evaluate((id) => (window as any).app.slot.ops.slotOpen(1, id), w2);
  await page.evaluate(() => (window as any).app.slot.ops.slotFocusTo(1));
  await page.evaluate((id) => (window as any).app.slot.ops.slotOpen(1, id), w3);
  const s1 = (await slotIds(page))[1];
  await expect.poll(async () => (await owners(request))[w3], { timeout: 10000 }).toBe(s1);
  return s1;
}

async function serverKnowsTab(request, uuid: string) {
  await expect.poll(async () => JSON.stringify(await (await request.get('/api/state')).json()).includes(uuid), { timeout: 15000 }).toBe(true);
}

test.describe('PERF 4.3 — 칸 포커스와 원격 명령의 실행자', () => {
  test('PF-4.3-1: 칸 [1] 포커스 — newTab·newWindow 가 한 번 실행되고 결과를 돌려준다', async ({ browser, request }) => {
    const A = await newClient(browser);
    const s1 = await focusSlot1(A.page, request);

    const rt = await cmd(request, 'newTab', { keepFocus: true });
    const jt = await rt.json();
    expect(jt.timedOut, '칸 [1] 에 지명된 newTab 이 버려졌다').toBeFalsy();
    expect(jt.newTabs?.[0]).toBeTruthy();
    expect(await lastNamed(A.page), '서버가 칸 [1] 을 지명하지 않았다 — 시험 전제가 깨졌다').toBe(s1);

    const rw = await cmd(request, 'newWindow', { keepFocus: true });
    const jw = await rw.json();
    expect(jw.timedOut, '칸 [1] 에 지명된 newWindow 가 버려졌다').toBeFalsy();
    expect(jw.newWindows?.[0]).toBeTruthy();

    expect(await execOf(A.page, 'newTab'), '같은 창에서 newTab 을 두 번 실행했다').toBe(1);
    expect(await execOf(A.page, 'newWindow')).toBe(1);
    await A.ctx.close();
  });

  for (const [name, extra] of [['--force', {}], ['--background', { keepTool: true }]] as const) {
    test(`PF-4.3-2: 칸 [1] 포커스 — closeTab ${name} 가 탭을 닫는다`, async ({ browser, request }) => {
      const A = await newClient(browser);
      await focusSlot1(A.page, request);
      // 닫을 탭은 브라우저에서 만든다 — 원격 newTab 의 고침과 상관없이 닫기만 잰다.
      const victim: string = await A.page.evaluate(async () => {
        const a = (window as any).app;
        const t = await a.layout.tabAdd.addTab(a.focused, 'terminal', { keepFocus: true });
        return t && t.uuid;
      });
      expect(victim).toBeTruthy();
      await serverKnowsTab(request, victim);

      const r = await cmd(request, 'closeTab', { location: victim, force: true, ...extra });
      expect(r.ok(), `close 응답 ${r.status()} ${await r.text()}`).toBeTruthy();
      await expect.poll(async () => (await tabUuids(A.page)).includes(victim), { timeout: 10000 }).toBe(false);
      expect(await execOf(A.page, 'closeTab')).toBe(1);
      await A.ctx.close();
    });
  }

  test('PF-4.3-3: 칸 [0] 포커스 회귀 — newTab 이 칸 [0] 지명으로 실행된다', async ({ browser, request }) => {
    const A = await newClient(browser);
    await focusSlot1(A.page, request);
    const w4 = await mkBgWindow(A.page);
    await A.page.evaluate(() => (window as any).app.slot.ops.slotFocusTo(0));
    await A.page.evaluate((id) => (window as any).app.slot.ops.slotOpen(0, id), w4);
    const me = await A.page.evaluate(() => (window as any).app.clientId);
    await expect.poll(async () => (await owners(request))[w4], { timeout: 10000 }).toBe(me);

    const jt = await (await cmd(request, 'newTab', { keepFocus: true })).json();
    expect(jt.timedOut).toBeFalsy();
    expect(jt.newTabs?.[0]).toBeTruthy();
    expect(await lastNamed(A.page)).toBe(me);
    expect(await execOf(A.page, 'newTab')).toBe(1);
    await A.ctx.close();
  });

  test('PF-4.3-4: 기기 둘 — 가장 최근에 주장한 기기만 실행한다 (FR-SXE-4)', async ({ browser, request }) => {
    const A = await newClient(browser);
    const B = await newClient(browser);
    await focusSlot1(A.page, request);

    // B 가 나중에 주장한다 — 자기 창을 새로 잡아 소유를 바꾼다.
    const wb = await mkBgWindow(B.page);
    await B.page.evaluate((id) => (window as any).app.layout.switchWindow(id), wb);
    const bId = await B.page.evaluate(() => (window as any).app.clientId);
    await expect.poll(async () => (await owners(request))[wb], { timeout: 10000 }).toBe(bId);

    const j1 = await (await cmd(request, 'newTab', { keepFocus: true })).json();
    expect(j1.newTabs?.[0]).toBeTruthy();
    expect(await execOf(B.page, 'newTab')).toBe(1);
    expect(await execOf(A.page, 'newTab'), '지명되지 않은 기기(A)가 실행했다').toBe(0);

    // A 의 칸 [1] 이 다시 주장하면 A 가 실행자다.
    const wa = await mkBgWindow(A.page);
    await A.page.evaluate((id) => (window as any).app.slot.ops.slotOpen(1, id), wa);
    const s1 = (await slotIds(A.page))[1];
    await expect.poll(async () => (await owners(request))[wa], { timeout: 10000 }).toBe(s1);

    const j2 = await (await cmd(request, 'newTab', { keepFocus: true })).json();
    expect(j2.newTabs?.[0]).toBeTruthy();
    expect(await execOf(A.page, 'newTab')).toBe(1);
    expect(await execOf(B.page, 'newTab'), '지명되지 않은 기기(B)가 실행했다').toBe(1);

    await A.ctx.close();
    await B.ctx.close();
  });
});
