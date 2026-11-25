import { Page } from '@playwright/test';

import { test, expect, gotoSettled } from './fixtures';

/**
 * PERF M1 C3 TC-CH3-11 (CHANNEL_PROTOCOL §10.4) — 열린 Run 탭은 `run:<id>` 토픽을 구독한다.
 *
 *   이전 동작: 활동 주기마다 `/graph` 를 다시 받았다 (RUN_VIEW_LIVE_SRS TC-RLV-8)
 *   새  동작: 서버가 그 Run 이 바뀔 수 있는 계기마다 그래프를 민다 — 주기 GET 이 없다
 *   이유:     유휴 요청을 없앤다 (FR-CON-7·8)
 */

function countGraph(page: Page, runId: string) {
  const box = { n: 0 };
  const path = '/api/runs/' + runId + '/graph';
  page.on('request', (r) => { if (new URL(r.url()).pathname === path) box.n++ });
  return box;
}

test('TC-CH3-11: 열린 Run 탭은 /graph 를 주기로 받지 않고, 바뀐 그래프는 토픽으로 온다', async ({ page }) => {
  await gotoSettled(page);
  const toolId = await page.evaluate(() => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    return w.layout.tabs[0].toolId;
  });
  const runId = await page.evaluate(async ([tid]) => {
    const r = await fetch('/api/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: 'e2e live', projection: 'dedicated-window', toolId: tid }),
    });
    return (await r.json()).id;
  }, [toolId]);
  const graph = countGraph(page, runId);

  await page.evaluate(async ([id]) => {
    const app = (window as any).app;
    await app.layout.tabAdd.addTab(app.focused, 'run', { runId: id, short: String(id).slice(0, 8) });
  }, [runId]);
  await expect(page.locator('.run-view .run-graph')).toBeVisible({ timeout: 10000 });
  const afterOpen = graph.n;

  // **예외 (`TEST-16`)**: 요청이 "오지 않음" 을 재는 창이다.
  await page.waitForTimeout(6000);
  expect(graph.n, '주기로 /graph 를 다시 받았다').toBe(afterOpen);

  const objective = () => page.evaluate((id) => {
    const app = (window as any).app;
    const v = [...app.testing.runsPanel()._runViewMap().values()].find((x: any) => x.runId === id);
    return v && v.data ? v.data.objective : null;
  }, runId);
  expect(await objective()).toBe('e2e live');
  await page.evaluate(async (id) => {
    await fetch('/api/runs/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: id }),
    });
  }, runId);
  await expect.poll(() => page.evaluate((id) => {
    const app = (window as any).app;
    const v = [...app.testing.runsPanel()._runViewMap().values()].find((x: any) => x.runId === id);
    return !!v && (v.err === 'gone' || (v.data && v.data.state !== 'open'));
  }, runId), { timeout: 5000 }).toBe(true);
});
