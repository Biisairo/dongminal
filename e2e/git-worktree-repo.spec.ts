import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

/**
 * UX_BATCH5_SRS 묶음 E — 워크트리를 **그 자체 저장소로** 다루는 경로 (FR-WTG-1).
 *
 * 접수한 말은 추정형이었다: "그냥 worktree 를 repo 탭에 추가하면 일반적인 git 이
 * 아니라 처리를 못하는 것 같다." 그래서 이 파일의 일은 고치는 것이 **아니라
 * 확정하는 것**이다 (D-11) — 재현되지 않은 것을 고치면 사용자가 겪은 것과 다른
 * 것을 바꾸게 된다.
 *
 * 이미 확정된 것은 여기서 되풀이하지 않는다:
 *   - Worktrees 탭의 `open` → 그 워크트리의 Repo 창: `git-worktrees.spec.ts` V151
 *     이 `_edRootOf(_aw())` 로 이미 단정하고 통과한다
 *
 * 그래서 남은 셋만 본다: `+ Add` 경로 · 각 뷰가 딛는 기준 · detached 표시.
 *
 * 워크트리의 `.git` 은 **디렉터리가 아니라 파일**(gitdir 포인터)이다. 그것이
 * "일반적인 git 이 아니" 라는 말의 실체이며, 서버가 그것을 견디는지가 이 파일의
 * 물음이다. 근거는 `rev-parse --show-toplevel` 이 워크트리에서 워크트리 자신을
 * 답한다는 것이고(`core/repo.go:17`), signature 는 gitdir 과 common-dir 을 이미
 * 갈라 딛는다 (`core/dirs.go:17`).
 */

