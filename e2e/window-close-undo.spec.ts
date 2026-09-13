import { Page, APIRequestContext } from '@playwright/test';

import { test, expect, waitForInit, waitSettled, liveRegionOf } from './fixtures';

// WINDOW_CLOSE_UNDO_SRS §5 — TC-WCU-1~7 (M7 `UX-2`).
//
// **재는 것은 "토스트가 떴다" 가 아니라 "도구가 살아 있다가, 되돌리면 돌아오고,
// 만료하면 죽는다" 다.** 생사는 서버(`/api/state` 의 `tools`)가 답한다 — 화면의
// 목록만 보면 창이 사라진 것과 세션이 죽은 것을 가르지 못한다.

const TOAST = '#win-undo';

/** 창 하나의 도구 id 전부 (레이아웃 순회). */
const toolsOf = (page: Page, sid: string) => page.evaluate((id) => {
  const app = (window as any).app;
  const w = app.ws.windows.find((x: any) => x.id === id);
  const out: string[] = [];
  const walk = (nd: any) => {
    if (!nd) return;
    for (const t of nd.tabs || []) if (t.toolId) out.push(t.toolId);
    for (const c of nd.children || []) walk(c);
  };
  walk(w?.layout);
  return out;
}, sid);

const windowIds = (page: Page) => page.evaluate(() =>
  ((window as any).app.ws.windows || []).map((w: any) => w.id));
// 일반(터미널) 창만 — Repo 창의 탭에는 도구가 없다.
const plainIds = (page: Page) => page.evaluate(() =>
  (window as any).app.testing.plainWindows().map((w: any) => w.id));
const activeWindow = (page: Page) => page.evaluate(() => (window as any).app.ws.activeWindow);

async function alive(request: APIRequestContext, id: string): Promise<boolean> {
  const state = await (await request.get('/api/state')).json();
  return (state.tools || []).some((t: any) => t.id === id);
}
async function inBackground(request: APIRequestContext, id: string): Promise<boolean> {
  const bg = await (await request.get('/api/tools/background')).json();
  return (bg.background || []).some((b: any) => b.toolId === id);
}

/** 창을 둘 이상 만들고, 활성이 **아닌** 창 하나와 그 도구를 돌려준다. */
async function setup(page: Page) {
  await waitForInit(page, { clearLocalStorage: true });
  if ((await plainIds(page)).length < 2) {
    await page.evaluate(() => (window as any).app.addWindow());
    await expect.poll(() => plainIds(page).then((x) => x.length), { timeout: 10000 }).toBeGreaterThan(1);
    await waitSettled(page);
  }
  const ids = await windowIds(page);
  const active = await activeWindow(page);
  const victim = (await plainIds(page)).find((x: string) => x !== active)!;
  // 새 창의 셸은 한 박자 뒤에 선다 — 도구 id 가 붙을 때까지 기다린다.
  await expect.poll(() => toolsOf(page, victim).then((t) => t.length), { timeout: 10000 }).toBeGreaterThan(0);
  const tools = await toolsOf(page, victim);
  return { ids, active, victim, tools };
}

const closeViaX = (page: Page, sid: string) =>
  page.locator(`#windows .si[data-sid="${sid}"] .si-x`).click();

