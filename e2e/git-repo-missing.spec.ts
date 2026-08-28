import { execFileSync } from 'child_process';
import { realpathSync, rmSync } from 'fs';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_REPO_MISSING_SRS — 소실의 확정과 알림, 그리고 실패 백오프.
// 검증 V-RMS-4~20.

const FIXTURES = '/tmp/dm-git-fx-missing-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

// 소실을 만들려면 지울 수 있는 사본이어야 한다 — 공용 fixture 를 지우면 뒤 테스트가 죽는다.
function copyFx(tag: string) {
  const dst = join(FIXTURES, 'copy-' + tag);
  rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-R', join(FIXTURES, 'basic'), dst]);
  return realpathSync(dst);
}

// 사라진 폴더를 되살린다 — 같은 경로에 같은 내용이 돌아오는 것이 복구다.
function restore(repo: string) {
  execFileSync('cp', ['-R', join(FIXTURES, 'basic'), repo]);
}

async function patchSettings(request: APIRequestContext, patch: Record<string, unknown>) {
  const cur = await (await request.get('/api/settings')).json();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete cur[k];
    else cur[k] = v;
  }
  const r = await request.put('/api/settings', { data: cur });
  expect(r.ok(), `설정 저장 실패: ${await r.text()}`).toBeTruthy();
}

const defaultIntervals = (request: APIRequestContext) =>
  patchSettings(request, { gitStatusInterval: undefined, gitSignatureInterval: undefined });

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
}

function counter(page: Page, needle: string) {
  const state = { n: 0 };
  page.on('request', (r) => { if (r.url().includes(needle)) state.n++ });
  return state;
}

/**
 * 소실이 화면에 오르기까지의 대기 상한.
 *
 * 감지는 status 폴링(기본 1초)이 하고, 그 사이에 서버의 git 실행과 실패 확정이
 * 낀다. 20 초로는 **전체 스위트를 돌릴 때** 이따금 놓쳤다 — 단독으로는 3회
 * 연속 통과하는데 590여 케이스 사이에 끼면 하나씩 걸렸고, 걸리는 케이스가 매번
 * 달랐다(M1·M2·M5). 폴링 횟수가 모자란 것이 아니라 부하로 각 회차가 밀린다.
 * 성공하면 즉시 통과하므로 상한을 늘리는 비용은 실패할 때뿐이다.
 */
const MISSING_WAIT_MS = 45000;

/**
 * 소실이 확정된 **뒤**의 UI 대기 상한.
 *
 * 소실 자체를 기다리는 것(MISSING_WAIT_MS)과 나누는 이유는 근거가 다르기
 * 때문이다 — 이쪽은 이미 확정된 상태를 화면이 따라잡는 시간이다. 그래도 10초는
 * 전체 스위트 부하에서 모자랐다 (M5).
 */
const UI_WAIT_MS = 20000;

const missing = (page: Page) => page.locator('#area .pn-body .git-missing');
const gitTab = (page: Page, view: string) => page.locator(`#area .pn-tab[data-git-view="${view}"]`);

