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

// ── FX-2 설정 행 다시 칠하기 · 포커스 가드 ─────────────────────────────

test.describe('FX-2·3 설정 — 칠하기·가드·열 때 다시 읽기', () => {
  // 설정은 서버에 산다 — 이 묶음이 바꾼 것을 다음 스펙에 흘리지 않는다.
  let original: unknown = null;
  test.beforeEach(async ({ request }) => { original = await (await request.get('/api/settings')).json(); });
  test.afterEach(async ({ request }) => { if (original) await request.put('/api/settings', { data: original }); });

  const openTab = async (page: Page, tab: string) => {
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });
    await page.click(`.mtab[data-tab="${tab}"]`);
    await expect(page.locator(`#panel-${tab}`)).toBeVisible();
  };
  /** 다른 클라이언트가 statusBar 값 하나를 뒤집는다. 뒤집은 값을 돌려준다. */
  const flipStatus = async (request: any, key: string) => {
    const blob = await (await request.get('/api/settings')).json();
    const want = !(blob.statusBar && blob.statusBar[key]);
    blob.statusBar = { ...(blob.statusBar || {}), [key]: want };
    await request.put('/api/settings', { data: blob });
    return want;
  };

  test('TC-FFX-5: statusbar 스위치는 다른 클라이언트의 변경을 따라오고, 닫힌 동안 바뀐 값도 다시 열면 보인다', async ({ page, request }) => {
    await waitForInit(page);
    await openTab(page, 'statusbar');
    const sw = page.locator('#panel-statusbar .sbs-row[data-item="hostname"] input');
    const want = await flipStatus(request, 'hostname');
    await expect.poll(() => sw.isChecked(), { timeout: 10000 }).toBe(want);
    await page.click('#modal-close');
    const want2 = await flipStatus(request, 'hostname');
    await expect.poll(() => page.evaluate('statusBar.hostname'), { timeout: 10000 }).toBe(want2);
    await page.click('#settings-btn');
    await expect(sw).toBeVisible();
    expect(await sw.isChecked()).toBe(want2);
  });

  // 실측(HEAD 3dfb1c17): 다섯 모두 치는 중인 글자가 쓰이는 값(자른 값)으로 바뀌었다. 탭 폭 행(가드)만 남았다.
  for (const [tab, id] of [['display', 'ds-uifs'], ['terminal', 'ds-termfs'], ['terminal', 'ds-scrollspeed'],
    ['terminal', 'ds-mighookpct'], ['terminal', 'ds-treemigpct']]) {
    test(`TC-FFX-6: 입력 중인 숫자 칸(${id})을 다른 클라이언트의 설정 방송이 덮지 않는다`, async ({ page, request }) => {
      await waitForInit(page);
      await openTab(page, tab);
      const inp = page.locator('#' + id);
      await inp.click();
      await inp.press('ControlOrMeta+a');
      const put = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/settings' && r.request().method() === 'PUT');
      await inp.pressSequentially('9999');
      await put;
      const want = await flipStatus(request, 'hostname');
      await expect.poll(() => page.evaluate('statusBar.hostname'), { timeout: 10000 }).toBe(want);
      await expect(inp).toBeFocused();
      expect(await inp.inputValue()).toBe('9999');
      // 포커스가 떠나면 쓰이는 값으로 고쳐진다(지금 그대로).
      await inp.blur();
      await expect(inp).not.toHaveValue('9999');
    });
  }

  test('TC-FFX-8: access 탭을 고른 채 닫았다가 다시 열면 다른 클라이언트가 바꾼 목록을 읽는다 — 되풀이해도 읽기는 하나씩이다', async ({ page }) => {
    await waitForInit(page);
    const cur = await (await page.request.get('/api/access')).json();
    const put = (entries: any[]) => page.request.put('/api/access', { data: { enabled: false, entries, hosts: [] } });
    try {
      await put([]);
      await openTab(page, 'access');
      const rows = page.locator('#acl-list .acl-row');
      await expect(rows).toHaveCount(0);
      await page.click('#modal-close');
      await put([{ id: 'x', value: '10.9.9.9', enabled: true }]);
      let inflight = 0, maxInflight = 0;
      const isGet = (q: any) => new URL(q.url()).pathname === '/api/access' && q.method() === 'GET';
      page.on('request', (q) => { if (isGet(q)) { inflight++; maxInflight = Math.max(maxInflight, inflight) } });
      page.on('requestfinished', (q) => { if (isGet(q)) inflight-- });
      page.on('requestfailed', (q) => { if (isGet(q)) inflight-- });
      await page.click('#settings-btn');
      await expect(rows).toHaveCount(1, { timeout: 10000 });
      for (let i = 0; i < 4; i++) { await page.click('#modal-close'); await page.click('#settings-btn') }
      await expect.poll(() => inflight, { timeout: 10000 }).toBe(0);
      expect(maxInflight).toBe(1);
      await expect(rows).toHaveCount(1);
    } finally {
      await page.request.put('/api/access', { data: { enabled: !!cur.enabled, entries: cur.entries || [], hosts: cur.hosts || [] } });
    }
  });
});
