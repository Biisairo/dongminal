import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled } from './fixtures';

// RELOAD_CONTINUITY_SRS §5 — TC-RLC-5~9 (묶음 Q, 돌아갈 자리의 기억).
//
// 묶음 P(자동 새로고침)는 version-autoreload.spec.ts 가 잰다 — 그쪽은 문서를
// 다시 여는 것이 검증 대상이라 페이지를 살려 둘 수 없다.

const activeWindowOf = (page: Page) => page.evaluate(() => (window as any).app.ws.activeWindow);
const plainIds = (page: Page) =>
  page.evaluate(() => (window as any).app._plainWindows().map((w: any) => w.id));

const addWindow = (page: Page) =>
  page.evaluate(async () => {
    const r = await (window as any).app._mkWindow();
    (window as any).app.render();
    return r.win;
  });

const setTab = (page: Page, id: string) =>
  page.evaluate((t) => (window as any).app._sbSetTab(t), id);
const tabOf = (page: Page) => page.evaluate(() => (window as any).app._sbTab);

// 새로고침. 같은 브라우저 탭이므로 sessionStorage 는 살아남는다 — 그것이
// 이 검증의 전제다 (SRS §2.3).
//
// 터미널이 아니라 **앱과 사이드바 탭**이 설 때까지 기다린다. 새로고침 직후의
// 활성 창이 Editor 창일 수 있고 (보관된 `sidebarTab` 이 그것이므로) 그 창에는
// pane 이 없다 (FR-EDT-55) — 터미널을 기다리면 영영 오지 않는다.
async function reload(page: Page) {
  // FR-EQS-7: 화면이 만든 창·기억이 서버에 닿기 전에 새로고침하면 복원할 것이
  // 없다 (E2E_QUIESCENCE_SRS §2.2).
  await waitSettled(page);
  await page.reload();
  await page.waitForFunction(
    () => !!(window as any).app && !!(window as any).app._sbTab && !!(window as any).app.ws.activeWindow,
    undefined, { timeout: 15000 });
}

test.describe('묶음 Q — 사이드바가 돌아갈 자리의 기억', () => {
  test('TC-RLC-6 (FR-RLC-6·8): 새로고침 뒤 Windows 탭이 보던 창으로 돌아간다', async ({ page }) => {
    await waitForInit(page);
    // 창 셋. 세 번째를 본다 — 접수한 시나리오 그대로다.
    await addWindow(page);
    const third = await addWindow(page);
    await page.evaluate((id) => (window as any).app.switchWindow(id), third);
    expect(await activeWindowOf(page)).toBe(third);
    const ids = await plainIds(page);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids[0], '세 번째 창이 첫 번째와 같으면 이 검증은 아무것도 재지 않는다').not.toBe(third);

    // 사이드바의 다른 탭으로 간다 — 활성 창이 그 탭의 창으로 바뀐다.
    await setTab(page, 'editor');
    expect(await tabOf(page)).toBe('editor');
    expect(await activeWindowOf(page)).not.toBe(third);

    await reload(page);

    await setTab(page, 'windows');
    expect(await activeWindowOf(page), '보던 창이 아니라 첫 창으로 갔다').toBe(third);
  });

  test('TC-RLC-7 (FR-RLC-6·8): Editor 탭도 마지막으로 보던 Editor 창으로 돌아간다', async ({ page }) => {
    await waitForInit(page);
    await setTab(page, 'editor');
    const edWin = await activeWindowOf(page);
    expect(edWin).toBeTruthy();

    await setTab(page, 'windows');
    await reload(page);
    await setTab(page, 'editor');

    expect(await activeWindowOf(page)).toBe(edWin);
  });

  test('TC-RLC-5 (FR-RLC-7): 기억은 창을 떠나는 그 자리에서 적힌다', async ({ page }) => {
    await waitForInit(page);
    const first = await activeWindowOf(page);
    const second = await addWindow(page);
    expect(second).not.toBe(first);

    // 일반 창을 떠나 Editor 탭으로 간다.
    await setTab(page, 'editor');
    const saved = await page.evaluate(() => {
      try { return sessionStorage.getItem('lastPlainWindow') } catch { return null }
    });
    expect(saved, '떠난 일반 창이 기록되지 않았다').toBe(second);
  });

  test('TC-RLC-8 (FR-RLC-8): 기억된 창이 사라졌으면 폴백으로 간다', async ({ page }) => {
    await waitForInit(page);
    const first = await activeWindowOf(page);
    const gone = await addWindow(page);
    await setTab(page, 'editor');
    // 기억은 남기고 그 창만 지운다 — 없는 창으로 돌아갈 수는 없다.
    await page.evaluate((id) => (window as any).app.delWindow(id), gone);

    await reload(page);
    await setTab(page, 'windows');

    const ids = await plainIds(page);
    expect(ids).not.toContain(gone);
    expect(await activeWindowOf(page)).toBe(first);
  });

  test('TC-RLC-9 (FR-RLC-9): 기억이 없는 첫 방문은 첫 일반 창으로 간다', async ({ page }) => {
    await waitForInit(page);
    await addWindow(page);
    await page.evaluate(() => {
      try { sessionStorage.removeItem('lastPlainWindow') } catch { /* 사생활 모드 */ }
    });
    await setTab(page, 'editor');
    await page.evaluate(() => {
      try { sessionStorage.removeItem('lastPlainWindow') } catch { /* 사생활 모드 */ }
    });
    await page.evaluate(() => { (window as any).app._lastPlainWindow = null });

    await setTab(page, 'windows');

    const ids = await plainIds(page);
    expect(await activeWindowOf(page)).toBe(ids[0]);
  });
});
