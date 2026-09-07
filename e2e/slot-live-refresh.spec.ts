import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, GIT_VIEW_TABS, clickGitView, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath } from './osenv';

// SLOT_VIEW_STATE_SRS §8 M6 — TC-SVS-60~64.
//
// 접수한 말은 둘이다.
//
//   "히스토리 그래프가 변경사항을 바로바로 갱신하지 않아."
//   "다른 슬롯에 갔다가 복귀해야만 업데이트 되는 건 깃·에디터의 모든 창에서
//    포커스가 아니어도 업데이트되도록 해줘."
//
// 규칙은 하나다 — **화면에 있으면 갱신된다.** 포커스는 그 조건이 아니다.

const FIXTURES = tmpPath('dm-git-fx-slr-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

function commit(repo: string, msg: string) {
  appendFileSync(join(repo, 'f.txt'), msg + '\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', msg);
}

async function openGitView(page: Page, repo: string, view: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  // REPO_TAB_UNIFY_SRS: 창의 모양이 바뀌었다 — `Changes` 는 **사이드**에 살고
  // 나머지 여섯 뷰는 **본문 탭**으로 필요할 때 열린다 (FR-RTU-30·32). 스펙들이
  // "탭을 클릭한다" 로 뷰를 고르므로 여기서 여섯을 미리 세운다.
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees', 'submodules']) p.openView(v);
  });
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  // FR-RTU-32: `Changes` 는 본문 탭이 아니라 창의 **사이드**다 — `openGit` 이 이미
  // 그리로 돌려 두었으므로 보이는지만 확인한다.
  if (view === 'changes') {
    await expect(page.locator('#area .ed-side .git-view.git-changes'))
      .toBeVisible({ timeout: 10000 });
    return;
  }
  await clickGitView(page, view);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(
    new RegExp('git-' + view));
}

// Repo 창을 칸 1 에 두고 **칸 0(터미널 창)에 선다.** 접수한 배치 그대로다.
//
// **개정 (REPO_TAB_UNIFY_SRS FR-RTU-70).** 옛 `_gitWindow()` 는 `null` 이다 —
// git 표면을 든 창은 **활성 Repo 창**이며 `openGit` 이 그것을 세워 두었다.
async function splitWithGitAside(page: Page) {
  return page.evaluate(() => {
    const app = (window as any).app;
    const gitWin = app._edWindows().find((w: any) => app._edRootOf(w) === app._gitRootOfActive())
      || app._aw();
    const plain = app._plainWindows()[0];
    app.slotAdd();
    app.slotOpen(0, plain.id);
    app.slotOpen(1, gitWin.id);
    app.slotFocusTo(0);
    app.render();
    return { active: app.ws.activeWindow, git: gitWin.id, plain: plain.id };
  });
}

const histSubjects = (page: Page) =>
  page.locator('.git-view.git-history .git-hist-msg').allTextContents();

/**
 * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-60·65).** `app.gitPanel` 은 **활성 창의**
 * 패널이다 — 이 배치에서 활성 창은 터미널 칸이므로 그것을 읽으면 늘 거짓이다.
 * 재려는 것은 "**눈앞에 있는** Repo 창의 패널이 관측을 계속하는가" 이므로
 * 그 저장소의 패널을 직접 본다.
 */
const pollOk = (page: Page, repo: string, slot = 1) =>
  page.evaluate(([r, n]) => {
    const a = (window as any).app;
    return !!a._gitPanel(r, n)._pollOk();
  }, [repo, slot] as const);

/**
 * 잡지 못했을 때 **무엇 때문인지**를 남긴다 (CI_E2E_MATRIX_SRS FR-CEM-33).
 *
 * 관측이 실패를 누적하면 주기가 기준 × 2ⁿ 으로 늘어 30초 상한에 붙고
 * (`GIT_FAIL_BACKOFF_MAX_MS`), 소실로 판정되면 곧바로 30초다
 * (`GIT_REPO_MISSING_POLL_MS`). 관측의 single-flight 잠금(`_busy`)이 남으면 타이머는
 * 살아 있는데 status 만 멎고, History 의 로딩 잠금(`_loading`)이 남으면 관측은
 * 돌았는데 목록이 그대로다. 그 넷 — 폴링이 멎었다 · 느려졌다 · 잠겼다 · 돌았는데
 * 그리지 않았다 — 은 "배지가 없다" 는 같은 증상으로 보이고, 고치는 자리는 다르다.
 *
 * **그 저장소의 패널을 읽는다** — `app.gitPanel` 은 활성 창의 것이라 터미널 칸에
 * 서 있는 배치(TC-SVS-60)에서는 `repo:null · pollOn:false` 를 말하고, 그것은 결함이
 * 아니라 잘못 읽은 것이다 (러너 실측).
 */
