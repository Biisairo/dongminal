import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, clickGitView, openGit, gitFixture, cleanGitFixture, copyDir, freshDir } from './fixtures';
import { tmpPath, realPath } from './osenv';

/**
 * PERFORMANCE_HARDENING_SRS 묶음 P-A — **폴링이 목록을 통째로 갈아 끼우지 않는다**
 * (FR-PRF-10~12 · TC-PRF-1·2 · `refactor/README.md` §4.1 항목 6).
 *
 * ## 이 검사가 알아낸 것 — 감사의 전제가 절반만 참이다
 *
 * 감사는 *"폴링 회차마다 목록 전면 교체"* 라 적었다. 실측은 다르다:
 * `panel-poll.js` 의 `_obsSig` 가드가 **관측이 지난 회차와 같으면 `paintAll()`
 * 자체를 부르지 않는다.** 그 아래에 있는 자리들은 값이 그대로인 회차에 애초에
 * 그려지지 않는다 — 원격 목록만 예외였다 (`reloadRemotesIfOpen` 은 그 가드 밖의
 * `_reloadViews` 에 있다).
 *
 * 그래서 남는 비용은 **바뀐 회차**에 있다. 파일 하나를 건드리면 관측이 달라지고,
 * 그 순간 refs 사이드바·배지·열린 커밋 상세가 **바뀐 것이 없는데도** 통째로 다시
 * 만들어졌다. 그것이 hover·더블클릭·글자 선택을 끊는다.
 *
 * 그래서 검사가 둘이다:
 *
 *   ① 값이 그대로인 회차 → 변이 **0**
 *   ② 값이 **바뀐** 회차 → 바뀌지 않은 행의 요소가 **살아남는다**
 *
 * ②가 없으면 ①은 "아무것도 안 그린다" 로도 통과한다 — 조용히 낡은 화면이
 * 이 묶음이 만들 수 있는 가장 나쁜 결함이다 (SRS §7).
 *
 * ## 기록은 콜백이 모은다
 *
 * `takeRecords()` 만으로는 세지 못한다 — 회차 사이에 `await` 이 있으면 그
 * 마이크로태스크 체크포인트에서 콜백이 이미 불리고 **큐가 비워진다.** 첫 판이
 * 그랬고 고치기 전 코드에서도 초록이었다 — **아무것도 재지 않는 검사**였다
 * (M6 §4-A-1).
 */