const FIXTURES = tmpPath('dm-git-fx-wtrepo-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);

/**
 * `git worktree add` 를 직접 부른다 — 서버 API 를 쓰지 않는다. 사용자가 터미널에서
 * 만든 워크트리를 화면에 들이는 것이 접수한 말의 상황이기 때문이다.
 *
 * `realpath` 하는 이유는 macOS 의 `/tmp` → `/private/tmp` 다 — 서버는 rev-parse 가
 * 준 값을 쓰므로 비교 대상도 같은 형태여야 한다.
 */
function addWorktree(repo: string, name: string, opts: { detached?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dm-wtrepo-'));
  rmSync(dir, { recursive: true, force: true }); // git 이 직접 만들게 둔다
  const args = opts.detached
    ? ['-C', repo, 'worktree', 'add', '--detach', dir, 'HEAD']
    : ['-C', repo, 'worktree', 'add', '-b', name, dir, 'main'];
  execFileSync('git', args, { stdio: 'pipe' });
  return realPath(dir);
}

const made: string[] = [];
const mkWt = (repo: string, name: string, opts?: { detached?: boolean }) => {
  const p = addWorktree(repo, name, opts);
  made.push(p);
  return p;
};
test.afterAll(() => {
  for (const p of made) rmSync(p, { recursive: true, force: true });
});

// 사용자가 `+ Add` 로 하는 일 그대로다 — 사이드바 버튼이 부르는 종단이 이것이다
// (`app-editor.js:919` `_edAdd`).
async function addRepo(request: APIRequestContext, path: string) {
  const r = await request.post('/api/editors/add', { data: { path } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  return r.json();
}

async function openSideChanges(page: Page, root: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), root);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
  });
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const head = (page: Page) => changes(page).locator('.git-head');

test.describe('묶음 E — 워크트리를 저장소로 (FR-WTG-1 확정)', () => {
  /**
   * 확정 ①: `+ Add` 로 워크트리 경로를 넣으면 **저장소로 선다.**
   *
   * `wsentry.isRepoRoot` 는 `RepoRoot(path) === path` 를 본다 — 워크트리는 자기
   * 자신을 답하므로 참이다. 그 판정이 참이어야 핀과 Editor 행이 함께 서고
   * (FR-EDT-31), 거짓이면 목록에는 있으나 git 이 붙지 않는 행이 된다.
   */
  test('E1 (V-WTG-1 / FR-WTG-1): + Add 로 넣은 워크트리가 저장소로 선다', async ({ page, request }) => {
    const repo = copyFx('basic', 'e1');
    const wtPath = mkWt(repo, 'e1-wt');
    await waitForInit(page);

    // 응답은 두 목록을 함께 준다 — Editor 목록은 `list`, 핀은 `pinned` 다
    // (`handlers_fs.go:702`).
    const lists = await addRepo(request, wtPath);
    // 저장소로 판정됐다면 핀이 함께 선다 (FR-EDT-31·33) — 이 대칭이 판정의 결과다.
    expect(lists.list, 'Editor 목록에 워크트리가 없다').toContain(wtPath);
    expect(lists.pinned, '저장소로 인식됐다면 핀이 함께 서야 한다').toContain(wtPath);
  });

  /**
   * 확정 ②: 그 창의 Changes 가 **워크트리 기준**으로 답한다.
   *
   * 여기가 접수한 말이 겨눈 자리다 — 원본 저장소의 상태가 보이면 "처리를 못한다"
   * 가 참이 된다. 워크트리에만 있는 변경을 만들고, 그것이 보이는지 본다.
   */
  test('E2 (V-WTG-2 / FR-WTG-1): 워크트리 창의 Changes 가 워크트리 자신을 딛는다',
    async ({ page, request }) => {
      const repo = copyFx('basic', 'e2');
      const wtPath = mkWt(repo, 'e2-wt');
      // 워크트리에만 있는 미추적 파일. 원본에는 없다.
      execFileSync('bash', ['-c', `printf 'only-here\\n' > ${JSON.stringify(wtPath)}/wt-only.txt`]);
      await waitForInit(page);
      await addRepo(request, wtPath);
      await openSideChanges(page, wtPath);

      // 패널이 딛는 리포가 워크트리다 — 원본으로 정규화되면 여기서 갈린다.
      await expect.poll(() => page.evaluate(() => (window as any).app.gitPanel.repo),
        { timeout: 15000 }).toBe(wtPath);

      const untracked = changes(page).locator('.git-group[data-group="untracked"]');
      await expect(untracked.locator('.git-file[data-path="wt-only.txt"]'))
        .toBeVisible({ timeout: 15000 });
      // 원본에만 있는 미추적 파일(`untracked.txt`)은 여기 없다 — 있으면 원본을 보고 있다.
      await expect(untracked.locator('.git-file[data-path="untracked.txt"]')).toHaveCount(0);
    });

  /**
   * 확정 ③: 머리의 브랜치가 워크트리의 것이다.
   *
   * 워크트리는 원본과 **다른 브랜치**에 선다 — 그것이 워크트리를 쓰는 이유다.
   * 머리가 원본의 `main` 을 보이면 사용자는 자기가 어디에 서 있는지 알 수 없다.
   */
  test('E3 (V-WTG-3 / FR-WTG-1): 머리가 워크트리의 브랜치를 보인다', async ({ page, request }) => {
    const repo = copyFx('basic', 'e3');
    const wtPath = mkWt(repo, 'e3-branch');
    await waitForInit(page);
    await addRepo(request, wtPath);
    await openSideChanges(page, wtPath);

    await expect(head(page).locator('.git-head-branch')).toHaveText('e3-branch', { timeout: 15000 });
  });

  /**
   * 확정 ④: detached 워크트리. 브랜치가 없으므로 머리는 **해시 앞 7자**를 보이고
   * `detached HEAD` 배지가 선다 (FR-GIT-32·33 의 규약). 워크트리라고 해서 다른
   * 규약이 오면 안 된다.
   */
  test('E4 (V-WTG-4 / FR-WTG-1): detached 워크트리의 머리가 해시와 배지를 보인다',
    async ({ page, request }) => {
      const repo = copyFx('basic', 'e4');
      const wtPath = mkWt(repo, 'e4-det', { detached: true });
      await waitForInit(page);
      await addRepo(request, wtPath);
      await openSideChanges(page, wtPath);

      await expect(head(page).locator('.git-head-branch'))
        .toHaveText(/^[0-9a-f]{7}$/, { timeout: 15000 });
      await expect(head(page).locator('.git-badge-detached')).toBeVisible();
    });

  /**
   * 확정 ⑤: 워크트리 창의 Worktrees 탭이 **형제 전부**를 본다.
   *
   * `git worktree list` 는 어느 워크트리에서 불러도 같은 목록을 준다. 그 목록에
   * 원본과 자기 자신이 함께 서야 워크트리 사이를 오갈 수 있다 — 이것이 접수한 말의
   * "worktree 에서 자체 git 을 볼 수 있어야 한다" 의 실질이다.
   */
  test('E5 (V-WTG-5 / FR-WTG-1): 워크트리 창의 Worktrees 탭이 원본과 자신을 함께 본다',
    async ({ page, request }) => {
      const repo = copyFx('basic', 'e5');
      const wtPath = mkWt(repo, 'e5-wt');
      await waitForInit(page);
      await addRepo(request, wtPath);
      await openSideChanges(page, wtPath);
      await expect.poll(() => page.evaluate(() => (window as any).app.gitPanel.repo),
        { timeout: 15000 }).toBe(wtPath);

      await page.evaluate(() => (window as any).app.gitPanel.openView('worktrees'));
      const wt = page.locator('#area .pn-body .git-view.git-worktrees');
      await expect(wt).toBeVisible({ timeout: 10000 });

      // 둘 다 선다. main 표식은 **원본**에 붙는다 — 워크트리에서 봐도 그렇다.
      await expect(wt.locator(`.git-wt-row[data-path="${wtPath}"]`)).toBeVisible({ timeout: 15000 });
      const mainRow = wt.locator(`.git-wt-row[data-path="${repo}"]`);
      await expect(mainRow).toBeVisible();
      await expect(mainRow).toHaveClass(/\bmain\b/);
    });

  /**
   * FR-WTG-2: `open` 이 **하는 일을 말한다.**
   *
   * 옛 문구는 "이 worktree 를 활성 리포로 엽니다" 였다 — REPO_TAB_UNIFY_SRS
   * FR-RTU-72 로 리포 전환이 창 전환이 되면서 갈아 끼울 "활성 리포" 라는 것이
   * 사라졌는데도 그 표현이 남아 있었다 (§2.5.1 에서 확인).
   */
  test('E7 (V-WTG-7 / FR-WTG-2): Open 의 툴팁이 하는 일과 맞는다', async ({ page, request }) => {
    const repo = copyFx('basic', 'e7');
    const wtPath = mkWt(repo, 'e7-wt');
    await waitForInit(page);
    await addRepo(request, wtPath);
    await openSideChanges(page, repo);
    await expect.poll(() => page.evaluate(() => (window as any).app.gitPanel.repo),
      { timeout: 15000 }).toBe(repo);

    await page.evaluate(() => (window as any).app.gitPanel.openView('worktrees'));
    const wt = page.locator('#area .pn-body .git-view.git-worktrees');
    await expect(wt).toBeVisible({ timeout: 10000 });
    const row = wt.locator(`.git-wt-row[data-path="${wtPath}"]`);
    await expect(row).toBeVisible({ timeout: 15000 });

    const open = row.locator('.git-wt-act[data-act="open"]');
    await expect(open).toHaveAttribute('title', /repository window/i);
    // 옛 표현이 남아 있으면 안 된다 — 지금은 그런 것이 없다.
    await expect(open).not.toHaveAttribute('title', /활성 리포/);
  });

  /**
   * 확정 ⑥: History 가 워크트리의 HEAD 를 딛는다.
   *
   * 워크트리에만 있는 커밋을 만들고 그것이 목록 맨 위에 오는지 본다 — 원본의
   * 로그가 오면 "처리를 못한다" 가 참이다.
   */
  test('E6 (V-WTG-6 / FR-WTG-1): History 가 워크트리의 커밋을 보인다', async ({ page, request }) => {
    const repo = copyFx('basic', 'e6');
    const wtPath = mkWt(repo, 'e6-wt');
    const g = (...a: string[]) => execFileSync('git', ['-C', wtPath, ...a], { stdio: 'pipe' });
    execFileSync('bash', ['-c', `printf 'x\\n' > ${JSON.stringify(wtPath)}/wt-commit.txt`]);
    g('add', '-A');
    g('-c', 'user.name=Fx', '-c', 'user.email=fx@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'only-in-worktree');

    await waitForInit(page);
    await addRepo(request, wtPath);
    await openSideChanges(page, wtPath);
    await expect.poll(() => page.evaluate(() => (window as any).app.gitPanel.repo),
      { timeout: 15000 }).toBe(wtPath);

    await page.evaluate(() => (window as any).app.gitPanel.openView('history'));
    const hist = page.locator('#area .pn-body .git-view.git-history');
    await expect(hist).toBeVisible({ timeout: 10000 });
    await expect(hist).toContainText('only-in-worktree', { timeout: 15000 });
  });
});