const pollDiag = (page: Page, repo: string, slot = 0) =>
  page.evaluate(([r, n]) => {
    const a = (window as any).app;
    const p = a._gitPanel(r, n);
    if (!p) return null;
    const h = p._historyView;
    return {
      repo: p.repo, failStreak: p._failStreak, missing: p._missing,
      pollOn: p._pollOn, sigMs: p._pollSig, stMs: p._pollSt,
      busy: p._busy, again: p._again, lastSig: p._lastSig, viewFp: p._lastViewFp,
      hist: h ? { loading: h._loading, again: h._again, err: h._err,
        n: (h._commits || []).length, repo: h._repo } : null,
      panels: [...p.obs.panels].map((q: any) => q.root),
      badges: [...document.querySelectorAll('.git-view.git-history .git-hist-badge')]
        .map((e: any) => e.textContent),
    };
  }, [repo, slot] as const);

// 목록에 그 제목이 나타날 때까지 기다린다. 폴링이 멎어 있으면 오지 않는다.
//
// **45초다** (CI_E2E_MATRIX_SRS FR-CEM-31). 관측이 한 번이라도 실패하면 주기가
// 기준 × 2ⁿ 으로 늘어 30초 상한에 붙는다 — 그보다 짧은 예산은 "폴링이 멎었다" 와
// "러너에서 한 번 실패했다" 를 같은 실패로 만든다.
async function waitSubject(page: Page, text: string, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await histSubjects(page)).some((s) => s.includes(text))) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

