import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

/**
 * POLL_INTERVAL_SETTINGS_SRS §4 — 검증 V-1 ~ V-11.
 *
 * 요구 ⑪ "polling 이 한쪽에 모여있잖아? setting 에서 이 값을 조절할 수 있도록."
 *
 * 두 갈래를 함께 잰다: **죽은 계층의 제거**(브라우저 signature 폴링)와 **다섯
 * 주기가 설정이 되는 것**. 하나가 다른 하나의 조건이다 — 손잡이를 달 자리를
 * 가려내는 일이 제거였다 (§2.4).
 */

// 앱의 전역 `const` 들 — 브라우저 안에서만 산다. `page.evaluate` 는 그 스코프에서
// 평가되므로 이름을 그대로 쓰되, TS 에는 존재만 알린다.
declare const GIT_SIGNATURE_POLL_MS: number;
declare const STATS_INTERVAL_DEFAULT: number;
declare const TIMERS: { _jobs: Map<string, { nextAt: number }>; refreshChanged(): void };

const FIXTURES = tmpPath('otter-git-fx-pollint-' + process.pid);
test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });
const fx = (name: string) => realPath(join(FIXTURES, name));

// 설정은 서버의 단일 블롭이다 — 읽어 합친 뒤 되돌려 준다 (git-polling 과 같은 규약).
async function patchSettings(request: APIRequestContext, patch: Record<string, unknown>) {
  const cur = await (await request.get('/api/settings')).json();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete cur[k];
    else cur[k] = v;
  }
  const r = await request.put('/api/settings', { data: cur });
  expect(r.ok(), `설정 저장 실패: ${await r.text()}`).toBeTruthy();
}

// `agentsPollInterval`(PERF M1 C6)·`gitConsoleInterval`(PERF 1.9)·`gitStatusInterval`·`gitReposInterval`(PERF 1.15)은 거뒀다.
const POLL_KEYS = ['statsInterval'] as const;

const clearIntervals = (request: APIRequestContext) =>
  patchSettings(request, Object.fromEntries(POLL_KEYS.map(k => [k, undefined])));

// 요청 수는 가로채기로 센다 — 내부 카운터로는 "보내지 않았다" 를 증명할 수 없다.
function counter(page: Page, needle: string) {
  const state = { n: 0 };
  page.on('request', (r) => { if (r.url().includes(needle)) state.n++ });
  return state;
}

const openSettings = async (page: Page, tab: string) => {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#modal')).toBeVisible();
  await page.locator(`.mtab[data-tab="${tab}"]`).click();
};

// ─────────────────────────────────────────────────────────────────────────────

