import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * ACTIVITY_RUNS_REFRESH_SRS TC-ARR-5 (FR-ARR-1·2·4 · NFR-ARR-1) — 패널이 열린 동안
 * Runs 목록을 활동 주기마다 다시 받고, 닫히면 멈춘다.
 *
 * **고정 대기의 예외 (`TEST-16`).** 닫힌 뒤의 `waitForTimeout` 은 **나가지 않는
 * 요청**을 잰다 — 일어나지 않는 일에는 기다릴 신호가 없다.
 */

const POLL_MS = 300;

function count(page: Page, path: string) {
  const box = { n: 0 };
  page.on('request', (r) => { if (new URL(r.url()).pathname === path) box.n++ });
  return box;
}

test('TC-ARR-5: 열린 동안 /api/runs 를 주기로 받고, 닫히면 받지 않는다', async ({ page }) => {
  await waitForInit(page);
  // 이 페이지의 활동 주기만 줄인다 — 서버 설정을 바꾸면 다른 스펙이 흔들린다.
  await page.evaluate((ms) => {
    Object.defineProperty((window as any).app, 'agentsPollMs', { value: ms, configurable: true });
  }, POLL_MS);
  const runs = count(page, '/api/runs');

  // FR-ARR-4: 핸들 버튼으로 열어도 곧바로 받는다.
  await page.locator('#agents-toggle').click();
  await expect.poll(() => runs.n, { timeout: 2000 }).toBeGreaterThan(0);

  // FR-ARR-1: 그 뒤로도 이어서 받는다. 첫 주기는 부팅 때 잡힌 기본 주기일 수 있다.
  const afterOpen = runs.n;
  await expect.poll(() => runs.n, { timeout: 10000 }).toBeGreaterThanOrEqual(afterOpen + 2);

  // FR-ARR-2: 닫으면 멈춘다.
  await page.locator('#agents-toggle').click();
  await page.waitForTimeout(POLL_MS * 2);
  const closed = runs.n;
  await page.waitForTimeout(POLL_MS * 5);
  expect(runs.n, '닫힌 패널이 목록을 받았다').toBe(closed);
});