test.describe('M6 — 보이면 갱신된다', () => {
  test('TC-SVS-60 (FR-SVS-36): 옆 칸의 History 가 포커스 없이도 따라온다', async ({ page }) => {
    const repo = copyFx('with-remote', 'slr-60');
    await waitForInit(page);
    await openGitView(page, repo, 'history');
    await page.waitForSelector('.git-hist-row', { timeout: 20000 });

    const info = await splitWithGitAside(page);
    expect(info.active, '터미널 칸에 서지 않았다 — 전제가 깨졌다').not.toBe(info.git);
    // Git 뷰는 **눈앞에 있다.** 그런데도 관측이 멎던 것이 이 결함이었다.
    await expect(page.locator('.git-view.git-history')).toHaveCount(1);
    expect(await pollOk(page, repo), '보이는데도 관측 조건이 거짓이다').toBe(true);

    commit(repo, 'aside60');
    expect(await waitSubject(page, 'aside60'),
      `옆 칸 History 가 멎어 있다: ${JSON.stringify(await pollDiag(page, repo, 1))}`).toBe(true);
  });

  test('TC-SVS-61 (FR-SVS-39a): 같은 배치에서 Changes 도 따라온다', async ({ page }) => {
    const repo = copyFx('with-remote', 'slr-61');
    await waitForInit(page);
    await openGitView(page, repo, 'changes');
    const info = await splitWithGitAside(page);
    expect(info.active).not.toBe(info.git);

    // 작업 트리를 더럽힌다 — Changes 는 관측(`collect`)이 나르는 자리다.
    appendFileSync(join(repo, 'f.txt'), 'dirty61\n');
    // 폴링이 나르는 자리다 — 예산은 백오프 상한을 견딘다 (FR-CEM-31).
    await expect(page.locator('.git-view.git-changes .git-file[data-path="f.txt"]'))
      .toHaveCount(1, { timeout: 45000 });
  });

  test('TC-SVS-62 (FR-SVS-38): 단일 슬롯의 판정은 종전과 같다', async ({ page }) => {
    const repo = copyFx('with-remote', 'slr-62');
    await waitForInit(page);
    await openGitView(page, repo, 'history');
    // 그 Repo 창이 활성이면 돈다. 단일 슬롯이므로 칸은 0 이다.
    expect(await pollOk(page, repo, 0)).toBe(true);
    // 다른 창으로 가면 돌지 않는다 — 단일 슬롯에서는 그 창이 화면에서 사라진다.
    await page.evaluate(() => {
      const app = (window as any).app;
      const w = app._plainWindows()[0];
      if (w) app.switchWindow(w.id);
    });
    expect(await pollOk(page, repo, 0), '보이지 않는 창을 관측하고 있다').toBe(false);
  });

  test('TC-SVS-64 (FR-SVS-39c): 관측이 낡아도 다음 로드가 돈다', async ({ page }) => {
    const repo = copyFx('with-remote', 'slr-64');
    await waitForInit(page);
    await openGitView(page, repo, 'history');
    await page.waitForSelector('.git-hist-row', { timeout: 20000 });

    // 로그 응답을 붙잡아 두고 그 사이에 관측을 낡게 만든다. 낡음의 근거는 `isStale`
    // 이 보는 **세대**(`_gen`)다 (FR-SVS-39c) — `_seq` 는 status 의 single-flight
    // 일련번호라 로그와 무관하고, 그것을 밖에서 올리면 진행 중인 status 응답이
    // 소유권을 잃어 `_busy` 가 영구히 참으로 남는다 (Windows 러너 실측: 이 자리 뒤
    // 46초 동안 status 요청이 한 건도 없었다).
    await page.route('**/api/git/log**', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    const reloading = page.evaluate(() =>
      (window as any).app.gitPanel._historyView.reload());
    await page.waitForTimeout(150);
    await page.evaluate(() => { (window as any).app.gitPanel._gen++ });
    await reloading.catch(() => {});
    await page.unroute('**/api/git/log**');

    // 잠금이 남으면 이후 모든 로드가 삼켜진다 — 새 커밋이 영영 오지 않는다.
    expect(await page.evaluate(() =>
      !!(window as any).app.gitPanel._historyView._loading),
    '로딩 잠금이 풀리지 않았다').toBe(false);

    commit(repo, 'stale64');
    expect(await waitSubject(page, 'stale64'),
      `목록이 멎었다: ${JSON.stringify(await pollDiag(page, repo))}`).toBe(true);
  });
});

test.describe('M6 — Editor 도 같은 원칙', () => {
  test('TC-SVS-63 (FR-SVS-39b): 보이는 모든 탐색기가 갱신된다', async ({ page, request }) => {
    const repo = copyFx('with-remote', 'slr-63');
    // Editor 목록은 서버가 권위다 (FR-EDT-20) — 행을 만들면 재조정이 창을 만든다.
    const r = await request.post('/api/editors/add', { data: { path: repo } });
    expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();

    await waitForInit(page);
    await page.waitForFunction(
      (root) => ((window as any).app._edWindows() || [])
        .some((w: any) => w.editor && w.editor.root === root),
      repo, { timeout: 20000 });

    // 그 Editor 창을 칸 1 에 놓고 **칸 0(터미널)에 선다.**
    const info = await page.evaluate((root) => {
      const app = (window as any).app;
      const ed = app._edWindows().find((w: any) => w.editor && w.editor.root === root);
      // UX_BATCH6_SRS FR-DSP-1: 사이드의 기본이 Changes 다. 재려는 것은 **탐색기**의
      // 갱신이므로 그 자리를 명시로 연다 — 이 창은 활성이 아니라서 공용
      // `openExplorerSide`(활성 창을 본다)로는 닿지 않는다.
      app._edSetSide(ed, 'explorer');
      const plain = app._plainWindows()[0];
      app.slotAdd();
      app.slotOpen(0, plain.id);
      app.slotOpen(1, ed.id);
      app.slotFocusTo(0);
      app.render();
      return { ed: ed.id, plain: plain.id, active: app.ws.activeWindow };
    }, repo);
    expect(info.active, '터미널 칸에 서지 않았다').not.toBe(info.ed);
    await expect(page.locator('.ed-win .ed-explorer .ed-tree')).toHaveCount(1, { timeout: 15000 });

    // 보이는 트리가 폴링 대상에 들어 있는가 — 활성 창의 것 **하나**가 아니다.
    const n = await page.evaluate(() =>
      ((window as any).app._edVisibleTrees?.() || []).length);
    expect(n, '보이는 탐색기가 폴링 대상에서 빠졌다').toBeGreaterThan(0);
  });
});

// ── GIT_VIEW_REFRESH_SRS §3.2 묶음 R — V-GVR-20·21·26 ──
//
// 접수한 말: *"브랜치 추가/제거 했고, 그래프 옆에 브랜치 리스트는 업데이트 되는데
// 그래프만 안 돼."*
//
// 커밋 행에 붙는 배지도 ref 에서 나오지만 그것은 `git log` 의 decoration 이라
// **목록을 다시 받아야** 갱신된다. 사이드바만 다시 받으면 왼쪽만 바뀐다.

const badges = (page: Page) =>
  page.locator('.git-view.git-history .git-hist-badge').allTextContents();

async function waitBadge(page: Page, name: string, want: boolean, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await badges(page)).includes(name) === want) return true;
    await page.waitForTimeout(400);
  }
  return false;
}


