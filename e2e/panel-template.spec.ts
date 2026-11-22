// PANEL_TEMPLATE_SRS — 메인 패널과 Activity 가 같은 패널 템플릿을 쓴다 (TC-PNT-*)
import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

const MOBILE = { width: 412, height: 839 };

const box = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
});

const style = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
  const cs = getComputedStyle(el);
  return { bg: cs.backgroundColor, fs: cs.fontSize, fw: cs.fontWeight, h: el.getBoundingClientRect().height };
});

test.describe('데스크톱 — 같은 머리 (FR-PNT-1~8)', () => {
  test('TC-PNT-1·3: 두 머리는 상단바 선에 맞고, Activity 머리는 탭 줄 + 끝 단추 한 줄이다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.agents.list.actPanelOpen());
    await expect(page.locator('#agents-panel')).toHaveClass(/open/);
    const top = await box(page, '#topbar');
    const sb = await box(page, '#sidebar > .ui-panel-head');
    const ag = await box(page, '#agents-panel > .ui-panel-head');
    expect(Math.abs(sb.bottom - top.bottom)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(ag.bottom - top.bottom)).toBeLessThanOrEqual(0.5);
    expect(sb.top).toBe(0);
    expect(ag.top).toBe(0);

    await expect(page.locator('#agents-panel .ag-title')).toHaveCount(0);
    expect(await page.evaluate(() => !!document.querySelector('#agents-body .ui-panel-head, #agents-body .ag-tabs'))).toBe(false);
    const head = page.locator('#agents-panel > .ui-panel-head');
    await expect(head.locator('> .ui-panel-tabs.ag-tabs')).toHaveCount(1);
    // UX_AUDIT_FIX_SRS FR-UXF-27 로 개정: 이전 머리 동작부에 .ag-refresh 하나 / 지금 없다 / 이유 목록은 자동 갱신만 한다.
    await expect(head.locator('.ag-refresh')).toHaveCount(0);
    await expect(head.locator('> .ui-panel-acts .ag-collapse')).toHaveCount(1);
    const acts = await box(page, '#agents-panel > .ui-panel-head > .ui-panel-acts');
    const panel = await box(page, '#agents-panel');
    expect(Math.abs(acts.left + acts.width - (panel.left + panel.width))).toBeLessThanOrEqual(1);
  });

  test('TC-PNT-2: 두 패널의 탭은 높이·바탕·글자·활성 표식이 같다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.agents.list.actPanelOpen());
    const a = await style(page, '#sb-tabs .ui-panel-tab:not(.active)');
    const b = await style(page, '#agents-panel .ui-panel-tab:not(.active)');
    expect(b).toEqual(a);
    const aa = await style(page, '#sb-tabs .ui-panel-tab.active');
    const ba = await style(page, '#agents-panel .ui-panel-tab.active');
    expect(ba).toEqual(aa);
    const tabsBg = await page.evaluate(() => [
      getComputedStyle(document.querySelector('#sb-tabs')!).backgroundColor,
      getComputedStyle(document.querySelector('#agents-panel .ui-panel-tabs')!).backgroundColor,
    ]);
    expect(tabsBg[1]).toBe(tabsBg[0]);
  });

  test('TC-PNT-4: 두 레일의 첫 탭이 같은 선에 선다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      const a = (window as any).app;
      a.testing.setSidebarCollapsed(true);
      a.agents.setAgentsPanelOpen(false);
    });
    await expect(page.locator('#agents-panel')).not.toHaveClass(/open/);
    await expect.poll(async () => (await box(page, '#sidebar')).width).toBe(40);
    const sb = await box(page, '#sb-tabs .ui-panel-tab');
    const ag = await box(page, '#agents-panel .ui-panel-tab');
    expect(Math.abs(sb.top - ag.top)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(sb.height - ag.height)).toBeLessThanOrEqual(0.5);
  });
});

