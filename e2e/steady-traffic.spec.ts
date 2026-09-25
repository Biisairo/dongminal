import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled } from './fixtures';

/**
 * OPTIMIZE_REFACTOR_SRS 묶음 O4b — 터미널 창 하나의 정상 상태 트래픽 (§3.4 목표 · FR-OPT-0-4).
 *
 * 세는 것은 요청이다. 터미널 창 하나가 선 채 **아무것도 하지 않는 30초**의 요청을
 * 종단별로 센다. 남는 것은 상태바의 ping·stats 와 저장소 목록의 안전망(30초)뿐이다.
 *
 *   이전 (ec950ea5): repos 10 · ping 10 · stats 10 · git/jobs 10 · tools/activity 6 = 46 (1.53 req/s)
 *   이후 (실측):     ping 10 · stats 10 · repos ≤ 1                                  ≈ 0.70 req/s
 *
 * §3.4 의 ≤ 0.5 req/s 는 ping 과 stats 가 **분리된 채**(FR-PRF-36~38) 기본 statsInterval
 * 3초에서는 닿지 않는다 — 두 요청이 3초마다다(0.67). 여기서는 "ping·stats 만 남는다" 를
 * 고정하고, 상한은 그 주기에서 파생한다.
 *
 * **고정 대기의 예외 (`TEST-16`).** 창 안에 요청이 몇 건 나가는가가 답이므로 기다릴
 * 신호가 없다 — 시간을 주고 그 사이의 수를 센다.
 */

const WINDOW_MS = 30000;

function timeline(page: Page) {
  const box: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) box.push(u.pathname);
  });
  return box;
}

function byPath(box: string[]) {
  const out: Record<string, number> = {};
  for (const p of box) out[p] = (out[p] || 0) + 1;
  return out;
}

test.describe('터미널 창 하나의 정상 상태 트래픽 (FR-OPT-4-3~4-6)', () => {
  test('30초 동안 ping·stats 와 안전망만 남는다', async ({ page }) => {
    test.setTimeout(WINDOW_MS + 60000);
    await waitForInit(page);
    await waitSettled(page);
    const box = timeline(page);
    await page.waitForTimeout(WINDOW_MS);
    const got = byPath(box);
    const rps = box.length / (WINDOW_MS / 1000);
    console.log('[steady-traffic]', JSON.stringify(got), 'rps=' + rps.toFixed(2));
    for (const p of ['/api/git/jobs', '/api/tools/activity', '/api/state', '/api/settings']) {
      expect(got[p] || 0, `${p} — ${JSON.stringify(got)}`).toBe(0);
    }
    // 저장소 목록은 안전망(gitStatusInterval, 기본 30초)만 남는다.
    expect(got['/api/git/repos'] || 0, JSON.stringify(got)).toBeLessThanOrEqual(1);
    const other = box.length - (got['/api/ping'] || 0) - (got['/api/stats'] || 0) - (got['/api/git/repos'] || 0);
    expect(other, JSON.stringify(got)).toBe(0);
    const stats = await page.evaluate(() => (window as any).statsInterval);
    const ticks = Math.ceil(WINDOW_MS / stats) + 1;   // 창의 양 끝에 회차가 하나씩 걸릴 수 있다
    expect(got['/api/stats'] || 0, JSON.stringify(got)).toBeLessThanOrEqual(ticks);
    expect(got['/api/ping'] || 0, JSON.stringify(got)).toBeLessThanOrEqual(ticks);
  });
  /**
   * FR-OPT-4-5 (IPC-6 · FEC-11): 구독이 **다시** 열리면 복원이 요청 둘이다 — 워크스페이스
   * (전경 이름을 함께 나른다)와 스냅샷 하나. 이전에는 /api/state 2 · attention · activity ·
   * background · settings · update · focus = 8 이었다.
   */
  test('재연결의 복원은 /api/state 하나와 /api/snapshot 하나다', async ({ page }) => {
    await waitForInit(page);
    await waitSettled(page);
    const box = timeline(page);
    await page.evaluate(() => (window as any).app.testing.sseKick());
    await expect.poll(() => byPath(box)['/api/snapshot'] || 0, { timeout: 15000 }).toBe(1);
    await expect.poll(() => byPath(box)['/api/state'] || 0, { timeout: 15000 }).toBe(1);
    const got = byPath(box);
    console.log('[reconnect]', JSON.stringify(got));
    for (const p of ['/api/tools/attention', '/api/tools/activity', '/api/tools/background',
      '/api/settings', '/api/update', '/api/focus', '/api/git/jobs']) {
      expect(got[p] || 0, `${p} — ${JSON.stringify(got)}`).toBe(0);
    }
  });
});