test.describe('묶음 R — 브랜치가 늘고 주는 것도 변화다', () => {
  test('V-GVR-20·21 (FR-GVR-20): UI 로 만든 브랜치가 커밋 행의 배지에 나타나고, 지우면 사라진다', async ({ page }) => {
    const repo = copyFx('with-remote', 'gvr-20');
    await waitForInit(page);
    await openGitView(page, repo, 'history');
    await page.waitForSelector('.git-hist-row', { timeout: 20000 });
    expect(await badges(page), '전제: 그 배지는 아직 없다').not.toContain('r20');

    // dongminal 자신의 쓰기 — `GitBranches._run` 이 `afterRefWrite` 를 부르는
    // 그 경로를 그대로 탄다 (다이얼로그만 건너뛴다).
    const ok = await page.evaluate(async () => {
      const p = (window as any).app.gitPanel;
      const res = await (window as any).GitBranches._run(p, '/api/git/branch', { name: 'r20' });
      return !!(res && res.ok);
    });
    expect(ok, '브랜치 생성 요청이 실패했다').toBe(true);

    expect(await waitBadge(page, 'r20', true),
      'UI 로 만든 브랜치가 커밋 배지에 오지 않는다 — 왼쪽만 갱신됐다').toBe(true);

    // 지우면 사라진다 — 같은 뒷정리를 지나야 한다.
    const gone = await page.evaluate(async () => {
      const p = (window as any).app.gitPanel;
      const res = await (window as any).GitBranches._run(
        p, '/api/git/branch/delete', { names: ['r20'], force: true, confirm: true });
      return !!(res && res.ok);
    });
    expect(gone, '브랜치 삭제 요청이 실패했다').toBe(true);
    expect(await waitBadge(page, 'r20', false), '지운 브랜치의 배지가 남았다').toBe(true);
  });

  test('V-GVR-26 (FR-GVR-21): 터미널에서 만든 브랜치도 폴링이 잡는다', async ({ page }) => {
    // 두 번의 대기가 각각 45초까지 간다 — Windows 의 기본 예산(120초)은 그 둘을
    // 담지 못하고, 넘치면 단정의 진단 대신 timeout 만 남는다.
    test.setTimeout(180_000);
    const repo = copyFx('with-remote', 'gvr-26');
    await waitForInit(page);
    await openGitView(page, repo, 'history');
    await page.waitForSelector('.git-hist-row', { timeout: 20000 });
    expect(await badges(page)).not.toContain('r26');

    // 우리 쓰기가 아니다 — 감지는 signature 가 해야 한다.
    // **45초를 기다린다.** 여기서 재는 것은 "폴링이 잡는가" 이지 "몇 초 안에"
    // 가 아니고, 관측이 한 번이라도 실패하면 주기가 30초 상한까지 늘어난다
    // (`GIT_FAIL_BACKOFF_MAX_MS`) — 20초는 그 한 번을 견디지 못한다.
    git(repo, 'branch', 'r26');
    expect(await waitBadge(page, 'r26', true, 45000),
      `창 밖에서 만든 브랜치를 폴링이 잡지 못했다: ${JSON.stringify(await pollDiag(page, repo))}`).toBe(true);

    git(repo, 'branch', '-D', 'r26');
    expect(await waitBadge(page, 'r26', false, 45000),
      `창 밖에서 지운 브랜치가 배지에 남았다: ${JSON.stringify(await pollDiag(page, repo))}`).toBe(true);
  });
});