test.describe('GIT_REPO_MISSING — 소실의 확정과 알림', () => {
  test('M1 (V-RMS-4·5): 활성 리포의 폴더가 사라지면 목록 대신 소실 안내가 뜬다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = copyFx('m1');
    await waitForInit(page);
    await openGit(page, repo);

    const view = page.locator('#area .pn-body .git-view.git-changes');
    await expect(view.locator('.git-head-repo')).toHaveAttribute('title', repo);

    rmSync(repo, { recursive: true, force: true });

    await expect(missing(page)).toBeVisible({ timeout: MISSING_WAIT_MS });
    // 사유와 경로가 함께 보여야 "사라졌다는 표시가 참인지" 판정할 수 있다.
    await expect(missing(page).locator('.git-missing-path')).toHaveText(repo);
    await expect(missing(page).locator('.git-missing-reason')).toContainText('repo_missing');
    // 사라진 폴더의 파일 목록이 남아 있으면 안 된다 (FR-RMS-6).
    await expect(page.locator('#area .pn-body .git-file')).toHaveCount(0);
  });

  test('M2 (V-RMS-12): 소실돼도 활성 리포는 해제되지 않는다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = copyFx('m2');
    await waitForInit(page);
    await openGit(page, repo);
    await expect(page.locator('#area .pn-body .git-view.git-changes .git-head-repo'))
      .toHaveAttribute('title', repo);

    rmSync(repo, { recursive: true, force: true });
    await expect(missing(page)).toBeVisible({ timeout: MISSING_WAIT_MS });

    // 해제하면 복구할 대상을 잃는다 (D-RMS-5).
    expect(await page.evaluate(() => (window as any).app.gitPanel.repo)).toBe(repo);
  });

  test('M3 (V-RMS-13): 7개 탭 전부가 소실을 보인다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = copyFx('m3');
    await waitForInit(page);
    await openGit(page, repo);
    rmSync(repo, { recursive: true, force: true });
    await expect(missing(page)).toBeVisible({ timeout: MISSING_WAIT_MS });

    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees']) {
      await gitTab(page, v).click();
      await expect(missing(page), `${v} 탭이 소실을 보이지 않는다`).toBeVisible({ timeout: 5000 });
      // 문구가 탭마다 다르면 블록을 만드는 자리가 하나가 아니다 (V-RMS-15).
      await expect(missing(page).locator('.git-missing-path')).toHaveText(repo);
    }
  });

  test('M4 (V-RMS-8·14): 폴더가 돌아오면 개입 없이 목록과 탭이 되살아난다', async ({ page, request }) => {
    // 복구는 소실 주기(30초)를 실제로 기다린다 — 기본 테스트 타임아웃보다 길다.
    // 주기를 줄여 흉내 내면 "개입 없이 돌아온다" 를 검증한 것이 아니게 된다.
    test.setTimeout(120_000);
    await defaultIntervals(request);
    const repo = copyFx('m4');
    await waitForInit(page);
    await openGit(page, repo);
    rmSync(repo, { recursive: true, force: true });
    await expect(missing(page)).toBeVisible({ timeout: MISSING_WAIT_MS });

    restore(repo);

    // 소실 주기가 30초이므로 그 안에 와야 한다 — 사용자가 아무것도 누르지 않는다.
    await expect(missing(page)).toHaveCount(0, { timeout: 60000 });
    await expect(page.locator('#area .pn-body .git-view.git-changes .git-head-repo'))
      .toHaveAttribute('title', repo, { timeout: UI_WAIT_MS });

    // 다른 탭도 제 내용으로 돌아온다.
    await gitTab(page, 'branches').click();
    await expect(page.locator('#area .pn-body .git-view.git-branches')).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(missing(page)).toHaveCount(0);
  });

  test('M5 (V-RMS-6·7): 핀된 리포에는 핀 제거가 있고, 누르면 목록에서 빠진다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = copyFx('m5');
    const unpinned = copyFx('m5b');
    await waitForInit(page);

    // 핀하지 않은 리포가 사라지면 진입점이 없다 — 없는 핀을 지우는 버튼은
    // 거짓말이다 (FR-RMS-10).
    await openGit(page, unpinned);
    rmSync(unpinned, { recursive: true, force: true });
    await expect(missing(page)).toBeVisible({ timeout: MISSING_WAIT_MS });
    await expect(missing(page).locator('.git-missing-unpin')).toHaveCount(0);

    // 핀은 **살아 있을 때** 한다 — 서버가 경로를 검증하므로 사라진 뒤에는 핀할 수
    // 없다. 실제 흐름도 그렇다: 핀해 둔 리포가 나중에 사라진다.
    await page.evaluate((r) => (window as any).app._gitPin(r), repo);
    await page.evaluate((r) => (window as any).app.gitPanel.setRepo(r), repo);
    await expect(page.locator('#area .pn-body .git-view.git-changes .git-head-repo'))
      .toHaveAttribute('title', repo, { timeout: UI_WAIT_MS });

    rmSync(repo, { recursive: true, force: true });
    await expect(missing(page)).toBeVisible({ timeout: MISSING_WAIT_MS });
    await expect(missing(page).locator('.git-missing-unpin')).toBeVisible({ timeout: UI_WAIT_MS });

    await missing(page).locator('.git-missing-unpin').click();
    await expect.poll(async () => {
      const d = await (await page.request.get('/api/git/repos')).json();
      return (d.pinned || []).some((p: any) => p.path === repo);
    }, { timeout: UI_WAIT_MS }).toBe(false);
  });

  test('M6 (V-RMS-11): 사이드바 핀 행이 읽을 수 있는 사유를 보인다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = copyFx('m6');
    await waitForInit(page);
    await page.evaluate((r) => (window as any).app._gitPin(r), repo);
    const row = page.locator(`#git-repos .git-repo[data-git-repo="${repo}"]`);
    await expect(row).toHaveCount(1, { timeout: UI_WAIT_MS });

    rmSync(repo, { recursive: true, force: true });

    // 사유 코드가 아니라 사람이 읽는 문구다 (FR-RMS-17).
    await expect(row).toHaveAttribute('title', /폴더가 없습니다/, { timeout: UI_WAIT_MS });
    await expect(row).toHaveClass(/norepo/);
  });

  test('M7 (V-RMS-9): 소실 상태에서는 status 폴링이 30초 쪽으로 낮아진다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = copyFx('m7');
    await waitForInit(page);
    await openGit(page, repo);
    rmSync(repo, { recursive: true, force: true });
    await expect(missing(page)).toBeVisible({ timeout: MISSING_WAIT_MS });

    const c = counter(page, '/api/git/status');
    await page.waitForTimeout(5000);
    // 기준(1초)이면 5회다. 30초 주기면 0회에 가깝다.
    expect(c.n, '소실 상태인데 매초 요청이 나간다').toBeLessThanOrEqual(1);
  });
});

