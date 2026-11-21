import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * REFACTOR3_FE_FIX_SRS — 리팩토링 3차 마무리에서 사용자가 고친다고 정한 다섯.
 */

const reportAct = (page: Page, toolId: string, state: string) => page.evaluate(
  (a) => (window as any).app.testing.onToolActivity({ ...a, tool: 'Edit', detail: 'x', updatedAt: Date.now() }),
  { toolId, state },
);
const quietActivity = (page: Page) => page.route('**/api/tools/activity', (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify({ activities: [], limits: [] }) }));

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── FX-1 (P8-2) 작업 중을 이름으로 말한다 ─────────────────────────────

test.describe('FX-1 작업 중의 툴팁·접근 이름', () => {
  test('TC-FFX-2: 작업 중인 탭과 그 창 행의 title·aria-label 이 working 을 말하고, 끝나면·주의가 있으면 걷힌다', async ({ page }) => {
    await waitForInit(page);
    await quietActivity(page);
    const tab = page.locator('#area .pn.focused .pn-tab.active');
    const id = (await tab.getAttribute('data-toolid'))!;
    const sid: string = await page.evaluate(() => (window as any).app.ws.activeWindow);
    const row = page.locator(`#sidebar .sbl-item[data-sid="${sid}"]`);
    const name = (await tab.locator('.pn-tab-label').textContent())!;
    const rowName = (await row.locator('.sbl-name').textContent())!;
    await expect(tab).not.toHaveAttribute('aria-label');
    const title0 = (await tab.getAttribute('title'))!;

    await reportAct(page, id, 'working');
    await expect(tab).toHaveAttribute('aria-label', `${name} — working`);
    expect((await tab.getAttribute('title'))!.split('\n')[0]).toBe(`${title0.split('\n')[0]} — working`);
    await expect(row).toHaveAttribute('aria-label', new RegExp(`^${reEsc(rowName)}.* — working$`));
    await expect(row).toHaveAttribute('title', new RegExp(' — working'));

    await page.evaluate((t) => (window as any).app.testing.onToolAttention({ toolId: t, reason: 'done' }), id);
    await expect(tab).not.toHaveAttribute('aria-label');
    await expect(row).not.toHaveAttribute('aria-label');
    await page.evaluate((t) => (window as any).app.testing.attnClear(t), id);
    await expect(tab).toHaveAttribute('aria-label', `${name} — working`);

    await reportAct(page, id, 'done');
    await expect(tab).not.toHaveAttribute('aria-label');
    await expect(tab).toHaveAttribute('title', title0);
    await expect(row).not.toHaveAttribute('aria-label');
    await expect(row).not.toHaveAttribute('title', / — working/);
  });

  test('TC-FFX-3: Agents 탭의 이름이 작업 중인 수를 말한다', async ({ page }) => {
    await waitForInit(page);
    await quietActivity(page);
    const pid1 = (await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid'))!;
    const before = await page.locator('#area .pn.focused .pn-tab').count();
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(before + 1, { timeout: 10000 });
    const pid2 = (await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid'))!;
    await page.evaluate(() => (window as any).app.actPanelOpen());
    const agTab = page.locator('#agents-panel .ag-tab[data-sec="agents"]');
    const tip0 = (await agTab.getAttribute('title'))!;
    await reportAct(page, pid1, 'working');
    await reportAct(page, pid2, 'working');
    await expect(agTab).toHaveAttribute('title', 'Show running agents — 2 working');
    await expect(agTab).toHaveAttribute('aria-label', 'Show running agents — 2 working');
    await reportAct(page, pid2, 'done');
    await expect(agTab).toHaveAttribute('aria-label', 'Show running agents — 1 working');
    await reportAct(page, pid1, 'idle');
    await expect(agTab).toHaveAttribute('title', tip0);
    await expect(agTab).not.toHaveAttribute('aria-label');
  });
});
