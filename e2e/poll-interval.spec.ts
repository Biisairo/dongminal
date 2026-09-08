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
declare const GIT_REPOS_POLL_MS: number;
declare const GIT_CON_POLL_MS: number;
declare const AGENTS_POLL_DEFAULT: number;
declare const BACKUP_KEYS: { store: string; key: string }[];
declare const TIMERS: { _jobs: Map<string, { nextAt: number }>; refreshChanged(): void };

const FIXTURES = tmpPath('dm-git-fx-pollint-' + process.pid);
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

const POLL_KEYS = ['agentsPollInterval', 'statsInterval', 'gitStatusInterval',
  'gitReposInterval', 'gitConsoleInterval'] as const;

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
  test('PIS1 (V-1): signature 폴링 계층의 이름이 남아 있지 않다', async ({ page }) => {
    await waitForInit(page);
    // `const` 는 window 프로퍼티가 아니므로 전역 식별자로 직접 본다
    // (editor-explorer.spec.ts 의 선례). `var` 인 설정 변수는 프로퍼티다.
    const gone = await page.evaluate(() => ({
      constant: typeof GIT_SIGNATURE_POLL_MS,
      variable: typeof (window as any).gitSignatureInterval,
    }));
    expect(gone.constant).toBe('undefined');
    expect(gone.variable).toBe('undefined');
  });

  /**
   * FR-PIS-2: 저장된 옛 값은 **읽지 않고 버린다.** 남겨도 다시 읽을 계층이
   * 없으므로 아무 일도 하지 않아야 한다 — 그것이 "제거" 의 뜻이다.
   */
  test('PIS2 (V-1): 옛 설정 키를 넣어도 signature 요청이 0건이다', async ({ page, request }) => {
    await patchSettings(request, { gitSignatureInterval: 300 });
    const sig = counter(page, '/api/git/signature');
    await waitForInit(page);
    await openGit(page, fx('basic'));
    await page.waitForTimeout(1500);
    expect(sig.n, '지워진 계층이 되살아났다').toBe(0);
    await clearIntervals(request);
    await patchSettings(request, { gitSignatureInterval: undefined });
  });

  /**
   * FR-PIS-3: 지운 것은 **폴링**이고 지문 자체가 아니다. `_lastSig` 는 status
   * 응답이 실어 오며(`panel-poll.js:384`) 확인창·히스토리·다이얼로그가 그것을 딛는다.
   */
  test('PIS3 (V-2): status 응답이 `_lastSig` 를 채운다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    await expect.poll(async () => page.evaluate(() => {
      const app = (window as any).app;
      for (const o of (app._gitObservers || new Map()).values()) {
        const p = o.any();
        if (p && p._lastSig) return true;
      }
      return false;
    }), { timeout: 15000 }).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('묶음 PIS·설정 — 다섯 주기 (FR-PIS-6~15)', () => {
  test.afterEach(async ({ request }) => { await clearIntervals(request) });

  test('PIS4 (V-4): 다섯 키가 설정에서 화면으로 내려온다', async ({ page, request }) => {
    await patchSettings(request, {
      agentsPollInterval: 10000, statsInterval: 5000, gitStatusInterval: 60000,
      gitReposInterval: 10000, gitConsoleInterval: 5000,
    });
    await waitForInit(page);
    const v = await page.evaluate(() => ({
      agents: (window as any).app.agentsPollMs,
      stats: (window as any).statsInterval,
      gitStatus: (window as any).gitStatusInterval,
      gitRepos: (window as any).gitReposInterval,
      gitConsole: (window as any).gitConsoleInterval,
    }));
    expect(v).toEqual({
      agents: 10000, stats: 5000, gitStatus: 60000, gitRepos: 10000, gitConsole: 5000,
    });
  });

  // FR-PIS-7: 얹는 자리가 하나이므로 SSE 방송도 같은 길을 지난다 (FR-SYN).
  test('PIS5 (V-4): 다른 창에서 바꾼 값이 SSE 로 따라온다', async ({ page, request }) => {
    await waitForInit(page);
    await patchSettings(request, { gitReposInterval: 30000 });
    await expect.poll(() => page.evaluate(() => (window as any).gitReposInterval),
      { timeout: 10000 }).toBe(30000);
  });

  /**
   * FR-PIS-8: 손으로 고친 `settings.json` 하나가 초당 폴링을 만들지 않아야 한다.
   * 범위 밖·정수 아님·음수는 전부 기본값으로 떨어진다.
   */
  test('PIS6 (V-5): 범위 밖 값은 기본값으로 떨어진다', async ({ page, request }) => {
    await patchSettings(request, {
      gitReposInterval: 1, gitConsoleInterval: 'x', agentsPollInterval: -5,
    });
    await waitForInit(page);
    const v = await page.evaluate(() => ({
      repos: (window as any).gitReposInterval,
      con: (window as any).gitConsoleInterval,
      agents: (window as any).app.agentsPollMs,
      dRepos: GIT_REPOS_POLL_MS, dCon: GIT_CON_POLL_MS, dAgents: AGENTS_POLL_DEFAULT,
    }));
    expect(v.repos).toBe(v.dRepos);
    expect(v.con).toBe(v.dCon);
    expect(v.agents).toBe(v.dAgents);
  });

  /**
   * FR-PIS-8a: **미저장 키는 손대지 않는다.**
   *
   * 이 규약이 지키는 것은 사용자 설정이 아니라 **검사와 진단**이다 — 주기를 화면
   * 안에서 직접 줄여 놓고 재는 자리가 여섯 있고(`git-polling` 의 `fastSafetyNet`
   * 등), 그 키가 없는 설정 방송 하나가 그 값을 기본값으로 되돌리면 그 검사들이
   * 타이밍에 따라 무작위로 깨진다.
   */
  test('PIS7a (V-5a): 키 없는 방송은 넣어 둔 값을 지우지 않는다', async ({ page, request }) => {
    await clearIntervals(request);
    await waitForInit(page);
    await page.evaluate(() => { (window as any).gitStatusInterval = 700 });
    // 주기 키가 하나도 없는 설정을 저장한다 — 방송이 오고 `_settingsApply` 가 돈다.
    await patchSettings(request, { pageTitle: 'poll-guard' });
    await expect.poll(() => page.evaluate(() => (window as any).pageTitle),
      { timeout: 10000 }).toBe('poll-guard');
    expect(await page.evaluate(() => (window as any).gitStatusInterval),
      '키 없는 방송이 넣어 둔 주기를 지웠다').toBe(700);
    await patchSettings(request, { pageTitle: undefined });
  });

  /**
   * FR-PIS-9: `0` 은 `gitStatusInterval` 하나에서만 뜻을 갖는다 — 그 계층은
   * 안전망이고 push 가 본줄이다. 나머지 넷은 갱신의 **유일한** 경로여서 끄면
   * 화면이 멎으므로 0 을 받지 않는다.
   */
  test('PIS7 (V-5): 0 은 안전망에서만 뜻을 갖는다', async ({ page, request }) => {
    await patchSettings(request, { gitStatusInterval: 0, gitReposInterval: 0 });
    await waitForInit(page);
    const v = await page.evaluate(() => ({
      gitStatus: (window as any).gitStatusInterval,
      repos: (window as any).gitReposInterval,
      dRepos: GIT_REPOS_POLL_MS,
    }));
    expect(v.gitStatus, '안전망의 0 은 "걸지 않는다" 다').toBe(0);
    expect(v.repos, '유일한 갱신 경로는 끌 수 없다').toBe(v.dRepos);
  });

  /**
   * FR-PIS-12: 파생이 계수로 남았으므로 기준이 바뀌면 **같은 배수로** 따라간다.
   * `const` 로 굳혀 두면 설정을 바꿔도 배지의 낡음 기준과 트리 백오프가 옛 값이다.
   */
  test('PIS8 (V-6): ⑤ 의 파생 둘이 같은 배수로 따라간다', async ({ page, request }) => {
    await waitForInit(page);
    const before = await page.evaluate(() => ({
      base: (window as any).gitReposInterval,
      stale: (window as any).gitBadgeStaleMs(),
      backoff: (window as any).editorGitBackoffMs(),
    }));
    await patchSettings(request, { gitReposInterval: (before.base as number) * 2 });
    await expect.poll(() => page.evaluate(() => (window as any).gitReposInterval),
      { timeout: 10000 }).toBe(before.base * 2);
    const after = await page.evaluate(() => ({
      stale: (window as any).gitBadgeStaleMs(),
      backoff: (window as any).editorGitBackoffMs(),
    }));
    expect(after.stale).toBe(before.stale * 2);
    expect(after.backoff).toBe(before.backoff * 2);
  });

  // FR-PIS-13: 계약이 넓어질 뿐 깨지지 않는다 — 값도 함수도 돈다.
  test('PIS9 (V-7): visiblePoll 이 값과 함수를 둘 다 받는다', async ({ page }) => {
    await waitForInit(page);
    const r = await page.evaluate(async () => {
      const hit = { fixed: 0, fn: 0 };
      let ms = 60;
      const a = (window as any).visiblePoll(60, () => { hit.fixed++ }, { id: 'test.fixed' });
      const b = (window as any).visiblePoll(() => ms, () => { hit.fn++ }, { id: 'test.fn' });
      await new Promise(r => setTimeout(r, 400));
      a.stop(); b.stop();
      return hit;
    });
    expect(r.fixed).toBeGreaterThan(0);
    expect(r.fn).toBeGreaterThan(0);
  });

  /**
   * FR-PIS-14a: 주기가 **실제로 바뀐** job 만 다시 건다. 전부 다시 걸면 설정을
   * 한 번 만질 때마다 모든 폴링의 다음 회차가 뒤로 밀린다.
   */
  test('PIS10 (V-8a): refreshChanged 는 바뀐 job 만 다시 건다', async ({ page }) => {
    await waitForInit(page);
    const r = await page.evaluate(async () => {
      let a = 5000, b = 5000;
      const ha = (window as any).visiblePoll(() => a, () => {}, { id: 'test.ra' });
      const hb = (window as any).visiblePoll(() => b, () => {}, { id: 'test.rb' });
      const at = (id: string) => TIMERS._jobs.get(id).nextAt;
      const was = { a: at('test.ra'), b: at('test.rb') };
      await new Promise(r => setTimeout(r, 50));
      a = 9000;
      TIMERS.refreshChanged();
      const now = { a: at('test.ra'), b: at('test.rb') };
      ha.stop(); hb.stop();
      return { movedA: now.a !== was.a, movedB: now.b !== was.b };
    });
    expect(r.movedA, '바뀐 job 이 다시 걸리지 않았다').toBe(true);
    expect(r.movedB, '안 바뀐 job 의 마감이 밀렸다').toBe(false);
  });

  /**
   * FR-PIS-14: 30초에서 짧게 내리면 **다음 마감부터** 새 주기다. 그리고 내린
   * 순간에는 요청이 나가지 않는다 — 재무장은 발화가 아니다.
   */
  test('PIS11 (V-8): 주기를 내리면 다음 회차가 곧 오고, 내린 순간에는 안 온다',
    async ({ page, request }) => {
      await patchSettings(request, { statsInterval: 30000 });
      await waitForInit(page);
      const stats = counter(page, '/api/stats');
      await page.waitForTimeout(600);
      const base = stats.n;

      await patchSettings(request, { statsInterval: 1000 });
      await expect.poll(() => page.evaluate(() => (window as any).statsInterval),
        { timeout: 10000 }).toBe(1000);
      // 값이 내려온 직후 — 재무장은 발화하지 않는다.
      const atApply = stats.n;
      expect(atApply, '재무장이 즉시 요청을 냈다').toBe(base);
      // 다음 마감은 30초가 아니라 1초 뒤다.
      await expect.poll(() => stats.n, { timeout: 6000 }).toBeGreaterThan(atApply);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('묶음 PIS·이사 — agentsPollMs (FR-PIS-16~19)', () => {
  test.afterEach(async ({ request }) => { await clearIntervals(request) });

  /**
   * FR-PIS-17: 이사는 한 번이고 조용하다. localStorage 의 옛 값이 서버로 올라가고
   * 그 자리에서 사라진다.
   */
  test('PIS12 (V-9): 옛 localStorage 값이 서버로 이사한다', async ({ page, request }) => {
    await clearIntervals(request);
    await waitForInit(page, { beforeGoto: () => localStorage.setItem('agentsPollMs', '10000') });
    await expect.poll(() => page.evaluate(() => (window as any).app.agentsPollMs),
      { timeout: 10000 }).toBe(10000);
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).agentsPollInterval,
      { timeout: 10000 }).toBe(10000);
    expect(await page.evaluate(() => localStorage.getItem('agentsPollMs'))).toBe(null);
  });

  // FR-PIS-17: 서버에 값이 있으면 서버가 이긴다 — 여러 기기가 각자 옛 값을 들고
  // 있을 때 마지막에 뜬 기기가 남의 설정을 덮으면 안 된다.
  test('PIS13 (V-9): 서버에 값이 있으면 서버가 이긴다', async ({ page, request }) => {
    await patchSettings(request, { agentsPollInterval: 3000 });
    await waitForInit(page, { beforeGoto: () => localStorage.setItem('agentsPollMs', '30000') });
    expect(await page.evaluate(() => (window as any).app.agentsPollMs)).toBe(3000);
    expect(await page.evaluate(() => localStorage.getItem('agentsPollMs'))).toBe(null);
  });

  // FR-PIS-18: 서버 설정은 이식 표의 대상이 아니다 — 그 표는 localStorage·
  // sessionStorage 만 담는다 (FR-SPT-3).
  test('PIS14 (FR-PIS-18): BACKUP_KEYS 에서 빠졌다', async ({ page }) => {
    await waitForInit(page);
    const has = await page.evaluate(() =>
      BACKUP_KEYS.some((k: any) => k.key === 'agentsPollMs'));
    expect(has).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('묶음 PIS·화면 — Polling 탭 (FR-PIS-20~25)', () => {
  test('PIS15 (V-10): Polling 탭에 컨트롤 다섯이 나란히 선다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page, 'polling');
    const panel = page.locator('#panel-polling');
    await expect(panel).toBeVisible();
    for (const id of ['pi-agents', 'pi-stats', 'pi-gitstatus', 'pi-gitrepos', 'pi-gitconsole'])
      await expect(panel.locator('#' + id)).toBeVisible();
  });

  /**
   * FR-PIS-22: 같은 값의 손잡이가 두 자리에 있으면 어느 쪽이 진실인지 화면이
   * 말하지 않는다. 옮긴 것이므로 **옛 자리에서 빠져야** 한다.
   */
  test('PIS16 (V-10): 옛 두 자리에는 주기 컨트롤이 없다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page, 'notify');
    await expect(page.locator('#agents-poll')).toHaveCount(0);
    await page.locator('.mtab[data-tab="statusbar"]').click();
    await expect(page.locator('#sb-settings .sbs-select')).toHaveCount(0);
  });

  // FR-PIS-20 의 대칭: 화면에서 고른 값이 서버로 간다.
  test('PIS17 (V-10): 드롭다운을 바꾸면 서버 설정에 실린다', async ({ page, request }) => {
    await waitForInit(page);
    await openSettings(page, 'polling');
    await page.locator('#pi-gitconsole').selectOption('5000');
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).gitConsoleInterval,
      { timeout: 10000 }).toBe(5000);
    expect(await page.evaluate(() => (window as any).gitConsoleInterval)).toBe(5000);
    await clearIntervals(request);
  });

  // FR-PIS-9: 뜻이 없는 자리에는 그 선택지를 두지 않는다 — 설명보다 강하다.
  test('PIS18 (V-5): `끔`(0) 선택지는 안전망에만 있다', async ({ page }) => {
    await waitForInit(page);
    await openSettings(page, 'polling');
    const has0 = (id: string) => page.evaluate((i) => {
      const el = document.getElementById(i) as HTMLSelectElement;
      return [...el.options].some(o => o.value === '0');
    }, id);
    expect(await has0('pi-gitstatus')).toBe(true);
    for (const id of ['pi-agents', 'pi-stats', 'pi-gitrepos', 'pi-gitconsole'])
      expect(await has0(id), id + ' 에 뜻 없는 0 이 있다').toBe(false);
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
