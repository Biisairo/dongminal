import { Page } from '@playwright/test';

import { test, expect, gotoSettled } from './fixtures';

// UX_BATCH12_SRS FR-FHL-8 (R17) — 에이전트 카드 하이라이트는 포커스 탭 하나를 따른다 (TC-FHL-4).

/** 포커스 pane 에 탭 셋(A·B 는 에이전트, C 는 아님)을 두고 패널을 연다. */
async function setup(page: Page) {
  await gotoSettled(page);
  return page.evaluate(async () => {
    const app = (window as any).app;
    const rid = app.focused;
    await app.addTab(rid, 'terminal', { name: 'B' });
    await app.addTab(rid, 'terminal', { name: 'C' });
    const pn = app.testing.flattenPanes(app.testing.aw().layout).find((p: any) => p.id === rid);
    const [a, b, c] = pn.tabs.slice(-3);
    if (!document.getElementById('agents-panel')!.classList.contains('open')) app.testing.agentsToggle();
    for (const t of [a, b]) app.testing.onToolActivity({ toolId: t.toolId, state: 'working', tool: 'Bash' });
    return { rid, a: { id: a.id, tool: a.toolId }, b: { id: b.id, tool: b.toolId }, c: { id: c.id } };
  });
}

const focusedCards = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll('#agents-panel .ag-card.focused')].map((el) => (el as HTMLElement).dataset.toolid));

test.describe('UX_BATCH12 — 에이전트 카드 하이라이트 (FR-FHL-8)', () => {
  test('TC-FHL-4a: 포커스 탭이 에이전트면 그 카드 하나, 아니면 없다', async ({ page }) => {
    const t = await setup(page);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(2, { timeout: 10000 });
    const go = (tid: string) => page.evaluate(([r, id]) => (window as any).app.switchTab(r, id), [t.rid, tid]);

    await go(t.a.id);
    await expect.poll(() => focusedCards(page)).toEqual([t.a.tool]);
    await go(t.c.id);
    await expect.poll(() => focusedCards(page)).toEqual([]);
    await go(t.b.id);
    await expect.poll(() => focusedCards(page)).toEqual([t.b.tool]);
  });

  test('TC-FHL-4b: 같은 창을 두 칸에 띄우면 포커스 칸의 카드 하나만 켜진다', async ({ page }) => {
    const t = await setup(page);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(2, { timeout: 10000 });
    await page.evaluate(([r, a, b]) => {
      const app = (window as any).app;
      app.slotAdd();             // 같은 창이 칸 1 에 선다 (FR-WSL-52)
      app.slotFocusTo(0); app.switchTab(r, b);   // 칸 0 은 B
      app.slotFocusTo(1); app.switchTab(r, a);   // 칸 1 은 A
    }, [t.rid, t.a.id, t.b.id]);
    // 칸을 더하는 동안 활동 목록을 다시 받아 서버에 없는 가짜 활동이 지워진다 (FR-RSF-3) — 다시 넣는다.
    await page.evaluate((ids) => {
      for (const id of ids) (window as any).app.testing.onToolActivity({ toolId: id, state: 'working', tool: 'Bash' });
    }, [t.a.tool, t.b.tool]);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(2, { timeout: 10000 });
    const tabs = () => page.evaluate((r) => {
      const app = (window as any).app; const pn = app.testing.flattenPanes(app.testing.aw().layout).find((p: any) => p.id === r);
      return [app.paneTab(pn, 0), app.paneTab(pn, 1)];
    }, t.rid);
    expect(await tabs(), '칸마다 다른 탭이 서야 이 검증이 성립한다').toEqual([t.b.id, t.a.id]);
    await expect.poll(() => focusedCards(page)).toEqual([t.a.tool]);
    await page.evaluate(() => (window as any).app.slotFocusTo(0));
    await expect.poll(() => focusedCards(page)).toEqual([t.b.tool]);
  });
});
