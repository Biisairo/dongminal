import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// SLOT_RUN_VIEW_SRS §5 TC-SRV-*
//
// 같은 Run 탭이 두 칸에 보일 때 **뷰도 DOM 도 둘**이어야 한다. 하나뿐이면 뒤에
// 그린 칸이 앞 칸에서 노드를 떼어 가고 앞 칸이 빈다 (§1.1 의 재현).
//
// 서버 계약은 runs.spec.ts 가 맡는다 — 여기서는 그 응답을 route 로 세우고
// **칸 사이의 다중화**만 잰다.

const RUN_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const NOW = () => Math.floor(Date.now() / 1000);

type Json = Record<string, any>;

function graphA(): Json {
  const t = NOW();
  return {
    runId: RUN_A, short: 'a1b2', objective: '칸 다중화 확인',
    state: 'open', isolation: 'per-member',
    createdAt: t - 100, coordinatorToolId: 'tool-coord',
    members: [{ id: 'm1', role: '작가', agent: 'claude', toolId: 'tool-m1',
                state: 'working', createdAt: t - 90 }],
    edges: [], messages: [], timeline: [],
  };
}

async function mockRuns(page: Page) {
  await page.route('**/api/runs', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ runs: [{ id: RUN_A, short: 'a1b2', objective: '칸 다중화 확인',
        state: 'open', isolation: 'per-member', createdAt: NOW() - 100, members: [] }] }) }));
  await page.route('**/api/runs/*/graph', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(graphA()) }));
}

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 활성 창의 첫 pane 에 Run 탭을 만들고 그 탭 id 를 준다.
const addRunTab = (page: Page, runId = RUN_A) =>
  page.evaluate(async (rid) => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    const first = (n: any): any => !n ? null
      : n.type === 'pane' ? n : (n.children || []).map(first).find(Boolean);
    const pn = first(w.layout);
    await app.addTab(pn.id, 'run', { runId: rid });
    app.render();
    const tab = (pn.tabs || []).find((t: any) => t.type === 'run');
    return { tabId: tab.id, paneId: pn.id, winId: w.id };
  }, runId);

// 같은 창을 두 칸에 놓고 그 Run 탭을 양쪽에서 활성으로 만든다.
const showInBothSlots = (page: Page, winId: string, paneId: string, tabId: string) =>
  page.evaluate(([w, p, t]) => {
    const app = (window as any).app;
    app.slotAdd();
    app.slotOpen(0, w); app.slotOpen(1, w);
    const find = (n: any): any => !n ? null
      : n.type === 'pane' ? (n.id === p ? n : null) : (n.children || []).map(find).find(Boolean);
    const pn = find(app.ws.windows.find((x: any) => x.id === w).layout);
    app.paneTabSet(pn, t, 0);
    app.paneTabSet(pn, t, 1);
    app.slotFocusTo(0);
    app.render();
  }, [winId, paneId, tabId] as const);

const runViewsPerSlot = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('.run-view')].map((el) => {
    const s = (el as HTMLElement).closest('.slot') as HTMLElement | null;
    return s ? s.dataset.slot : 'none';
  }));

const viewKeys = (page: Page) =>
  page.evaluate(() => [...((window as any).app._runViews || new Map()).keys()]);

