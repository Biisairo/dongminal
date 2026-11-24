import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled, JSON_HDR } from './fixtures';

/**
 * OPTIMIZE_REFACTOR_SRS 묶음 O4b — 터미널 창 하나의 정상 상태 트래픽 (§3.4 목표 · FR-OPT-0-4).
 *
 * 세는 것은 요청이다. 터미널 창 하나가 선 채 **아무것도 하지 않는 30초**의 요청을
 * 종단별로 센다. 남는 것은 상태바의 ping·stats 와 저장소 목록의 안전망(30초)이고,
 * 데스크톱이면 Activity 레일이 읽는 주기 조회가 더해진다(UX_BATCH12 FR-ACF-9, 2026-11-13 개정).
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

/**
 * 워커의 서버는 앞 스펙과 함께 쓴다. 앞 스펙(`skill-contract` 등)이 남긴 Run 은 수거
 * 루프(`reapInterval` 15초, FR-DEL-14)가 창 안에서 지우고 `run_changed` 를 방송하며, 화면은
 * 그것을 받아 `/api/runs` 를 한 번 다시 받는다(FR-OPT-4-10) — 화면의 정상 동작이지만 이
 * 창의 "아무것도 하지 않는다" 를 깬다. 페이지를 열기 **전에** 지워 둔다(방송을 받을 화면이 없다).
 */
async function clearRuns(request: APIRequestContext) {
  const list = await (await request.get('/api/runs')).json();
  // 수거 루프와 겹치면 이미 지워져 404 다 — 지워졌다는 결과는 같다.
  for (const rv of list.runs || []) {
    const r = await request.delete('/api/runs/' + encodeURIComponent(rv.id), { headers: JSON_HDR });
    expect([200, 404], `DELETE /api/runs/${rv.id} → ${r.status()}`).toContain(r.status());
  }
  const left = await (await request.get('/api/runs')).json();
  expect(left.runs || [], '남은 Run 이 창 안에서 수거되며 /api/runs 를 부른다').toEqual([]);
}

function byPath(box: string[]) {
  const out: Record<string, number> = {};
  for (const p of box) out[p] = (out[p] || 0) + 1;
  return out;
}

test.describe('터미널 창 하나의 정상 상태 트래픽 (FR-OPT-4-3~4-6)', () => {
  test('30초 동안 안전망만 남는다 (ping·stats 는 채널)', async ({ page, request }) => {
    test.setTimeout(WINDOW_MS + 60000);
    await clearRuns(request);
    await waitForInit(page);
    await waitSettled(page);
    const box = timeline(page);
    await page.waitForTimeout(WINDOW_MS);
    const got = byPath(box);
    const rps = box.length / (WINDOW_MS / 1000);
    console.log('[steady-traffic]', JSON.stringify(got), 'rps=' + rps.toFixed(2));
    // CHANNEL_PROTOCOL C2b (D-9): 워크스페이스·설정·Claude 계정은 채널 토픽으로 온다 — 주기 GET 이 없다.
    for (const p of ['/api/git/jobs', '/api/state', '/api/settings', '/api/claude-accounts', '/api/claude-accounts/mappings']) {
      expect(got[p] || 0, `${p} — ${JSON.stringify(got)}`).toBe(0);
    }
    // 저장소 목록은 안전망(gitStatusInterval, 기본 30초)만 남는다.
    expect(got['/api/git/repos'] || 0, JSON.stringify(got)).toBeLessThanOrEqual(1);
    /**
     * PERF M1 C3 (CHANNEL_PROTOCOL §10.4): 활동·Runs·Background·지표·지연은 채널 토픽으로 온다 —
     * 주기 GET 이 0 이다. Claude 계정은 `claude.accounts` 토픽이 준다(C2b) — 역시 0 이다.
     */
    for (const p of ['/api/tools/activity', '/api/runs', '/api/tools/background', '/api/stats', '/api/ping']) {
      expect(got[p] || 0, `${p} — ${JSON.stringify(got)}`).toBe(0);
    }
    const known = ['/api/git/repos'];
    const other = box.filter((p) => !known.includes(p));
    expect(other, JSON.stringify(got)).toEqual([]);
  });
  /**
   * FR-OPT-4-5 (IPC-6 · FEC-11): 구독이 **다시** 열리면 복원은 채널 토픽의 재구독이 준다 — 상태를 다시 받는
   * GET 이 없다(CHANNEL_PROTOCOL C2b·C3). 이전에는 /api/state 2 · attention · activity · background ·
   * settings · update · focus = 8, 그다음 /api/state 1 · /api/snapshot 1 이었다.
   */
  test('재연결의 복원은 GET 없이 토픽 재구독이다', async ({ page }) => {
    await waitForInit(page);
    await waitSettled(page);
    const box = timeline(page);
    const gen = await page.evaluate(() => (window as any).app.testing.channel.gen());
    await page.evaluate(() => (window as any).app.testing.channel.connect());
    await expect.poll(() => page.evaluate(() => (window as any).app.testing.channel.alive()), { timeout: 15000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).app.testing.channel.gen()), { timeout: 15000 }).toBeGreaterThan(gen);
    await page.waitForTimeout(1000); // TEST-16: 재연결 뒤 GET 이 **없음**을 잰다
    const got = byPath(box);
    console.log('[reconnect]', JSON.stringify(got));
    for (const p of ['/api/snapshot', '/api/state', '/api/tools/attention', '/api/tools/activity', '/api/tools/background',
      '/api/settings', '/api/update', '/api/focus', '/api/git/jobs']) {
      expect(got[p] || 0, `${p} — ${JSON.stringify(got)}`).toBe(0);
    }
  });
});