test.describe('묶음 PIS·제거 — 브라우저 signature 폴링 (FR-PIS-1~4)', () => {

  /**
   * FR-PIS-3: 지운 것은 **폴링**이고 지문 자체가 아니다. `_lastSig` 는 status
   * 응답이 실어 오며(`git-poll.js` `_applyStatus`) 확인창·히스토리·다이얼로그가 그것을 딛는다.
   */
  test('PIS3 (V-2): status 응답이 `_lastSig` 를 채운다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    await expect.poll(async () => page.evaluate(() => {
      const app = (window as any).app;
      for (const o of (app.testing.gitObservers || new Map()).values()) {
        const p = o.any();
        if (p && p._lastSig) return true;
      }
      return false;
    }), { timeout: 15000 }).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('묶음 PIS·설정 — 주기 (FR-PIS-6~15)', () => {
  test.afterEach(async ({ request }) => { await clearIntervals(request) });

  test('PIS4 (V-4): 주기 키가 설정에서 화면으로 내려온다', async ({ page, request }) => {
    await patchSettings(request, { statsInterval: 5000 });
    await waitForInit(page);
    expect(await page.evaluate(() => (window as any).statsInterval)).toBe(5000);
  });

  // FR-PIS-7: 얹는 자리가 하나이므로 채널 방송도 같은 길을 지난다 (FR-SYN).
  test('PIS5 (V-4): 다른 창에서 바꾼 값이 채널로 따라온다', async ({ page, request }) => {
    await waitForInit(page);
    await patchSettings(request, { statsInterval: 30000 });
    await expect.poll(() => page.evaluate(() => (window as any).statsInterval),
      { timeout: 10000 }).toBe(30000);
  });

  /**
   * FR-PIS-8: 손으로 고친 `settings.json` 하나가 초당 폴링을 만들지 않아야 한다.
   * 범위 밖·정수 아님·음수는 전부 기본값으로 떨어진다.
   */
  test('PIS6 (V-5): 범위 밖 값은 기본값으로 떨어진다', async ({ page, request }) => {
    await patchSettings(request, { statsInterval: 'x' });
    await waitForInit(page);
    const v = await page.evaluate(() => ({ stats: (window as any).statsInterval, dStats: STATS_INTERVAL_DEFAULT }));
    expect(v.stats).toBe(v.dStats);
  });

  /**
   * FR-PIS-8a: **미저장 키는 손대지 않는다.** 그 키가 없는 설정 방송 하나가 화면 안에서
   * 직접 넣어 둔 값을 기본값으로 되돌리면, 그 값을 딛는 검사·진단이 타이밍에 따라 깨진다.
   */
  test('PIS7a (V-5a): 키 없는 방송은 넣어 둔 값을 지우지 않는다', async ({ page, request }) => {
    await clearIntervals(request);
    await waitForInit(page);
    await page.evaluate(() => { (window as any).statsInterval = 700 });
    // 주기 키가 하나도 없는 설정을 저장한다 — 방송이 오고 `_settingsApply` 가 돈다.
    await patchSettings(request, { tabWidthPx: 161 });
    await expect.poll(() => page.evaluate(() => (window as any).tabWidthPx),
      { timeout: 10000 }).toBe(161);
    expect(await page.evaluate(() => (window as any).statsInterval),
      '키 없는 방송이 넣어 둔 주기를 지웠다').toBe(700);
    await patchSettings(request, { tabWidthPx: undefined });
  });

  /**
   * PERF 1.15: git 실패 재시도 간격은 설정이 아니다. 거둔 키가 블롭에 남아 있어도
   * 배지의 낡음 기준과 트리 백오프는 상수 그대로다.
   */
  test('PIS8 (V-6): 거둔 git 주기 키는 파생 기준을 바꾸지 않는다', async ({ page, request }) => {
    await waitForInit(page);
    const before = await page.evaluate(() => ({
      stale: (window as any).gitBadgeStaleMs(),
      backoff: (window as any).editorGitBackoffMs(),
    }));
    await patchSettings(request, { gitReposInterval: 6000, gitStatusInterval: 10000, tabWidthPx: 162 });
    await expect.poll(() => page.evaluate(() => (window as any).tabWidthPx), { timeout: 10000 }).toBe(162);
    const after = await page.evaluate(() => ({
      stale: (window as any).gitBadgeStaleMs(),
      backoff: (window as any).editorGitBackoffMs(),
      status: typeof (window as any).gitStatusInterval,
      repos: typeof (window as any).gitReposInterval,
    }));
    expect(after).toEqual({ ...before, status: 'undefined', repos: 'undefined' });
    await patchSettings(request, { gitReposInterval: undefined, gitStatusInterval: undefined, tabWidthPx: undefined });
  });

  /**
   * FR-PIS-14 (PERF M1 C3 개정): 주기는 채널 토픽 이름(`stats:<ms>`)이다.
   *   이전 동작: 내린 순간에는 요청이 없고 다음 마감부터 새 주기로 `/api/stats` 를 보냈다
   *   새  동작: 내리면 곧바로 새 토픽으로 갈아타고, 그 뒤로 새 주기로 받는다. HTTP 요청은 없다
   *   이유:     상태바가 묻지 않는다 (TC-CH3-10)
   */
  test('PIS11 (V-8): 주기를 내리면 새 주기로 받고 /api/stats 는 보내지 않는다',
    async ({ page, request }) => {
      await patchSettings(request, { statsInterval: 30000 });
      await waitForInit(page);
      const stats = counter(page, '/api/stats');
      await page.evaluate(() => {
        const sb = (window as any).app.statusbar;
        (window as any).__statsN = 0;
        const orig = sb._onStats.bind(sb);
        sb._onStats = (m: any) => { (window as any).__statsN++; orig(m) };
      });
      await patchSettings(request, { statsInterval: 1000 });
      await expect.poll(() => page.evaluate(() => (window as any).statsInterval),
        { timeout: 10000 }).toBe(1000);
      await expect.poll(() => page.evaluate(() => (window as any).__statsN), { timeout: 6000 }).toBeGreaterThanOrEqual(3);
      expect(stats.n).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('PERF M1 C6 — 거둔 설정 agentsPollInterval', () => {
  test.afterEach(async ({ request }) => { await clearIntervals(request) });

  // 저장된 옛 값은 읽을 때 무시된다. 화면에 그 주기가 없다.
  test('PIS12: 옛 agentsPollInterval 이 저장돼 있어도 무시되고 화면에 없다', async ({ page, request }) => {
    await patchSettings(request, { agentsPollInterval: 3000 });
    await waitForInit(page);
    expect(await page.evaluate(() => typeof (window as any).agentsPollInterval)).toBe('undefined');
    await openSettings(page, 'polling');
    await expect(page.locator('#panel-polling #pi-stats')).toBeVisible();
    await expect(page.locator('#pi-agents')).toHaveCount(0);
    await patchSettings(request, { agentsPollInterval: undefined });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('묶음 PIS·화면 — Polling 탭 (FR-PIS-20~25)', () => {
  test('PIS15 (V-10): Polling 탭에 남은 주기 컨트롤이 선다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page, 'polling');
    const panel = page.locator('#panel-polling');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#pi-stats')).toBeVisible();
    for (const id of ['pi-gitconsole', 'pi-gitstatus', 'pi-gitrepos', 'pi-gitworktree'])
      await expect(panel.locator('#' + id), id + ' 는 거뒀다 (PERF 1.9·1.15·4.9)').toHaveCount(0);
  });

  // FR-PIS-20 의 대칭: 화면에서 고른 값이 서버로 간다.
  test('PIS17 (V-10): 드롭다운을 바꾸면 서버 설정에 실린다', async ({ page, request }) => {
    await waitForInit(page);
    await openSettings(page, 'polling');
    await page.locator('#pi-stats').selectOption('5000');
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).statsInterval,
      { timeout: 10000 }).toBe(5000);
    expect(await page.evaluate(() => (window as any).statsInterval)).toBe(5000);
    await clearIntervals(request);
  });

  // FR-PIS-9: 뜻이 없는 자리에는 그 선택지를 두지 않는다. `끔`(0)을 받던 안전망은 거뒀다 (PERF 1.15).
  test('PIS18 (V-5): 남은 주기 컨트롤에 `끔`(0) 선택지가 없다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page, 'polling');
    for (const id of ['pi-stats']) {
      const has0 = await page.evaluate((i) => {
        const el = document.getElementById(i) as HTMLSelectElement;
        return [...el.options].some(o => o.value === '0');
      }, id);
      expect(has0, id + ' 에 뜻 없는 0 이 있다').toBe(false);
    }
  });

  // FR-PIS-23: 탭에 따라 크기가 달라지지 않는다 (FR-UIK-12·13).
  test('PIS19 (V-11): Polling 탭에서도 모달 치수가 같다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page, 'theme');
    const box = (await page.locator('#modal').boundingBox())!;
    await page.locator('.mtab[data-tab="polling"]').click();
    const box2 = (await page.locator('#modal').boundingBox())!;
    expect(Math.round(box2.width)).toBe(Math.round(box.width));
    expect(Math.round(box2.height)).toBe(Math.round(box.height));
  });
});
