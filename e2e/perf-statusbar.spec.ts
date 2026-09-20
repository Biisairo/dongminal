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
 *   지금: ping → (stats ∥ git/jobs)  뒤의 둘이 겹친다 (2r)
 *
 * `ping` 은 **겹치지 않아야 한다** — 그 왕복은 지연 측정 자체가 목적이라 다른
 * 요청과 같은 줄에 서면 측정이 오염된다 (FR-PRF-36). 그래서 이 검사는 겹침을
 * 요구하면서 동시에 **ping 이 겹치지 않음**도 단정한다. 한쪽만 보면 "전부
 * 겹치게" 도 통과하고 그것은 다른 결함이다.
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

const overlaps = (a: Entry, b: Entry) => a.start < b.end && b.start < a.end;

test('S1 (FR-PRF-36~38 · TC-PRF-13): 상태바 회차의 stats 와 git/jobs 가 겹치고 ping 은 겹치지 않는다', async ({ page }) => {
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
  expect(jobs.length, JSON.stringify(all)).toBeGreaterThanOrEqual(2);
  expect(pings.length, JSON.stringify(all)).toBeGreaterThanOrEqual(2);

  // 회차마다 stats 와 git/jobs 가 겹친다.
  const paired = stats.filter((s) => jobs.some((j) => overlaps(s, j)));
  expect(paired.length, `stats ${JSON.stringify(stats)} / jobs ${JSON.stringify(jobs)}`)
    .toBe(stats.length);

  // ping 은 그 둘 중 어느 것과도 겹치지 않는다 — 지연 측정은 홀로 선다.
  const dirty = pings.filter((p) => [...stats, ...jobs].some((o) => overlaps(p, o)));
  expect(dirty.length, `ping ${JSON.stringify(pings)}`).toBe(0);
});