test.describe('Run 뷰의 칸 다중화', () => {
  // TC-SRV-1
  test('같은 Run 탭이 두 칸에 보이면 뷰가 둘이다', async ({ page }) => {
    await mockRuns(page);
    await waitForInit(page);
    const { tabId, paneId, winId } = await addRunTab(page);
    await showInBothSlots(page, winId, paneId, tabId);

    await expect.poll(() => runViewsPerSlot(page), { timeout: 15000 })
      .toEqual(expect.arrayContaining(['0', '1']));
    expect((await runViewsPerSlot(page)).length).toBe(2);
  });

  // TC-SRV-2
  test('칸이 하나면 뷰도 하나이고 키에 접미사가 없다', async ({ page }) => {
    await mockRuns(page);
    await waitForInit(page);
    const { tabId } = await addRunTab(page);
    await expect.poll(() => page.locator('.run-view').count(), { timeout: 15000 }).toBe(1);
    // FR-SRV-3 / FR-WSL-75: 칸 0 의 키는 탭 id 그대로다.
    expect(await viewKeys(page)).toEqual([tabId]);
  });

  // TC-SRV-3 — 편집기 FR-SVS-60 이 낸 사고와 같은 형태의 회귀.
  test('다시 그려도 어느 칸의 뷰도 파괴되지 않는다', async ({ page }) => {
    await mockRuns(page);
    await waitForInit(page);
    const { tabId, paneId, winId } = await addRunTab(page);
    await showInBothSlots(page, winId, paneId, tabId);
    await expect.poll(() => page.locator('.run-view').count(), { timeout: 15000 }).toBe(2);

    const before = await viewKeys(page);
    for (let i = 0; i < 3; i++) await page.evaluate(() => (window as any).app.render());
    await page.waitForTimeout(300);

    expect(await viewKeys(page)).toEqual(before);
    expect(await page.locator('.run-view').count()).toBe(2);
  });

  // TC-SRV-4
  test('칸을 줄이면 사라진 칸의 뷰가 거둬진다', async ({ page }) => {
    await mockRuns(page);
    await waitForInit(page);
    const { tabId, paneId, winId } = await addRunTab(page);
    await showInBothSlots(page, winId, paneId, tabId);
    await expect.poll(() => page.locator('.run-view').count(), { timeout: 15000 }).toBe(2);

    await page.evaluate(() => {
      const app = (window as any).app;
      app.slotFocusTo(0);
      app.slotRemove();
      app.render();
    });
    await expect.poll(() => page.locator('.run-view').count(), { timeout: 15000 }).toBe(1);
    expect(await viewKeys(page)).toEqual([tabId]);
  });

  // TC-SRV-5
  test('run 이 바뀌면 두 칸의 뷰가 함께 갱신된다', async ({ page }) => {
    await mockRuns(page);
    await waitForInit(page);
    const { tabId, paneId, winId } = await addRunTab(page);
    await showInBothSlots(page, winId, paneId, tabId);
    await expect.poll(() => page.locator('.run-view').count(), { timeout: 15000 }).toBe(2);

    // SSE 수신 경로를 직접 두드린다 — 두 칸의 뷰가 모두 다시 그려져야 한다.
    const painted = await page.evaluate(async (rid) => {
      const app = (window as any).app;
      const seen: string[] = [];
      const orig = app._runPaint.bind(app);
      app._runPaint = (v: any) => { seen.push(String(v.tabId)); return orig(v) };
      app._onRunChanged({ runId: rid });
      await new Promise((r) => setTimeout(r, 500));
      app._runPaint = orig;
      return seen;
    }, RUN_A);
    // 두 칸의 뷰가 각각 그려졌다 — 하나만이면 이 SRS 가 고치려는 증상이 남은 것이다.
    expect(painted.length).toBeGreaterThanOrEqual(2);
  });

  // TC-SRV-6
  test('Run 탭을 닫으면 모든 칸에서 뷰가 거둬진다', async ({ page }) => {
    await mockRuns(page);
    await waitForInit(page);
    const { tabId, paneId, winId } = await addRunTab(page);
    await showInBothSlots(page, winId, paneId, tabId);
    await expect.poll(() => page.locator('.run-view').count(), { timeout: 15000 }).toBe(2);

    await page.evaluate(([p, t]) => {
      const app = (window as any).app;
      app.closeTab(p, t);
      app.render();
      // 회수는 run 변경 수신에서 스스로 맞춘다 (app-runs.js 의 규약).
      app._onRunChanged({ runId: 'zzzz' });
    }, [paneId, tabId] as const);

    await expect.poll(() => page.locator('.run-view').count(), { timeout: 15000 }).toBe(0);
    expect(await viewKeys(page)).toEqual([]);
  });
});
