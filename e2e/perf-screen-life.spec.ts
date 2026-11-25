import { test, expect, waitForInit, selectTab } from './fixtures';

/**
 * PERF M3 3.5.1 (FR-SPA-3, D-36·D-37) — 렌더러가 탭 본문 주인의 생명주기 전이를 건다.
 *
 * 터미널은 계약(`wake`·`sleep`)을 갖는다(2.5). 첫 터미널 주인의 두 메서드를 감싸 부른 순서를 적고, 실제 탭 전환에서
 * 렌더러가 부르는 순서를 잰다. 처음 보일 때의 `wake` 는 감싸기 전에 이미 지나갔다.
 */

const ARM = `(() => {
  const a = window.app;
  const s = a.ws.windows.find(x => x.id === a.ws.activeWindow);
  const find = (n, id) => {
    if (!n) return null;
    if (n.type === 'pane' && n.id === id) return n;
    if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r }
    return null;
  };
  const pn = find(s.layout, a.focused);
  const tab = pn.tabs.find(t => t.id === a.slot.paneTab(pn));
  const p = a.tools.get(tab.toolId);
  window.__life = [];
  const wake = p.wake.bind(p), sleep = p.sleep.bind(p);
  p.wake = () => { window.__life.push('wake'); wake() };
  p.sleep = () => { window.__life.push('sleep'); sleep() };
  a.render();
  return tab.id;
})()`;

const lifeLog = (page: any) => page.evaluate(() => (window as any).__life);

test.describe('PERF 3.5.1 생명주기', () => {
  test('가려진 터미널 주인은 2초 뒤 잠들고, 다시 보이면 깬다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const firstTab = await page.evaluate(ARM);
    expect(await lifeLog(page)).toEqual([]);

    await page.evaluate(() => (window as any).app.layout.tabOps.addTabFocused());
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(2);
    await expect.poll(() => lifeLog(page), { timeout: 6000 }).toEqual(['sleep']);
    const sleepers = await page.evaluate(() => (window as any).app.testing.sleepers());
    expect(sleepers.map((x: any) => x.kind)).toContain('TerminalTool');

    await selectTab(page.locator(`#area .pn.focused .pn-tab[data-tab-id="${firstTab}"]`));
    await expect.poll(() => lifeLog(page)).toEqual(['sleep', 'wake']);
    expect(await page.evaluate(() => (window as any).app.testing.sleepers().length)).toBe(0);
  });

  test('2초 안에 다시 보이면 잠들지 않는다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const firstTab = await page.evaluate(ARM);
    await page.evaluate(() => (window as any).app.layout.tabOps.addTabFocused());
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(2);
    await selectTab(page.locator(`#area .pn.focused .pn-tab[data-tab-id="${firstTab}"]`));
    // TEST-16: 재는 것이 "잠들지 않음" 이라 기다릴 신호가 없다. 지연(2초)을 넘겨도 그대로인지 본다.
    await page.waitForTimeout(3000);
    expect(await lifeLog(page)).toEqual([]);
  });
});
