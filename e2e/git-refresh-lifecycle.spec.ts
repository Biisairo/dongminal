import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import {
  test, expect, makeCopyFx, openGit, clickGitView, waitForInit, gitFixture, cleanGitFixture,
} from './fixtures';
import { tmpPath, realPath } from './osenv';

/**
 * GIT_REFRESH_LIFECYCLE_SRS §5 — V-GRF-1~7·14.
 *
 * `11-git-polling.md` 가 확정한 **갱신 계층**의 결함들이다. 공통 성질은 하나다:
 * *한 번 멈추면 스스로 돌아오지 않고, 멈춘 사실이 화면에 없다.*
 *
 * 재는 방식도 공통이다 — **증상의 확률이 아니라 그 상위 성질**을 잰다. 멈춘
 * 상태를 인위적으로 세우고 거기서 빠져나오는지 본다.
 */

const FIXTURES = tmpPath('dm-git-fx-grf-' + process.pid);

test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });

const fx = (name: string) => realPath(join(FIXTURES, name));
const copyFx = makeCopyFx(FIXTURES);

async function patchSettings(request: APIRequestContext, patch: Record<string, unknown>) {
  const cur = await (await request.get('/api/settings')).json();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete cur[k]; else cur[k] = v;
  }
  const r = await request.put('/api/settings', { data: cur });
  expect(r.ok(), `설정 저장 실패: ${await r.text()}`).toBeTruthy();
}
const defaultIntervals = (request: APIRequestContext) =>
  patchSettings(request, { gitStatusInterval: undefined });

function counter(page: Page, needle: string) {
  const state = { n: 0 };
  page.on('request', (r) => { if (r.url().includes(needle)) state.n++ });
  return state;
}

// ── 묶음 A — 첫 관측 (GP-2) ────────────────────────────────────────────────

