import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * ACTIVITY_RUNS_REFRESH_SRS TC-ARR-5 (FR-ARR-1·4 · NFR-ARR-1) — 패널이 열린 동안
 * Runs 목록을 활동 주기마다 다시 받는다.
 *
 * UX_BATCH12_SRS FR-ACF-9 가 FR-ARR-2(닫히면 멈춘다)를 데스크톱에서 바꿨다 — 데스크톱에는
 * 닫힘이 없고 레일도 목록을 보이므로 레일에서도 받는다.
 */

const POLL_MS = 300;

function count(page: Page, path: string) {
  const box = { n: 0 };
  page.on('request', (r) => { if (new URL(r.url()).pathname === path) box.n++ });
  return box;
}

test('TC-ARR-5: 펼친 동안 /api/runs 를 주기로 받고, 레일로 접어도 이어서 받는다', async ({ page }) => {
  await waitForInit(page);
  // 이 페이지의 활동 주기만 줄인다 — 서버 설정을 바꾸면 다른 스펙이 흔들린다.
  await page.evaluate((ms) => {
    Object.defineProperty((window as any).app, 'agentsPollMs', { value: ms, configurable: true });
  }, POLL_MS);
  const runs = count(page, '/api/runs');

  // FR-ARR-4: 머리의 단추로 펼쳐도 곧바로 받는다.
  const before = runs.n;
  await page.locator('#agents-panel .ag-collapse').click();
  await expect.poll(() => runs.n, { timeout: 2000 }).toBeGreaterThan(before);

  // FR-ARR-1: 그 뒤로도 이어서 받는다. 첫 주기는 부팅 때 잡힌 기본 주기일 수 있다.
  const afterOpen = runs.n;
  await expect.poll(() => runs.n, { timeout: 10000 }).toBeGreaterThanOrEqual(afterOpen + 2);

  // FR-ACF-9: 레일로 접어도 이어서 받는다.
  await page.locator('#agents-panel .ag-collapse').click();
  await expect(page.locator('#agents-panel.open')).toHaveCount(0);
  const railed = runs.n;
  await expect.poll(() => runs.n, { timeout: 10000 }).toBeGreaterThanOrEqual(railed + 2);
});