test.describe('모바일 — 같은 시트 (FR-PNT-10~14)', () => {
  const mobile = (page: Page) => waitForInit(page, { mode: 'mobile', viewport: MOBILE });

  test('TC-PNT-5: 서랍은 왼쪽에서, Activity 는 오른쪽에서 미끄러져 화면 전체를 덮는다', async ({ page }) => {
    await mobile(page);
    // 전환 중의 자리를 잰다 — 전환이 있다는 것이 재는 대상이다.
    const mid = (sel: string, open: string) => page.evaluate(([s, o]) => new Promise<number>((res) => {
      (document.getElementById(o) as HTMLElement).click();
      requestAnimationFrame(() => requestAnimationFrame(() => res(document.querySelector(s)!.getBoundingClientRect().left)));
    }), [sel, open]);

    const dMid = await mid('#sidebar', 'm-drawer-toggle');
    expect(dMid).toBeLessThan(0);
    await expect.poll(async () => (await box(page, '#sidebar')).left).toBe(0);
    const d = await box(page, '#sidebar');
    expect(d.width).toBe(MOBILE.width);
    expect(d.height).toBe(MOBILE.height);
    await page.keyboard.press('Escape');
    await expect(page.locator('#sidebar')).toBeHidden();

    const aMid = await mid('#agents-panel', 'm-act-btn');
    expect(aMid).toBeGreaterThan(0);
    await expect.poll(async () => (await box(page, '#agents-panel')).left).toBe(0);
    const a = await box(page, '#agents-panel');
    expect(a.width).toBe(MOBILE.width);
    expect(a.height).toBe(MOBILE.height);
  });

  test('TC-PNT-6: 닫힌 두 시트는 보이지 않는다', async ({ page }) => {
    await mobile(page);
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(page.locator('#agents-panel')).toBeHidden();
  });

  test('TC-PNT-7: 두 시트의 머리와 탭 높이가 같다', async ({ page }) => {
    await mobile(page);
    await page.locator('#m-drawer-toggle').click();
    await expect.poll(async () => (await box(page, '#sidebar')).left).toBe(0);
    const touch = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--touch-min')));
    const sbHead = await box(page, '#sidebar > .ui-panel-head');
    const sbTab = await box(page, '#sb-tabs .ui-panel-tab');
    await page.keyboard.press('Escape');
    await page.locator('#m-act-btn').click();
    await expect.poll(async () => (await box(page, '#agents-panel')).left).toBe(0);
    const agHead = await box(page, '#agents-panel > .ui-panel-head');
    const agTab = await box(page, '#agents-panel .ui-panel-tab');
    expect(sbHead.height).toBe(touch);
    expect(agHead.height).toBe(sbHead.height);
    expect(agTab.height).toBe(sbTab.height);
  });

  test('TC-PNT-8: 서랍의 × 는 덮이지 않고, 누르면 닫힌다', async ({ page }) => {
    await mobile(page);
    await page.locator('#m-drawer-toggle').click();
    await expect.poll(async () => (await box(page, '#sidebar')).left).toBe(0);
    const hit = await page.evaluate(() => {
      const b = document.getElementById('drawer-close')!;
      const r = b.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!at && b.contains(at);
    });
    expect(hit).toBe(true);
    await page.locator('#drawer-close').click();
    await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
  });
});

// ── 모바일 Activity — 누른 뒤 유지·닫힘 (FR-PNT-15~17) ──

// 삭제 단추는 서버가 허락한 동작일 때 선다 (SERVER_DRIVEN_ACTIONS_SRS FR-SDA-61).
const RUN = { id: 'run-pnt-1', short: 'a1b2c3d', objective: 'panel template', state: 'closed', isolation: 'none',
  createdAt: Math.floor(Date.now() / 1000), members: [], actions: { 'run.delete': { ok: true } } };

async function mockRuns(page: Page) {
  await page.route('**/api/runs', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [RUN] }) }));
  await page.route('**/api/runs/*/graph', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUN) }));
}

