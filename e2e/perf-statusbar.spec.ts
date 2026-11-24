import { test, expect, waitForInit } from './fixtures';

/**
 * PERF M1 C3 TC-CH3-10 (CHANNEL_PROTOCOL §10.4) — 상태바는 묻지 않는다.
 *
 *   이전 동작: 회차마다 `/api/ping` ∥ `/api/stats?jobs=1` 을 보냈다 (FR-PRF-36~38 · FR-FR1-14)
 *   새  동작: 채널의 `stats:<statsInterval>` 을 구독하고, 지연은 채널 ping 의 왕복이다
 *   이유:     유휴 요청을 없앤다 (FR-CON-7)
 */

test('TC-CH3-10: 상태바는 /api/ping·/api/stats 를 보내지 않고 지표·지연을 채널로 받는다', async ({ page }) => {
  await waitForInit(page);
  await page.evaluate(() => performance.clearResourceTimings());
  await expect.poll(() => page.evaluate(() => typeof (window as any).app._latency), { timeout: 15000 }).toBe('number');
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).app._stats || {}).length), { timeout: 15000 })
    .toBeGreaterThan(0);
  const polled = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((e) => new URL(e.name).pathname)
    .filter((p) => p === '/api/ping' || p === '/api/stats'));
  expect(polled).toEqual([]);
});
