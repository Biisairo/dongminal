/**
 * WORKSPACE_SAVE_CONFLICT_SRS §4 — V-WSC-1~6.
 *
 * **V-WSC-1 이 이 작업의 전부다.** 다른 화면이 만든 창이 내 저장에 사라지던 것이
 * 접수한 409 로그의 정체였다 (그 SRS §2.5).
 *
 * 두 브라우저 컨텍스트를 쓴다. 한쪽의 SSE 를 끊어 "아직 알림이 도착하지 않은 순간"
 * 을 만든다 — 실제로 그 순간은 늘 있고, 검사가 그것을 결정론적으로 만든다.
 */
import { APIRequestContext, Browser, Page } from '@playwright/test';

import { test, expect } from './fixtures';

async function openScreen(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await p.goto('/');
  await p.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 20000 });
  return p;
}

// 일반 창만 센다 — Git 창·Editor 창은 늘 있으므로 그것까지 세면 수가 흔들린다.
const PLAIN = (ws: any) =>
  (ws.windows || []).filter((w: any) => w && w.type !== 'git' && w.type !== 'editor');

async function serverPlain(request: APIRequestContext): Promise<number> {
  const r = await request.get('/api/workspace');
  return PLAIN(await r.json()).length;
}

const localPlain = (p: Page) => p.evaluate(() => {
  const a = (window as any).app;
  return (a.ws.windows || []).filter((w: any) => w && w.type !== 'git' && w.type !== 'editor').length;
});

// SSE 를 끊는다 — 이 화면은 이제 남의 변경을 모른다.
async function blind(p: Page) {
  await p.evaluate(() => { try { (window as any).app._sse.close() } catch { /* 이미 없음 */ } });
  await p.waitForTimeout(300);
}

// 저장을 일으킨다. 창을 건드리지 않는 조작이어야 한다 — 이 검사가 재려는 것은
// "창을 건드리지 않은 저장이 남의 창을 지우는가" 다.
async function touchAndSave(p: Page, width: number) {
  await p.evaluate((w) => {
    const a = (window as any).app;
    a.ws.sidebarWidth = w;
    a._save();
  }, width);
}

function putCodes(p: Page): number[] {
  const codes: number[] = [];
  p.on('response', (r: any) => {
    if (r.url().includes('/api/workspace') && r.request().method() === 'PUT') codes.push(r.status());
  });
  return codes;
}

/**
 * 나가는 PUT 의 **본문**을 모은다.
 *
 * 코드만 세면 `[409]` 인지 `[409,200]` 인지밖에 알 수 없고, 그 둘의 차이는
 * FR-WSC-1 이 묻는 것이 아니다 — 묻는 것은 **포기한 그 본문이 다시 나갔는가** 다
 * (FR-WSC-13 은 채택한 원격을 싣는 새 본문이 나가는 것을 허용한다).
 */
function putBodies(p: Page): any[] {
  const out: any[] = [];
  p.on('request', (r: any) => {
    if (!r.url().includes('/api/workspace') || r.method() !== 'PUT') return;
    try { out.push(JSON.parse(r.postData() || '{}')) } catch { out.push({}) }
  });
  return out;
}

