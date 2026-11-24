import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * PERF M1 C3 (CHANNEL_PROTOCOL §10.4 · TC-CH3-8·9) — Runs 목록은 묻지 않고 받는다.
 *
 *   이전 동작: 패널이 열린 동안 활동 주기마다 `/api/runs` 를 다시 받았다 (ACTIVITY_RUNS_REFRESH_SRS TC-ARR-5)
 *   새  동작: 서버가 바뀔 때 채널의 `runs` 토픽으로 민다. 펼칠 때 한 번 받는 것(FR-ARR-4)은 남는다
 *   이유:     유휴 요청을 없앤다 (FR-CON-7·8)
 */

function count(page: Page, path: string) {
  const box = { n: 0 };
  page.on('request', (r) => { if (new URL(r.url()).pathname === path) box.n++ });
  return box;
}

test('TC-CH3-8: 펼친 패널은 /api/runs 를 주기로 받지 않고, 새 Run 은 토픽으로 온다', async ({ page }) => {
  await waitForInit(page);
  const runs = count(page, '/api/runs');
  const before = runs.n;
  await page.locator('#agents-panel .ag-collapse').click();
  // FR-ARR-4: 펼칠 때는 곧바로 한 번 받는다.
  await expect.poll(() => runs.n, { timeout: 2000 }).toBeGreaterThan(before);
  const afterOpen = runs.n;

  // **예외 (`TEST-16`)**: 요청이 "오지 않음" 을 재는 창이다 — 옛 활동 주기(5초)보다 길게 본다.
  await page.waitForTimeout(6000);
  expect(runs.n, '활동 주기로 /api/runs 를 다시 받았다').toBe(afterOpen);

  const toolId = await page.evaluate(() => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    return w.layout.tabs[0].toolId;
  });
  const runId = await page.evaluate(async (tid) => {
    const r = await fetch('/api/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: 'e2e topic', projection: 'dedicated-window', toolId: tid }),
    });
    return (await r.json()).id;
  }, toolId);
  await expect.poll(() => page.evaluate((id) =>
    ((window as any).app._runs._runsList || []).some((rv: any) => rv.id === id), runId), { timeout: 5000 }).toBe(true);
  // POST 한 건 말고 목록 GET 은 늘지 않았다.
  expect(runs.n).toBe(afterOpen + 1);
});
