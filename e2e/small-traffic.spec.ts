import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-4-10 — 소통신 (FEC-3 · FEC-M1 · FEU-8).
 *
 * **고정 대기의 예외 (`TEST-16`).** 아래의 `waitForTimeout` 은 전부 **나가지 않는
 * 요청**을 잰다 — 일어나지 않는 일에는 기다릴 신호가 없다.
 */

function count(page: Page, path: string) {
  const box = { n: 0 };
  page.on('request', (r) => { if (new URL(r.url()).pathname === path) box.n++ });
  return box;
}

test('SMT1 (FEC-3): 포커스가 그대로면 그리기가 /api/cwd 를 묻지 않는다', async ({ page }) => {
  await waitForInit(page);
  const cwd = count(page, '/api/cwd');
  await page.evaluate(() => {
    const app = (window as any).app;
    for (let i = 0; i < 5; i++) app.renderer.render();
  });
  await page.waitForTimeout(800);
  expect(cwd.n, '같은 터미널의 위치를 그리기마다 물었다').toBe(0);
});

test('SMT2 (FEC-3): OSC 로 받은 위치가 있으면 포커스가 바뀌어도 묻지 않고 그 값을 쓴다', async ({ page }) => {
  await waitForInit(page);
  const ids = await page.evaluate(() => {
    const app = (window as any).app;
    const a = app.testing.focusedTerminal();
    a._onCwd('/tmp/dm-smt-a');
    app.split('horizontal');
    return { a: a.id };
  });
  await expect.poll(() => page.evaluate((a) => {
    const f = (window as any).app.testing.focusedTerminal();
    return !!f && f.id !== a;
  }, ids.a), { timeout: 10000 }).toBe(true);
  const cwd = count(page, '/api/cwd');
  await page.evaluate((a) => {
    const app = (window as any).app;
    // 앞 터미널로 포커스를 되돌린다 — 그 터미널은 OSC 값을 들고 있다.
    app.setFocus(app.findToolLocation(a).pane.id);
  }, ids.a);
  await page.waitForTimeout(800);
  expect(cwd.n, 'OSC 값이 있는데 서버에 물었다').toBe(0);
  expect(await page.evaluate(() => (window as any).app.cwd)).toBe('/tmp/dm-smt-a');
});

test('SMT3 (FEC-M1): 포커스 아닌 터미널의 OSC 는 상태바의 위치를 덮지 않는다', async ({ page }) => {
  await waitForInit(page);
  const other = await page.evaluate(() => {
    const app = (window as any).app;
    const a = app.testing.focusedTerminal();
    a._onCwd('/tmp/dm-smt-focus');
    app.split('horizontal');
    return a.id;
  });
  await expect.poll(() => page.evaluate((a) => {
    const f = (window as any).app.testing.focusedTerminal();
    return !!f && f.id !== a;
  }, other), { timeout: 10000 }).toBe(true);
  const got = await page.evaluate((a) => {
    const app = (window as any).app;
    const f = app.testing.focusedTerminal();
    f._onCwd('/tmp/dm-smt-mine');
    app.tools.get(a)._onCwd('/tmp/dm-smt-bg');
    return app.cwd;
  }, other);
  expect(got, '옆 칸 셸의 cd 가 상태바를 덮었다').toBe('/tmp/dm-smt-mine');
});

test('SMT4 (FEU-8): run_changed 가 몰려도 목록 재조회는 합친다', async ({ page }) => {
  await waitForInit(page);
  const runs = count(page, '/api/runs');
  await page.evaluate(() => {
    const bus = (window as any).app.bus;
    for (let i = 0; i < 10; i++) bus.publish('run_changed', { runId: 'dm-smt-none' });
  });
  await expect.poll(() => runs.n, { timeout: 5000 }).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  expect(runs.n, '이벤트 수만큼 목록을 받았다').toBe(1);
});