test.describe('창 닫기의 되돌리기 (FR-WCU-1~8)', () => {
  test('TC-WCU-1·2: × → 도구는 살아 백그라운드에, Undo 가 리전 안에, 누르면 같은 자리로 돌아온다', async ({ page, request }) => {
    const { ids, victim, tools } = await setup(page);
    const idx = ids.indexOf(victim);

    await closeViaX(page, victim);
    await expect(page.locator(`#windows .si[data-sid="${victim}"]`)).toHaveCount(0);
    // 창은 사라졌지만 도구는 죽지 않았다 (FR-WCU-1) — 그리고 보이는 자리에 있다 (FR-WCU-3).
    for (const t of tools) {
      expect(await alive(request, t), '닫자마자 죽였다').toBe(true);
      await expect.poll(() => inBackground(request, t), { timeout: 10000 }).toBe(true);
    }
    // FR-WCU-2: 되돌릴 수 있다는 사실이 읽힌다 — 글자가 든 요소에서 위로 올라간다.
    const text = page.locator(`${TOAST} .toast-text`);
    await expect(text).toHaveText(/.+/);
    expect(await liveRegionOf(text), 'Undo 문구가 라이브 리전 밖에 있다').not.toBeNull();

    await page.locator(`${TOAST} .toast-act`).click();
    await expect(page.locator(TOAST)).toHaveCount(0);
    // FR-WCU-7: 같은 자리 · 활성 · 백그라운드에서 빠짐 · 살아 있음.
    await expect.poll(() => windowIds(page), { timeout: 10000 }).toEqual(ids);
    expect((await windowIds(page)).indexOf(victim)).toBe(idx);
    expect(await activeWindow(page)).toBe(victim);
    for (const t of tools) {
      await expect.poll(() => inBackground(request, t), { timeout: 10000 }).toBe(false);
      expect(await alive(request, t)).toBe(true);
    }
    await expect(page.locator(`#windows .si[data-sid="${victim}"]`)).toHaveClass(/active/);
  });

  test('TC-WCU-3: 유예가 끝나면 도구가 죽는다', async ({ page, request }) => {
    const { victim, tools } = await setup(page);
    await closeViaX(page, victim);
    await expect(page.locator(TOAST)).toHaveCount(1);
    // NFR-WCU-2: 만료를 기다리되 고정 대기가 아니라 상태를 본다.
    for (const t of tools) {
      await expect.poll(() => alive(request, t), { timeout: 15000 }).toBe(false);
      expect(await inBackground(request, t)).toBe(false);
    }
    await expect(page.locator(TOAST)).toHaveCount(0);
  });

  test('TC-WCU-4: 유예 중 백그라운드에서 되살린 도구는 만료 뒤에도 산다', async ({ page, request }) => {
    const { victim, tools } = await setup(page);
    const [t] = tools;
    await closeViaX(page, victim);
    await expect.poll(() => inBackground(request, t), { timeout: 10000 }).toBe(true);
    // 백그라운드 복귀의 길로 활성 창에 되살린다 (FR-BGR).
    await page.evaluate((id) => (window as any).app.testing.restoreTool(id), t);
    await expect.poll(() => inBackground(request, t), { timeout: 10000 }).toBe(false);
    // 만료를 지나도 — 다른 창이 참조하는 도구는 죽이지 않는다 (FR-WCU-4).
    await expect(page.locator(TOAST)).toHaveCount(0, { timeout: 15000 });
    await expect.poll(() => alive(request, t)).toBe(true);
    expect(await toolsOf(page, await activeWindow(page))).toContain(t);
  });

  test('TC-WCU-5: 유예 중 다른 창을 닫으면 앞선 유예가 먼저 끝난다', async ({ page, request }) => {
    await waitForInit(page, { clearLocalStorage: true });
    // 창 셋 — 활성 하나를 남기고 둘을 차례로 닫는다.
    while ((await plainIds(page)).length < 3) {
      await page.evaluate(() => (window as any).app.addWindow());
      await waitSettled(page);
    }
    const active = await activeWindow(page);
    const [a, b] = (await plainIds(page)).filter((x: string) => x !== active);
    await expect.poll(() => toolsOf(page, a).then((t) => t.length), { timeout: 10000 }).toBeGreaterThan(0);
    const ta = await toolsOf(page, a);
    await closeViaX(page, a);
    await expect(page.locator(TOAST)).toHaveCount(1);
    await closeViaX(page, b);
    // 앞선 창의 도구는 곧 죽는다 — 5초를 기다리지 않는다 (FR-WCU-6).
    for (const t of ta) await expect.poll(() => alive(request, t), { timeout: 3000 }).toBe(false);
    // 토스트는 하나다.
    await expect(page.locator(TOAST)).toHaveCount(1);
  });

  test('TC-WCU-6: 행의 Delete 도 같은 Undo 를 받는다', async ({ page, request }) => {
    const { victim, tools } = await setup(page);
    await page.locator(`#windows .si[data-sid="${victim}"]`).focus();
    await page.keyboard.press('Delete');
    await expect(page.locator(`#windows .si[data-sid="${victim}"]`)).toHaveCount(0);
    await expect(page.locator(TOAST)).toHaveCount(1);
    for (const t of tools) expect(await alive(request, t)).toBe(true);
  });

  test('TC-WCU-7: 확인을 지난 닫기는 최종이다 — Undo 가 없다', async ({ page, request }) => {
    const { victim, tools } = await setup(page);
    // busy 판정만 바꿔친다 — 실제로 프로세스를 띄우는 것보다 결정적이다.
    await page.route('**/api/tools/*/busy', (r) => r.fulfill({ json: { busy: true } }));
    await closeViaX(page, victim);
    const ov = page.locator('.confirm-overlay');
    await expect(ov).toHaveCount(1);
    await ov.locator('.confirm-ok').click();
    await expect(page.locator(`#windows .si[data-sid="${victim}"]`)).toHaveCount(0);
    await expect(page.locator(TOAST)).toHaveCount(0);
    for (const t of tools) await expect.poll(() => alive(request, t), { timeout: 10000 }).toBe(false);
  });
});