/**
 * 지금 탭의 도구를 작업 중인 에이전트로 세운다 — 카드가 하나 그려진다. 패널을 열면 활동 목록을 서버에서 다시 받고
 * 거기 없는 활동은 지운다(FR-RSF-8) — 서버 응답에도 같은 활동을 싣는다.
 */
async function workingAgent(page: Page) {
  const id: string = await page.evaluate(() => (window as any).app.testing.focusedTerminal().id);
  const act = { toolId: id, state: 'working', tool: 'Edit', detail: 'x', updatedAt: Date.now() };
  await page.route('**/api/tools/activity', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activities: [act], limits: [] }) }));
  await page.evaluate((a) => (window as any).app.testing.onToolActivity(a), act);
  return id;
}

test.describe('모바일 Activity — 누른 뒤 (FR-PNT-15~17)', () => {
  const mobile = (page: Page) => waitForInit(page, { mode: 'mobile', viewport: MOBILE });
  const panel = (page: Page) => page.locator('#agents-panel');

  test('TC-PNT-9: 에이전트 카드를 누르면 시트가 닫히고 그 탭이 포커스다', async ({ page }) => {
    await mobile(page);
    const id = await workingAgent(page);
    await page.locator('#m-act-btn').click();
    await expect(panel(page)).toHaveClass(/open/);
    await page.locator(`#agents-panel .ag-card[data-toolid="${id}"]`).click();
    await expect(panel(page)).not.toHaveClass(/open/);
    expect(await page.evaluate(() => (window as any).app.testing.focusedTerminal().id)).toBe(id);
  });

  test('TC-PNT-10: 탭 전환·새로고침·사용량 요약은 시트를 유지한다', async ({ page }) => {
    await mobile(page);
    await page.locator('#m-act-btn').click();
    await expect(panel(page)).toHaveClass(/open/);
    await page.locator('#agents-panel .ag-tab[data-sec="runs"]').click();
    await expect(page.locator('#agents-panel .ag-tab[data-sec="runs"]')).toHaveClass(/active/);
    // UX_AUDIT_FIX_SRS FR-UXF-27 로 개정: 이전 .ag-refresh 를 눌렀다 / 지금 단추가 없고 같은 갱신 함수를 부른다
    // / 이유 단추를 없앴다. 남는 계약은 "갱신이 시트를 닫지 않는다" 다.
    await expect(page.locator('#agents-panel .ag-refresh')).toHaveCount(0);
    await page.evaluate(() => (window as any).app.testing.activityRestore());
    await expect(panel(page)).toHaveClass(/open/);
  });

  test('TC-PNT-11: Runs 행은 닫고, 삭제 확인이 열린 행을 누르면(취소) 유지한다', async ({ page }) => {
    await mockRuns(page);
    await mobile(page);
    await page.locator('#m-act-btn').click();
    await page.locator('#agents-panel .ag-tab[data-sec="runs"]').click();
    const row = page.locator(`#agents-panel .runs-row[data-runid="${RUN.id}"]`);
    await expect(row).toBeVisible({ timeout: 10000 });

    await row.locator('.runs-del').click();
    await expect(row.locator('.runs-del')).toHaveCount(0);
    await row.locator('.runs-short').click();
    await expect(panel(page)).toHaveClass(/open/);
    await expect(row.locator('.runs-del')).toHaveCount(1);

    await row.locator('.runs-short').click();
    await expect(panel(page)).not.toHaveClass(/open/);
    await expect(page.locator('#area .pn-tab.active')).toContainText(RUN.short);
  });

  test('TC-PNT-12: 데스크톱에서는 에이전트 카드를 눌러도 패널이 열린 채다', async ({ page }) => {
    await waitForInit(page);
    const id = await workingAgent(page);
    await page.evaluate(() => (window as any).app.agents.list.actPanelOpen());
    await page.locator(`#agents-panel .ag-card[data-toolid="${id}"]`).click();
    await expect(panel(page)).toHaveClass(/open/);
  });
});
