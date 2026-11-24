import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, makeCopyFx, openGit, clickGitView, waitForInit, gitFixture, cleanGitFixture,
} from './fixtures';
import { tmpPath, realPath } from './osenv';

/**
 * GIT_REFRESH_LIFECYCLE_SRS §5 — V-GRF-1·3·5~7·14. V-GRF-2·4 는 단위 시험이다
 * (`web/js/test/git-poll-cadence.test.mjs`·`git-history-timeout.test.mjs`).
 *
 * `11-git-polling.md` 가 확정한 **갱신 계층**의 결함들이다. 공통 성질은 하나다:
 * *한 번 멈추면 스스로 돌아오지 않고, 멈춘 사실이 화면에 없다.*
 *
 * 재는 방식도 공통이다 — **증상의 확률이 아니라 그 상위 성질**을 잰다. 멈춘
 * 상태를 인위적으로 세우고 거기서 빠져나오는지 본다.
 */

const FIXTURES = tmpPath('otter-git-fx-grf-' + process.pid);

test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });

const fx = (name: string) => realPath(join(FIXTURES, name));
const copyFx = makeCopyFx(FIXTURES);

function counter(page: Page, needle: string) {
  const state = { n: 0 };
  page.on('request', (r) => { if (r.url().includes(needle)) state.n++ });
  return state;
}

// 묶음 A(감시견의 첫 관측)는 감시견과 함께 사라졌다 — 관측은 채널의 `git:<root>` 토픽이다
// (PERF_OPTIMIZATION_SRS M1 C4).

// ── 묶음 B — 복귀 (GP-3) ──────────────────────────────────────────────────

test.describe('FR-GRF 묶음 B — git 이 돌아온다', () => {
  test('V-GRF-3: 성공한 관측 하나가 git_missing 을 풀고 자동 갱신을 되살린다',
    async ({ page, request }) => {
      await waitForInit(page);
      await openGit(page, fx('basic'));

      // git 을 찾지 못한 응답 하나가 관측기를 잠근다.
      const locked = await page.evaluate(() => {
        const p = (window as any).app.gitPanel;
        p._gitMissing = true;
        return { missing: p._gitMissing, pollOk: p.poll._pollOk() };
      });
      expect(locked.missing).toBe(true);
      expect(locked.pollOk, '_gitMissing 인데 폴링 조건이 참이다').toBe(false);

      // 성공한 관측 하나. 종전에는 이 자리에 해제가 없어 페이지 수명 내내 잠겼다.
      await page.evaluate(() => (window as any).app.gitPanel.viewReload.refresh());
      await expect.poll(
        () => page.evaluate(() => {
          const p = (window as any).app.gitPanel;
          // 자동 갱신은 주기 타이머가 아니라 `git:<root>` 토픽 구독이다 (PERF_OPTIMIZATION_SRS M1 C4).
          return { missing: p._gitMissing, armed: !!p.obs._gitTopic };
        }),
        { timeout: 20000 },
      ).toEqual({ missing: false, armed: true });
    });
});

// ── 묶음 C — 시한 (GP-5) ──────────────────────────────────────────────────
//
// V-GRF-4 (FR-GRF-6) 는 기본 시한 20초(`GIT_STATUS_FETCH_TIMEOUT_MS`)를 실제로 기다렸다 —
// 같은 경로를 상수만 줄여 지나는 단위 시험으로 옮겼다 (`web/js/test/git-history-timeout.test.mjs`).

// ── 묶음 D — 낡음 표시 (GP-4) ──────────────────────────────────────────────

test.describe('FR-GRF 묶음 D — 낡음은 모든 탭에서 보인다', () => {
  const note = (page: Page) =>
    page.locator('#area .pn-body .git-view.vis .git-stale-note.vis');

  test('V-GRF-5: History 탭을 연 채 관측이 실패하면 그 탭에 배너가 뜬다',
    async ({ page, request }) => {
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
      // **예외 (`TEST-16`)**: 요청이 **나가지 않음**을 잰다. 숨지 않았다면 방송은
      // 그 자리에서(동기) 수집하므로 창은 그 요청이 도착할 한 박자면 된다.
      await page.waitForTimeout(300);
      expect(c.n - before, '숨었는데 방송이 요청을 냈다').toBe(0);

      // 돌아오면 갚는다 (D-GRF-7) — 가시성 복귀 신호가 수집으로 간다.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        (window as any).app.testing.gitSignal('test');
      });
      await expect.poll(() => c.n - before, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
    });
});