test.describe('워크스페이스 저장 충돌', () => {
  // V-WSC-1 · FR-WSC-1 — 이 작업의 전부다.
  test('다른 화면이 만든 창이 내 저장에 사라지지 않는다', async ({ browser, request }) => {
    const A = await openScreen(browser);
    const B = await openScreen(browser);
    const before = await serverPlain(request);

    await blind(B);
    await A.evaluate(() => (window as any).app.addWindow());
    await expect.poll(() => serverPlain(request), { timeout: 15000 }).toBe(before + 1);

    const codes = putCodes(B);
    await touchAndSave(B, 249);
    // 409 가 실제로 났는지 확인한다 — 나지 않았으면 이 검사는 아무것도 재지 않는다.
    await expect.poll(() => codes.length, { timeout: 15000 }).toBeGreaterThan(0);
    expect(codes[0], `첫 PUT 이 409 가 아니다: ${JSON.stringify(codes)}`).toBe(409);

    // **A 의 창이 살아 있다.**
    await expect.poll(() => serverPlain(request), { timeout: 15000 }).toBe(before + 1);

    await A.context().close();
    await B.context().close();
  });

  /**
   * V-WBR-30 (WORKBENCH_REVIEW_SRS FR-WBR-30) — 충돌 재시도가 메모장을 지우지
   * 않는다.
   *
   * 409 뒤 이 화면은 서버의 `editors` 를 통째로 채택한다. 그 자리가
   * `_edApplyServer({home,list})` 를 직접 불렀고 — **`notes` 가 빠져 있었다.**
   * `_edApplyServer` 는 준 것 전부를 반영하므로 없는 필드는 지워지고(FR-NOT-11),
   * 메모 루트가 `_edRoots()` 에서 빠지면 재조정이 **메모장 창을 삭제한다.**
   * 사용자가 접수한 "editor 에서 메모장이 안 보이는 경우가 있음" 이 이것이다.
   */
  test('V-WBR-30: 충돌 재시도를 거쳐도 메모장 행과 창이 남는다', async ({ browser, request }) => {
    const A = await openScreen(browser);
    const B = await openScreen(browser);
    const before = await serverPlain(request);

    const notes = await B.evaluate(() => (window as any).app._editors?.notes as string);
    expect(notes, '메모 루트가 없다 — 이 검사가 성립하지 않는다').toBeTruthy();

    await blind(B);
    await A.evaluate(() => (window as any).app.addWindow());
    await expect.poll(() => serverPlain(request), { timeout: 15000 }).toBe(before + 1);

    const codes = putCodes(B);
    await touchAndSave(B, 251);
    await expect.poll(() => codes.length, { timeout: 15000 }).toBeGreaterThan(0);
    expect(codes[0], `첫 PUT 이 409 가 아니다: ${JSON.stringify(codes)}`).toBe(409);

    // 채택이 끝나기를 기다린 뒤 본다.
    await B.waitForFunction(
      () => !(window as any).app._wsApplyInflight, undefined, { timeout: 15000 });

    expect(await B.evaluate(() => (window as any).app._editors?.notes as string),
      '충돌 재시도가 메모 루트를 지웠다').toBe(notes);
    expect(await B.evaluate((r) =>
      (window as any).app._edWindows().some((w: any) => w.editor && w.editor.root === r), notes),
      '메모장 창이 사라졌다').toBe(true);

    await A.context().close();
    await B.context().close();
  });

  // V-WSC-3 · FR-WSC-1: 같은 본문을 다시 밀어붙이지 않는다 — 그것이 손실의 방법이었다.
  //
  // **PUT 이 하나뿐인지를 재지 않는다.** 409 를 채택하면 그 채택 자체가 저장을
  // 부를 수 있고(Editor 창 재조정의 되쓰기 FR-EDT-42, 원격이 본 적 없는 창의
  // 저장 FR-WSC-13), 그 PUT 은 **채택한 원격을 싣는 새 본문**이다. 손실의 방법은
  // PUT 이 두 번 나가는 것이 아니라 **포기한 본문이 다시 나가는 것**이었다.
  test('409 뒤에 같은 본문을 다시 PUT 하지 않는다', async ({ browser, request }) => {
    const A = await openScreen(browser);
    const B = await openScreen(browser);
    const before = await serverPlain(request);

    await blind(B);
    // `addWindow()` 는 id 를 돌려주지 않는다 — 그 안의 `_mkWindow` 가 만든 엔터티
    // id 가 필요하므로 같은 경로를 직접 탄다 (app-layout.js, FR-RCR-6/7).
    const newWin: string = await A.evaluate(async () => {
      const a = (window as any).app;
      const r = await a._mkWindow({});
      a.render();
      return r.win;
    });
    await expect.poll(() => serverPlain(request), { timeout: 15000 }).toBe(before + 1);

    const codes = putCodes(B);
    const bodies = putBodies(B);
    // 이 폭이 포기할 본문의 표식이다 — 다시 나가면 그것이 재시도다 (FR-WSC-5).
    await touchAndSave(B, 251);
    await expect.poll(() => codes.length, { timeout: 15000 }).toBeGreaterThan(0);
    await B.waitForTimeout(2000);

    expect(codes[0], `첫 PUT 이 409 가 아니다: ${JSON.stringify(codes)}`).toBe(409);
    const after = bodies.slice(1);
    expect(after.filter((b) => b.sidebarWidth === 251),
      '포기한 본문이 다시 나갔다').toEqual([]);
    // 뒤따르는 저장이 있었다면 그것은 **채택한 원격**이다 — A 의 창을 싣는다.
    for (const b of after) {
      expect((b.windows || []).map((w: any) => w.id),
        '채택 뒤의 저장이 A 의 창을 지웠다').toContain(newWin);
    }
    // 그리고 A 의 창은 서버에 그대로 있다 (V-WSC-1 과 같은 불변식).
    await expect.poll(() => serverPlain(request), { timeout: 15000 }).toBe(before + 1);

    await A.context().close();
    await B.context().close();
  });

  // V-WSC-2 · FR-WSC-2·11: 409 를 만난 화면이 원격을 채택한다 — 그 창을 알게 되고,
  // 다음 저장이 곧바로 또 409 가 되지 않는다.
  test('409 뒤 원격을 채택해 그 창을 알게 되고 다음 저장이 통과한다', async ({ browser, request }) => {
    const A = await openScreen(browser);
    const B = await openScreen(browser);
    const before = await serverPlain(request);

    await blind(B);
    await A.evaluate(() => (window as any).app.addWindow());
    await expect.poll(() => serverPlain(request), { timeout: 15000 }).toBe(before + 1);
    expect(await localPlain(B), 'B 가 미리 알고 있으면 이 검사의 전제가 없다').toBe(before);

    const codes = putCodes(B);
    await touchAndSave(B, 253);
    // 채택이 일어나면 B 도 그 창을 안다.
    await expect.poll(() => localPlain(B), { timeout: 15000 }).toBe(before + 1);

    // 그리고 다음 저장은 통과한다 — ETag 가 원격의 것이 됐다.
    await touchAndSave(B, 255);
    await expect.poll(() => codes.filter((c) => c === 200).length, { timeout: 15000 })
      .toBeGreaterThan(0);
    // 그 저장도 A 의 창을 지우지 않는다.
    await expect.poll(() => serverPlain(request), { timeout: 15000 }).toBe(before + 1);

    await A.context().close();
    await B.context().close();
  });

  // V-WSC-4: 성공한 저장은 종전대로다 — 고치면서 그것을 깨뜨리지 않았음을 잰다.
  //
  // 창을 **닫아** 재지 않는 이유는 `delWindow` 가 실행 중인 프로세스에 확인 대화를
  // 띄우기 때문이다 (FR-BG-4). 이 검사가 재려는 것은 저장 경로이지 그 대화가 아니다.
  test('충돌이 없으면 저장이 종전대로 동작한다', async ({ browser, request }) => {
    const A = await openScreen(browser);
    const before = await serverPlain(request);
    const codes = putCodes(A);

    await A.evaluate(() => (window as any).app.addWindow());
    await expect.poll(() => serverPlain(request), { timeout: 15000 }).toBe(before + 1);

    // 창을 건드리지 않는 저장도 통과하고, 그 값이 서버에 남는다.
    await touchAndSave(A, 241);
    await expect.poll(async () => {
      const r = await request.get('/api/workspace');
      return (await r.json()).sidebarWidth;
    }, { timeout: 15000 }).toBe(241);

    // 409 는 하나도 나지 않았다 — 화면이 하나이므로 충돌할 상대가 없다.
    expect(codes.filter((c) => c === 409), `충돌이 없어야 한다: ${JSON.stringify(codes)}`)
      .toHaveLength(0);
    // 그리고 그 창은 그대로 있다.
    expect(await serverPlain(request)).toBe(before + 1);

    await A.context().close();
  });

  // V-WSC-5 · FR-WSC-8: 연속 충돌이 상한을 넘으면 그 사실이 남는다. 조용히
  // 되풀이하면 아무도 그것이 일어나는지 모른다 — 접수한 로그가 그 증거였다.
  test('연속 충돌이 상한을 넘으면 기록이 남는다', async ({ browser, request }) => {
    const B = await openScreen(browser);
    const warns: string[] = [];
    B.on('console', (m: any) => { if (m.type() === 'warning') warns.push(m.text()) });

    await blind(B);
    // 서버 rev 를 계속 앞질러 올린다 — B 의 ETag 는 매번 낡는다.
    for (let i = 0; i < 8; i++) {
      const r = await request.get('/api/workspace');
      const rev = r.headers()['etag'] || '0';
      const ws = await r.json();
      ws.sidebarWidth = 200 + i;
      await request.put('/api/workspace', {
        headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
        data: JSON.stringify(ws),
      });
      await touchAndSave(B, 300 + i);
      await B.waitForTimeout(150);
    }
    await B.waitForTimeout(1500);

    expect(warns.some((w) => w.includes('workspace')),
      `충돌 기록이 없다: ${JSON.stringify(warns.slice(0, 5))}`).toBe(true);

    await B.context().close();
  });

  // V-WSC-6 · FR-WSC-9: 백오프가 저장을 잃지 않는다 — 미룬 뒤에도 나간다.
  test('백오프 뒤에도 대기 중인 저장이 나간다', async ({ browser, request }) => {
    const B = await openScreen(browser);
    const codes = putCodes(B);

    // 한 번 충돌시켜 백오프를 세운다.
    await blind(B);
    const r = await request.get('/api/workspace');
    const rev = r.headers()['etag'] || '0';
    const ws = await r.json();
    ws.sidebarWidth = 199;
    await request.put('/api/workspace', {
      headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
      data: JSON.stringify(ws),
    });
    await touchAndSave(B, 260);
    await expect.poll(() => codes.length, { timeout: 15000 }).toBeGreaterThan(0);

    // 그 뒤의 저장은 (미뤄지더라도) 반드시 나간다.
    await touchAndSave(B, 262);
    await expect.poll(() => codes.filter((c) => c === 200).length, { timeout: 20000 })
      .toBeGreaterThan(0);

    await B.context().close();
  });
});