const FIXTURES = tmpPath('dm-perf-repaint-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

/** 픽스처를 복사해 쓴다 — 이 스펙은 저장소에 **쓴다**. */
function scratch(tag: string, from: string) {
  const dir = freshDir(join(FIXTURES, 'copy-' + tag));
  copyDir(join(FIXTURES, from), dir);
  return realPath(dir);
}

/** 관측 회차를 n 번 돌리고 그 사이 `sels` 의 childList 변이를 센다. */
async function mutationsPerRound(page: Page, sels: string[], n = 2) {
  return page.evaluate(async ({ sels, n }) => {
    const app = (window as any).app;
    const els: Element[] = [];
    for (const sel of sels) for (const el of document.querySelectorAll('#area ' + sel)) els.push(el);
    const kids = els.reduce((a, el) => a + el.children.length, 0);
    const recs: MutationRecord[] = [];
    const mo = new MutationObserver((rs) => recs.push(...rs));
    for (const el of els) mo.observe(el, { childList: true });
    for (let i = 0; i < n; i++) await app.gitPanel.refresh();
    recs.push(...mo.takeRecords());
    mo.disconnect();
    return {
      watched: els.length,
      kids,
      changed: recs.reduce((a, r) => a + r.addedNodes.length + r.removedNodes.length, 0),
      where: [...new Set(recs.map((r) => (r.target as Element).className))],
    };
  }, { sels, n });
}

/** `sel` 의 요소마다 표식을 남긴다. 표식은 DOM 밖(속성이 아닌 프로퍼티)이라 다시 만들면 사라진다. */
const mark = (page: Page, sel: string) => page.evaluate((s) => {
  const els = [...document.querySelectorAll('#area ' + s)];
  els.forEach((el, i) => { (el as any).__dmMark = 'm' + i });
  return els.length;
}, sel);

/** 표식이 남아 있는 요소의 수. */
const kept = (page: Page, sel: string) => page.evaluate((s) => {
  const els = [...document.querySelectorAll('#area ' + s)];
  return { total: els.length, kept: els.filter((el) => (el as any).__dmMark !== undefined).length };
}, sel);

const refresh = (page: Page) => page.evaluate(() => (window as any).app.gitPanel.refresh());

test.describe('묶음 P-A — 폴링이 목록을 통째로 갈아 끼우지 않는다', () => {
  test('P1 (FR-PRF-12 · TC-PRF-1): 값이 그대로인 회차에 원격 목록의 변이가 0 이다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, scratch('same', 'with-remote'));
    await clickGitView(page, 'branches');
    await expect(page.locator('#area .git-rm-rows .git-rm-row').first()).toBeVisible({ timeout: 20000 });

    const m = await mutationsPerRound(page, ['.git-rm-rows']);
    expect(m.kids, JSON.stringify(m)).toBeGreaterThan(0);
    expect(m, JSON.stringify(m)).toMatchObject({ changed: 0 });
  });

  test('P2 (FR-PRF-11 · TC-PRF-2): 원격 하나가 바뀌어도 나머지 행은 살아남는다', async ({ page }) => {
    const dir = scratch('sig', 'with-remote');
    execFileSync('git', ['-C', dir, 'remote', 'add', 'second', 'https://example.invalid/second.git']);

    await waitForInit(page);
    await openGit(page, dir);
    await clickGitView(page, 'branches');
    await expect(page.locator('#area .git-rm-rows .git-rm-row')).toHaveCount(2, { timeout: 20000 });
    expect(await mark(page, '.git-rm-rows .git-rm-row')).toBe(2);

    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://example.invalid/moved.git']);
    await refresh(page);
    await expect(page.locator('#area .git-rm-row[data-remote="origin"] .git-rm-url'))
      .toHaveText(/moved\.git/, { timeout: 20000 });

    // 바뀐 행은 새 요소이고(표식이 없다), 안 바뀐 행은 그대로다(표식이 남는다).
    const after = await page.evaluate(() => {
      const of = (name: string) =>
        (document.querySelector(`#area .git-rm-row[data-remote="${name}"]`) as any)?.__dmMark ?? null;
      return { origin: of('origin'), second: of('second') };
    });
    expect(after).toEqual({ origin: null, second: 'm1' });
  });

  test('P3 (FR-PRF-10·11 · TC-PRF-2): 관측이 바뀐 회차에도 refs 사이드바의 기존 행이 살아남는다', async ({ page }) => {
    const dir = scratch('refs', 'basic');
    await waitForInit(page);
    await openGit(page, dir);
    await clickGitView(page, 'history');
    const hist = page.locator('#area .pn-body .git-view.git-history');
    await expect(hist.locator('.git-refs .git-ref').first()).toBeVisible({ timeout: 25000 });
    const before = await mark(page, '.git-refs .git-ref');
    expect(before).toBeGreaterThan(0);

    // 관측을 실제로 바꾼다 — 브랜치가 하나 늘면 refs 목록이 달라지고, 종전에는
    // 그 회차에 사이드바가 통째로 다시 만들어졌다.
    execFileSync('git', ['-C', dir, 'branch', 'perf-probe']);
    await refresh(page);
    await expect(hist.locator('.git-refs .git-ref')).toHaveCount(before + 1, { timeout: 20000 });

    const k = await kept(page, '.git-refs .git-ref');
    expect(k).toEqual({ total: before + 1, kept: before });
  });

  test('P4 (FR-PRF-10·11 · TC-PRF-2): 관측이 바뀐 회차에도 상태 머리의 배지가 살아남는다', async ({ page }) => {
    const dir = scratch('badge', 'detached');
    await waitForInit(page);
    await openGit(page, dir);
    await expect(page.locator('#area .git-view.git-changes .git-head-badge').first())
      .toBeVisible({ timeout: 20000 });
    const badges = await mark(page, '.git-view.git-changes .git-head-badge');
    expect(badges).toBeGreaterThan(0);

    // 워킹 트리를 건드리면 관측이 달라진다 — detached 라는 사실은 그대로인데
    // 종전에는 그 회차에 배지 줄이 통째로 다시 만들어졌다.
    writeFileSync(join(dir, 'perf-probe.txt'), 'x\n');
    await refresh(page);
    await expect(page.locator('#area .git-view.git-changes .git-file').first())
      .toBeVisible({ timeout: 20000 });

    expect(await kept(page, '.git-view.git-changes .git-head-badge'))
      .toEqual({ total: badges, kept: badges });
  });

  test('P5 (FR-PRF-10·11 · TC-PRF-2): 열린 커밋 상세를 다시 칠해도 파일 행과 부모 줄이 살아남는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, realPath(join(FIXTURES, 'many-commits')));
    await clickGitView(page, 'history');
    const hist = page.locator('#area .pn-body .git-view.git-history');
    await expect(hist.locator('.git-hist-row').first()).toBeVisible({ timeout: 25000 });
    await hist.locator('.git-hist-row').first().click();
    await expect(hist.locator('.git-hist-detail .git-hist-file').first()).toBeVisible({ timeout: 15000 });

    const files = await mark(page, '.git-hist-detail .git-hist-file');
    const parents = await mark(page, '.git-hist-d-parents .git-hist-d-parent');
    expect(files).toBeGreaterThan(0);

    /**
     * 상세는 **행 창을 다시 그릴 때마다** 다시 칠해진다
     * (`history-rows.js` 의 `_paintRows` 안에서 `_paintDetail` 을 부른다).
     * 창을 다시 그리게 하는 것은 스크롤과 목록 변화이고, 그때 커밋은 그대로다 —
     * 종전에는 그 회차마다 파일 목록과 부모 줄이 통째로 다시 만들어졌다.
     */
    await page.evaluate(() => {
      const h = (window as any).app.gitPanel._historyView;
      for (let i = 0; i < 3; i++) { h._winKey = null; h._paintRows() }
    });

    expect(await kept(page, '.git-hist-detail .git-hist-file'))
      .toEqual({ total: files, kept: files });
    expect(await kept(page, '.git-hist-d-parents .git-hist-d-parent'))
      .toEqual({ total: parents, kept: parents });
  });
});
