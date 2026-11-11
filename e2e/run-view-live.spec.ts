import { Page } from '@playwright/test';

import { test, expect, gotoSettled } from './fixtures';

/**
 * RUN_VIEW_LIVE_SRS TC-RLV-8 (FR-RLV-7 · NFR-RLV-1) — 열린 Run 탭은 활동 주기마다 `/graph` 를
 * 다시 받는다. D-RLV-1 이 FR-RVZ-16 의 "폴링하지 않는다" 를 거뒀다.
 */

const POLL_MS = 300;

function countGraph(page: Page, runId: string) {
  const box = { n: 0 };
  const path = '/api/runs/' + runId + '/graph';
  page.on('request', (r) => { if (new URL(r.url()).pathname === path) box.n++ });
  return box;
}

test('TC-RLV-8: 열린 Run 탭은 /graph 를 주기로 다시 받는다', async ({ page }) => {
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
  // 이 페이지의 활동 주기만 줄인다 — 서버 설정을 바꾸면 다른 스펙이 흔들린다.
  await page.evaluate((ms) => {
    Object.defineProperty((window as any).app, 'agentsPollMs', { value: ms, configurable: true });
  }, POLL_MS);
  const graph = countGraph(page, runId);

  await page.evaluate(async ([id]) => {
    const app = (window as any).app;
    await app.addTab(app.focused, 'run', { runId: id, short: String(id).slice(0, 8) });
  }, [runId]);
  await expect(page.locator('.run-view .run-graph')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => graph.n, { timeout: 2000 }).toBeGreaterThan(0);

  // 첫 주기는 부팅 때 잡힌 기본 주기일 수 있다.
  const afterOpen = graph.n;
  await expect.poll(() => graph.n, { timeout: 10000 }).toBeGreaterThanOrEqual(afterOpen + 2);
});
