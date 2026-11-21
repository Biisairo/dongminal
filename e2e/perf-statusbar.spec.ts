import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * PERFORMANCE_HARDENING_SRS 묶음 P-B — **상태바 한 회차의 직렬 왕복이 둘이다**
 * (FR-PRF-36~38 · TC-PRF-13 · `refactor/README.md` §4.1 항목 10).
 *
 * ## 무엇을 재는가
 *
 * 벽시계가 아니라 **겹침**이다 (FR-PRF-3). 이 기계에서 RTT 는 1ms 도 안 되므로
 * "빨라졌다" 를 시간으로 보이려면 지연을 흉내내야 하고, 그 값은 러너마다 다르다.
 * 겹쳤는가는 **같은 입력에 같은 답**이 나온다.
 *
 *   이전: ping → stats → git/jobs   세 왕복이 줄을 선다 (3r)
 *   다음: ping → (stats ∥ git/jobs)  뒤의 둘이 겹친다 (2r)
 *   그다음: ping → stats?jobs=1      뒤의 둘이 한 요청이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-4-4)
 *   지금: ping ∥ stats?jobs=1        둘을 함께 보낸다 (REFACTOR3_FE_REST1_SRS FR-FR1-14, 1r)
 *
 * REFACTOR3_FE_REST1_SRS D-FR1-10:
 *   이전 동작: ping 은 겹치지 않아야 했다 — 응답을 받은 뒤에야 stats 를 보냈다
 *   새  동작: stats 는 ping 응답을 기다리지 않는다. 지연(`_latency`)은 그대로 ping 의 왕복만 잰다
 *             (단위 시험 `statusbar-poll.test.mjs` 가 고정한다)
 *   이유:     두 요청은 따로 간다. 회차 대기가 RTT 두 번에서 한 번으로 준다
 */

type Entry = { name: string; start: number; end: number };

/** 이번 회차의 세 종단 타이밍. 브라우저의 Resource Timing 을 그대로 읽는다. */
async function timings(page: Page) {
  return page.evaluate(() => {
    const want = ['/api/ping', '/api/stats', '/api/git/jobs'];
    return performance.getEntriesByType('resource')
      .filter((e) => want.some((w) => e.name.includes(w)))
      .map((e) => ({
        name: want.find((w) => e.name.includes(w))!,
        start: e.startTime,
        end: (e as PerformanceResourceTiming).responseEnd,
      }));
  });
}

const overlaps = (a: Entry, b: Entry) => a.start <= b.end && b.start <= a.end;

test('S1 (FR-PRF-36~38 · TC-PRF-13 · FR-OPT-4-4 · FR-FR1-14): 상태바 회차는 ping 과 stats 둘이고 stats 는 ping 응답을 기다리지 않는다', async ({ page }) => {
  await waitForInit(page);
  await page.evaluate(() => performance.clearResourceTimings());

  // **고정 대기가 아니다** — 회차가 실제로 두 번 돌 때까지 조건으로 기다린다.
  // 기본 주기는 3초이므로(`settings-schema.js` `statsInterval`) 여유가 넉넉하다.
  await expect.poll(async () => (await timings(page)).filter((e) => e.name === '/api/stats').length,
    { timeout: 30000 }).toBeGreaterThanOrEqual(2);

  const all = await timings(page);
  const stats = all.filter((e) => e.name === '/api/stats');
  const jobs = all.filter((e) => e.name === '/api/git/jobs');
  const pings = all.filter((e) => e.name === '/api/ping');
  expect(pings.length, JSON.stringify(all)).toBeGreaterThanOrEqual(2);
  // Git 패널이 없으면 작업 목록을 묻지 않는다 — 틱에도 따로도.
  expect(jobs.length, JSON.stringify(all)).toBe(0);

  // 회차마다 stats 는 ping 응답이 오기 **전에** 떠난다 — 직렬이면 ping 의 끝 뒤에 시작한다.
  const serial = pings.filter((p) => !stats.some((o) => overlaps(p, o)));
  expect(serial.length, `ping ${JSON.stringify(pings)} stats ${JSON.stringify(stats)}`).toBe(0);
});
