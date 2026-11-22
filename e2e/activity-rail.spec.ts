import { Page } from '@playwright/test';

import { test, expect, keepToolBusy, waitForInit } from './fixtures';

/**
 * UX_BATCH12_SRS FR-ACF — Activity 패널은 데스크톱에서 닫히지 않고 레일로 접힌다.
 *
 *   TC-ACF-1  첫 화면은 레일, 상단바 단추 없음, 단축키로 오감, 레일의 카드는 이름만
 *   TC-ACF-2  레일의 구역 머리 → 레일인 채로 그 구역을 접고 편다 / 머리의 접기 단추 → 레일
 *   TC-ACF-4  레일·펼침이 저장 레이아웃을 따라 새 탭으로 간다
 */
const panel = (page: Page) => page.locator('#agents-panel');
const width = (page: Page) =>
  page.evaluate(() => Math.round(document.getElementById('agents-panel')!.getBoundingClientRect().width));
const railW = (page: Page) =>
  page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-rail-w'))));

async function setActivity(page: Page, toolId: string, state: string, tool: string, detail: string) {
  return page.evaluate(async (a) => {
    const r = await fetch('/api/tools/activity/set', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a),
    });
    return r.status;
  }, { toolId, state, tool, detail });
}

test.describe('FR-ACF Activity 레일', () => {
  test('TC-ACF-1: 첫 화면은 레일이고 단축키가 펼침과 레일을 오간다. 레일의 카드는 이름만 보인다', async ({ page }) => {
    await waitForInit(page);
    await expect(page.locator('#agents-toggle')).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).not.toHaveClass(/\bopen\b/);
    expect(await width(page)).toBe(await railW(page));
    await expect(page.locator('#agents-handle')).toBeVisible();

    const pid = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
    // `working` 은 전경이 빈 도구에서 다음 스냅샷이 지운다 (FR-AAP-20) — 에이전트 자리를 채운다.
    await keepToolBusy(page, pid);
    expect(await setActivity(page, pid!, 'working', 'Bash', 'npm test')).toBe(200);
    const card = panel(page).locator('.ag-card');
    await expect(card).toHaveCount(1, { timeout: 10000 });
    // 주기의 회차를 지금 부른다 — 카드는 다음 스냅샷에도 남아야 한다.
    await page.evaluate(() => (window as any).app.testing.activityRestore());
    await expect(card).toHaveCount(1);
    await expect(card.locator('.ag-loc')).toBeVisible();
    await expect(card.locator('.ag-state')).toBeHidden();
    await expect(card.locator('.ag-detail')).toBeHidden();
    await expect(panel(page).locator('.ag-tab[data-sec="agents"] .ag-tab-icon')).toBeVisible();
    await expect(panel(page).locator('.ag-tab[data-sec="agents"] .ag-tab-name')).toBeHidden();
    await expect(panel(page).locator('.ag-title')).toBeHidden();

    await page.keyboard.press('Control+Shift+KeyA');
    await expect(panel(page)).toHaveClass(/\bopen\b/);
    expect(await width(page)).toBeGreaterThan(await railW(page));
    await expect(card.locator('.ag-state')).toBeVisible();

    await page.keyboard.press('Control+Shift+KeyA');
    await expect(panel(page)).not.toHaveClass(/\bopen\b/);
    await expect(panel(page)).toBeVisible();
    expect(await width(page)).toBe(await railW(page));
  });

  // PEER_CHAT_SRS FR-PCH-82 로 개정: 레일의 탭 아이콘은 레일인 채로 탭만 바꾼다.
  test('TC-ACF-2: 레일의 탭 아이콘은 레일인 채로 탭을 바꾸고, 머리의 접기 단추는 레일로 접는다', async ({ page }) => {
    await waitForInit(page);
    const runs = panel(page).locator('.ag-tab[data-sec="runs"]');
    const agents = panel(page).locator('.ag-tab[data-sec="agents"]');
    await expect(runs).not.toHaveClass(/\bactive\b/);
    await runs.click();
    await expect(runs).toHaveClass(/\bactive\b/);
    await expect(panel(page)).not.toHaveClass(/\bopen\b/);
    expect(await width(page)).toBe(await railW(page));
    await agents.click();
    await expect(agents).toHaveClass(/\bactive\b/);
    await expect(panel(page)).not.toHaveClass(/\bopen\b/);

    await page.keyboard.press('Control+Shift+KeyA');
    await expect(panel(page)).toHaveClass(/\bopen\b/);

    const collapse = panel(page).locator('.ag-collapse');
    await expect(collapse).toHaveAttribute('title', 'Collapse the panel');
    await collapse.click();
    await expect(panel(page)).not.toHaveClass(/\bopen\b/);
    await expect(panel(page)).toBeVisible();
    await expect(collapse).toHaveAttribute('title', 'Expand the panel');
    await collapse.click();
    await expect(panel(page)).toHaveClass(/\bopen\b/);
  });

  test('TC-ACF-4: 레일로 저장하면 새 탭이 레일로, 펼침으로 저장하면 펼침으로 선다', async ({ page, context }) => {
    await waitForInit(page);
    expect(await page.evaluate(() => (window as any).app.testing.saveLayout())).toBe(true);
    const a = await context.newPage();
    await waitForInit(a);
    await expect(a.locator('#agents-panel')).toBeVisible();
    await expect(a.locator('#agents-panel')).not.toHaveClass(/\bopen\b/);
    await a.close();

    await page.keyboard.press('Control+Shift+KeyA');
    await expect(panel(page)).toHaveClass(/\bopen\b/);
    expect(await page.evaluate(() => (window as any).app.testing.saveLayout())).toBe(true);
    const b = await context.newPage();
    await waitForInit(b);
    await expect(b.locator('#agents-panel')).toHaveClass(/\bopen\b/);
  });
});