test.describe('FR-GRF 묶음 A — 첫 관측', () => {
  test('V-GRF-1: 주기 0 에서 한 번도 관측이 없으면 워치독이 1회 수집한다',
    async ({ page, request }) => {
      await patchSettings(request, { gitStatusInterval: 0 });
      await waitForInit(page);
      await openGit(page, fx('basic'));

      /**
       * `11 GP-2` 가 확정한 그 상태를 인위적으로 세운다.
       *
       * `_pollOn=true, _pollSt=0` 이 한 번 서면 `_applyCadence` 의
       * `if(this._pollOn&&this._pollSt===st) return false` 때문에 그 뒤의 모든
       * `_reschedule()` 이 거짓을 돌려준다. 주기 0 이라 타이머도 없다 — 남는
       * 계기는 포커스와 새로고침 버튼뿐이고, 종전 워치독은 `st<=0` 에서 통째로
       * 물러났으므로 status 는 **0건**이었다.
       */
      await page.evaluate(() => {
        const p = (window as any).app.gitPanel;
        p._lastObsAt = 0;      // 한 번도 관측 없음
        p._wdTryAt = 0;
        p._pollOn = true; p._pollSt = 0;
      });

      const c = counter(page, '/api/git/status');
      // 워치독은 `GIT_WATCHDOG_CHECK_MS`(1초)마다 돈다.
      await expect.poll(() => c.n, { timeout: 10000 })
        .toBeGreaterThanOrEqual(1);
      await defaultIntervals(request);
    });

  test('V-GRF-2: 그 1회 뒤에도 주기 타이머는 서지 않는다',
    async ({ page, request }) => {
      await patchSettings(request, { gitStatusInterval: 0 });
      await waitForInit(page);
      await openGit(page, fx('basic'));
      await page.evaluate(() => {
        const p = (window as any).app.gitPanel;
        p._lastObsAt = 0; p._wdTryAt = 0; p._pollOn = true; p._pollSt = 0;
      });
      const c = counter(page, '/api/git/status');
      await expect.poll(() => c.n, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
      // 사용자가 끈 것은 **주기**다. 되살리지 않는다 (FR-GRF-2).
      const armed = await page.evaluate(() => !!(window as any).app.gitPanel._stPoll);
      expect(armed, '주기 0 인데 타이머가 걸렸다').toBe(false);
      const after = c.n;
      // **예외 (`TEST-16`)**: 요청이 **되풀이되지 않음**을 재는 창이다.
      await page.waitForTimeout(3000);
      expect(c.n - after, '주기 0 인데 요청이 되풀이된다').toBeLessThanOrEqual(1);
      await defaultIntervals(request);
    });
});

// ── 묶음 B — 복귀 (GP-3) ──────────────────────────────────────────────────

test.describe('FR-GRF 묶음 B — git 이 돌아온다', () => {
  test('V-GRF-3: 성공한 관측 하나가 git_missing 을 풀고 자동 갱신을 되살린다',
    async ({ page, request }) => {
      await defaultIntervals(request);
      await waitForInit(page);
      await openGit(page, fx('basic'));

      // git 을 찾지 못한 응답 하나가 관측기를 잠근다.
      const locked = await page.evaluate(() => {
        const p = (window as any).app.gitPanel;
        p._gitMissing = true;
        return { missing: p._gitMissing, pollOk: p._pollOk() };
      });
      expect(locked.missing).toBe(true);
      expect(locked.pollOk, '_gitMissing 인데 폴링 조건이 참이다').toBe(false);

      // 성공한 관측 하나. 종전에는 이 자리에 해제가 없어 페이지 수명 내내 잠겼다.
      await page.evaluate(() => (window as any).app.gitPanel.refresh());
      await expect.poll(
        () => page.evaluate(() => {
          const p = (window as any).app.gitPanel;
          return { missing: p._gitMissing, armed: !!p._stPoll };
        }),
        { timeout: 20000 },
      ).toEqual({ missing: false, armed: true });
    });
});

// ── 묶음 C — 시한 (GP-5) ──────────────────────────────────────────────────

test.describe('FR-GRF 묶음 C — 무응답 연결', () => {
  // 기본 시한이 20초다. 그것이 **기본으로 붙는지**가 검사 대상이므로 짧은 값을
  // 주입하지 않는다 — 주입하면 "호출자가 주면 걸린다" 만 재게 된다.
  test('V-GRF-4: 응답하지 않는 연결에서 History 의 잠금이 시한 뒤 풀린다',
    async ({ page, request }) => {
      test.setTimeout(90_000);
      await defaultIntervals(request);
      await waitForInit(page);
      await openGit(page, fx('many-commits'));
      await clickGitView(page, 'history');

      // 블랙홀. 응답도 거부도 오지 않는다 — `11 GP-5` 가 적은 터널 끊김·프록시
      // 중단의 모양이다. `abort` 가 아니라 **아무것도 하지 않는** 것이 요점이다.
      const held: any[] = [];
      await page.route('**/api/git/log**', (route) => { held.push(route) });

      await page.evaluate(() => {
        const h = (window as any).app.gitPanel._historyView;
        h._ver = (h._ver || 0) + 1;   // 같은 요청으로 접히지 않게 한다
        h.reload();
      });
      await expect.poll(
        () => page.evaluate(() => !!(window as any).app.gitPanel._historyView._loading),
        { timeout: 5000 }).toBe(true);

      // 종전에는 여기서 영원히 참이었다 — `finally` 가 실행되지 않는다.
      await expect.poll(
        () => page.evaluate(() => !!(window as any).app.gitPanel._historyView._loading),
        { timeout: 45_000 }).toBe(false);
      await page.unroute('**/api/git/log**');
      for (const r of held) { try { await r.abort() } catch { /* 이미 끝났다 */ } }
    });
});

// ── 묶음 D — 낡음 표시 (GP-4) ──────────────────────────────────────────────

test.describe('FR-GRF 묶음 D — 낡음은 모든 탭에서 보인다', () => {
  const note = (page: Page) =>
    page.locator('#area .pn-body .git-view.vis .git-stale-note.vis');

  test('V-GRF-5: History 탭을 연 채 관측이 실패하면 그 탭에 배너가 뜬다',
    async ({ page, request }) => {
      await defaultIntervals(request);
      await waitForInit(page);
      await openGit(page, fx('basic'));
      await clickGitView(page, 'history');
      await expect(note(page)).toHaveCount(0);

      // 망 실패 하나. 종전에는 Changes 로 돌아가야만 사유가 보였다.
      await page.evaluate(() => {
        const p = (window as any).app.gitPanel;
        p._staleNote = true;
        p.obs.paintAll();
      });
      await expect(note(page)).toBeVisible({ timeout: 10000 });
      await expect(note(page)).not.toHaveClass(/loading/);
    });

  test('V-GRF-5b: Branches·Stash·Console 에도 같은 배너가 선다',
    async ({ page, request }) => {
      await defaultIntervals(request);
      await waitForInit(page);
      await openGit(page, fx('basic'));
      for (const v of ['branches', 'stash', 'console']) {
        await clickGitView(page, v);
        await page.evaluate(() => {
          const p = (window as any).app.gitPanel;
          p._staleNote = true;
          p.obs.paintAll();
        });
        await expect(note(page), `${v} 탭에 낡음 배너가 없다`)
          .toBeVisible({ timeout: 10000 });
      }
    });

  test('V-GRF-6: 소실 안내가 있으면 낡음 배너는 뜨지 않는다',
    async ({ page, request }) => {
      await defaultIntervals(request);
      await waitForInit(page);
      await openGit(page, fx('basic'));
      await clickGitView(page, 'history');
      await page.evaluate(() => {
        const p = (window as any).app.gitPanel;
        p._staleNote = true;
        p._missing = p.repo;       // 소실은 확정된 사실이다
        p.obs.paintAllViews();
        p.obs.paintAll();
      });
      // 소실 안내가 이긴다 (FR-GRF-12). 둘을 겹쳐 보이지 않는다.
      await expect(note(page)).toHaveCount(0);
    });
});

// ── 묶음 E — 사이드 재사용 (GP-6) ──────────────────────────────────────────

test.describe('FR-GRF 묶음 E — 사이드는 render 를 넘어 산다', () => {
  test('V-GRF-7: 커밋 메시지 입력 중 render 가 와도 커서가 유지된다',
    async ({ page, request }) => {
      await defaultIntervals(request);
      const repo = copyFx('basic', 'grf-side');
      await waitForInit(page);
      await openGit(page, repo);
      const ta = page.locator('#area .ed-side .git-commit textarea');
      await expect(ta).toBeVisible({ timeout: 20000 });
      await ta.click();
      await ta.fill('hello');
      await expect(ta).toBeFocused();

      // 바깥 계기의 전체 render. 종전에는 `_rSide` 가 사이드를 새로 만들고
      // `.git-view` 를 새 부모로 옮겨, 그 한 번에 포커스가 사라졌다.
      await page.evaluate(() => (window as any).app.render());
      await expect(ta, 'render 한 번에 커서를 잃었다').toBeFocused();
      // 그리고 입력값도 그대로다.
      await expect(ta).toHaveValue('hello');
    });

  test('V-GRF-7b: 진입점 버튼과 사이드 골격이 render 를 넘어 같은 요소다',
    async ({ page, request }) => {
      await defaultIntervals(request);
      await waitForInit(page);
      await openGit(page, fx('basic'));
      const sel = '#area .ed-side';
      await expect(page.locator(sel)).toBeVisible({ timeout: 20000 });
      const n = await page.evaluate(() => {
        const els = [...document.querySelectorAll(
          '#area .ed-side, #area .ed-side-tabs, #area .ed-side-body, #area .ed-side-act')];
        for (const e of els) (e as any).__sideMark = 1;
        return els.length;
      });
      expect(n).toBeGreaterThan(0);
      await page.evaluate(() => (window as any).app.render());
      const got = await page.evaluate(() => {
        const els = [...document.querySelectorAll(
          '#area .ed-side, #area .ed-side-tabs, #area .ed-side-body, #area .ed-side-act')];
        return { kept: els.filter(e => (e as any).__sideMark === 1).length, total: els.length };
      });
      expect(got).toEqual({ kept: n, total: n });
    });
});

// ── 묶음 I — 절약 (GP-12) ─────────────────────────────────────────────────

test.describe('FR-GRF 묶음 I — 숨은 탭', () => {
  test('V-GRF-14: 숨어 있으면 방송에 수집하지 않는다',
    async ({ page, request }) => {
      await defaultIntervals(request);
      await waitForInit(page);
      await openGit(page, fx('basic'));
      const c = counter(page, '/api/git/status');
      const before = c.n;
      // `document.hidden` 을 참으로 만든다 — 러너에서 실제로 탭을 숨길 수 없으므로
      // 그 값 자체를 덮는다. 판정이 읽는 것이 그것이다.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        const a = (window as any).app;
        a.testing.onGitChanged({ repo: a.gitPanel.repo, mark: 'grf-hidden-1' });
      });
      // **예외 (`TEST-16`)**: 요청이 **나가지 않음**을 잰다.
      await page.waitForTimeout(1000);
      expect(c.n - before, '숨었는데 방송이 요청을 냈다').toBe(0);

      // 돌아오면 갚는다 (D-GRF-7) — 가시성 복귀 신호가 수집으로 간다.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        (window as any).app.testing.gitSignal('test');
      });
      await expect.poll(() => c.n - before, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
    });
});