test.describe('GIT_REPO_MISSING — 실패 백오프', () => {
  // 소실이 아닌 일반 실패를 만든다 — 라우트로 500/git_failed 를 돌려준다.
  async function failStatus(page: Page, on: () => boolean) {
    await page.route('**/api/git/status*', async (route) => {
      if (!on()) { await route.continue(); return }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'git_failed', message: 'boom' }),
      });
    });
  }

  test('B1 (V-RMS-16): 연속 실패가 쌓이면 요청 간격이 늘어난다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = copyFx('b1');
    await waitForInit(page);
    let failing = false;
    await failStatus(page, () => failing);
    await openGit(page, repo);
    await expect(page.locator('#area .pn-body .git-view.git-changes .git-head-repo'))
      .toHaveAttribute('title', repo, { timeout: UI_WAIT_MS });

    failing = true;
    const c = counter(page, '/api/git/status');
    await page.waitForTimeout(7000);
    // 백오프가 없으면 1초 주기로 7회다. 2·4·8… 로 늘면 3~4회에 그친다.
    expect(c.n, '실패가 이어지는데 주기가 그대로다').toBeLessThanOrEqual(4);
    expect(c.n, '아예 멈춰 버렸다 — 백오프는 중단이 아니다').toBeGreaterThanOrEqual(1);
  });

  test('B2 (V-RMS-17): 실패가 그치면 주기가 즉시 기준으로 돌아온다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = copyFx('b2');
    await waitForInit(page);
    let failing = false;
    await failStatus(page, () => failing);
    await openGit(page, repo);
    await expect(page.locator('#area .pn-body .git-view.git-changes .git-head-repo'))
      .toHaveAttribute('title', repo, { timeout: UI_WAIT_MS });

    failing = true;
    await page.waitForTimeout(6000);
    failing = false;
    // 사용자의 계기는 백오프를 기다리지 않는다 (V-RMS-19) — 이것으로 성공 하나를 만든다.
    await page.evaluate(() => (window as any).app.gitPanel.refresh());

    const c = counter(page, '/api/git/status');
    await page.waitForTimeout(3000);
    // 기준(1초)으로 돌아왔으면 3회 안팎이다.
    expect(c.n, '성공했는데 주기가 기준으로 돌아오지 않았다').toBeGreaterThanOrEqual(2);
  });

  test('B3 (V-RMS-18·26): 주기 0 은 백오프에도 0 이고, 소실은 고정 주기다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = copyFx('b3');
    await waitForInit(page);
    await openGit(page, repo);

    const got = await page.evaluate(() => {
      const p = (window as any).app.gitPanel;
      const out: any = {};
      // 기준 1000/500, 실패 없음
      p._missing = null; p._failStreak = 0;
      out.base = p._cadence(1000, 500);
      // 연속 실패 2회 → 4배
      p._failStreak = 2;
      out.backoff = p._cadence(1000, 500);
      // 상한을 넘지 않는다
      p._failStreak = 20;
      out.capped = p._cadence(1000, 500);
      // 기준 0 은 0 으로 남는다 (꺼 둔 계층을 되살리지 않는다)
      out.off = p._cadence(0, 0);
      // 소실은 고정 주기다 — 백오프로 점증하지 않는다
      p._missing = '/gone'; p._failStreak = 20;
      out.missing = p._cadence(1000, 500);
      out.missingOff = p._cadence(0, 0);
      p._missing = null; p._failStreak = 0;
      return out;
    });

    expect(got.base).toEqual({ st: 1000, sig: 500 });
    expect(got.backoff).toEqual({ st: 4000, sig: 2000 });
    expect(got.capped).toEqual({ st: 30000, sig: 30000 });
    expect(got.off, '꺼 둔 계층이 백오프로 되살아났다').toEqual({ st: 0, sig: 0 });
    expect(got.missing, '소실인데 고정 주기가 아니다').toEqual({ st: 30000, sig: 30000 });
    expect(got.missingOff, '소실이 꺼 둔 계층을 되살렸다').toEqual({ st: 0, sig: 0 });
  });

  test('B4 (V-RMS-20): 관측이 주기를 바꿔도 관측이 관측을 부르지 않는다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = copyFx('b4');
    await waitForInit(page);
    let failing = false;
    await failStatus(page, () => failing);
    await openGit(page, repo);
    await expect(page.locator('#area .pn-body .git-view.git-changes .git-head-repo'))
      .toHaveAttribute('title', repo, { timeout: UI_WAIT_MS });

    // 실패 → 성공 → 실패 로 주기를 세 번 바꾼다. 재평가가 즉시 수집을 부르면
    // 그때마다 요청이 한 벌씩 더 붙어 폭주한다.
    const c = counter(page, '/api/git/status');
    for (let i = 0; i < 3; i++) {
      failing = !failing;
      await page.waitForTimeout(1200);
    }
    // 1초 주기로 3.6초면 4회 안팎이다. 재귀가 있으면 그보다 훨씬 많다.
    expect(c.n, '주기 재평가가 관측을 연쇄시켰다').toBeLessThanOrEqual(8);
  });
});
