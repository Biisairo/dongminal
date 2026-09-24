import { execFileSync } from 'child_process';
import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, GIT_VIEW_TABS, clickGitView, waitForInit, openRowMenu, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath } from './osenv';

// BRANCH_MENU_UNIFY_SRS §5 TC-BMU-*
//
// 브랜치 메뉴가 로컬용·원격용 항목을 나란히 두고 각각 반대쪽에서 비활성으로
// 만들던 것을 정리한다. merge 는 **동작이 하나였으므로** 항목도 하나가 되고,
// 삭제는 동작이 둘이므로 **둘을 함께 하는 셋째 길**이 생긴다.

const FIXTURES = tmpPath('dm-git-fx-bmu-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);

/**
 * **이 파일의 검사들은 서로 독립이다** (`TEST-20`).
 *
 * 각자 `copyFx` 로 자기 저장소를 받고 서버 설정을 건드리지 않는다 — 파일 안의
 * 순서에 기대는 자리가 없으므로 워커에 흩어도 같은 답이 나온다. 전역 기본값
 * (`fullyParallel`)은 그대로 `false` 이고, 독립이 **확인된** 파일만 켠다.
 */
test.describe.configure({ mode: 'parallel' });

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

async function openBranches(page: Page, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  // REPO_TAB_UNIFY_SRS: 창의 모양이 바뀌었다 — `Changes` 는 **사이드**에 살고
  // 나머지 여섯 뷰는 **본문 탭**으로 필요할 때 열린다 (FR-RTU-30·32). 스펙들이
  // "탭을 클릭한다" 로 뷰를 고르므로 여기서 여섯을 미리 세운다.
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a.testing.edSetSide(a.testing.aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees', 'submodules']) p.openView(v);
  });
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await clickGitView(page, 'branches');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-branches/);
}

const br = (page: Page) => page.locator('#area .pn-body .git-view.git-branches');
const rows = (page: Page) => br(page).locator('.git-br-row');
const row = (page: Page, short: string) => br(page).locator(`.git-br-row[data-short="${short}"]`);
const menu = (page: Page) => page.locator('.git-menu');
const item = (page: Page, id: string) => menu(page).locator(`.git-menu-item[data-id="${id}"]`);
const confirm = (page: Page) => page.locator('#git-confirm .gc-box');
const mergeBox = (page: Page) => page.locator('#git-br-merge .gbm-box');

async function waitRefs(page: Page, min = 1) {
  await expect.poll(() => rows(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(min);
}

const isDisabled = (page: Page, id: string) =>
  item(page, id).evaluate((el) =>
    el.classList.contains('disabled') || el.hasAttribute('disabled') ||
    el.getAttribute('aria-disabled') === 'true');

async function openMenu(page: Page, short: string) {
  await openRowMenu(page, row(page, short));
}
async function closeMenu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(menu(page)).toBeHidden({ timeout: 10000 });
}

test.describe('묶음 M — merge 통합', () => {
  // TC-BMU-1 · TC-BMU-2
  test('merge 가 로컬·원격 양쪽에서 활성이고 remote-pull 항목은 없다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-m1');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    // 로컬 ref — 종전에도 활성이었다.
    await openMenu(page, 'no-upstream');
    expect(await isDisabled(page, 'merge')).toBe(false);
    await expect(item(page, 'remote-pull')).toHaveCount(0);
    await closeMenu(page);

    // 원격 ref — 종전에는 "로컬 브랜치에서만" 으로 막혔다 (접수한 ①).
    await openMenu(page, 'origin/main');
    expect(await isDisabled(page, 'merge')).toBe(false);
    await expect(item(page, 'remote-pull')).toHaveCount(0);
    await closeMenu(page);
  });

  // TC-BMU-3 — 동작은 종전 remote-pull 그대로다.
  test('원격 ref 의 merge 는 그 ref 를 현재 브랜치에 합치는 자리로 간다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-m2');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await openMenu(page, 'origin/main');
    await item(page, 'merge').click();
    await expect(mergeBox(page)).toBeVisible({ timeout: 15000 });
    await expect(mergeBox(page).locator('.gbm-note')).toContainText('origin/main');
    await page.keyboard.press('Escape');
  });

  // TC-BMU-4
  test('로컬 ref 의 merge 는 종전과 같다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-m3');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await openMenu(page, 'no-upstream');
    await item(page, 'merge').click();
    await expect(mergeBox(page)).toBeVisible({ timeout: 15000 });
    await expect(mergeBox(page).locator('.gbm-note')).toContainText('no-upstream');
    await page.keyboard.press('Escape');
  });
});

test.describe('묶음 D — 삭제 통합', () => {
  // TC-BMU-10
  test('delete-both 는 upstream 이 있는 로컬 브랜치에서만 활성이다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-d1');
    // upstream 이 붙은 로컬 브랜치를 하나 만든다.
    git(repo, 'push', '-q', '-u', 'origin', 'no-upstream:tracked');
    git(repo, 'branch', '-q', '--set-upstream-to=origin/tracked', 'no-upstream');
    git(repo, 'fetch', '-q', 'origin');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    // upstream 이 있는 로컬 — 활성
    await openMenu(page, 'no-upstream');
    expect(await isDisabled(page, 'delete-both')).toBe(false);
    await closeMenu(page);

    // 원격 ref — 비활성 (로컬 브랜치에서만)
    await openMenu(page, 'origin/main');
    expect(await isDisabled(page, 'delete-both')).toBe(true);
    await closeMenu(page);
  });

  // TC-BMU-12 — 로컬과 원격이 둘 다 사라진다.
  test('실행하면 로컬과 원격이 둘 다 사라진다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-d2');
    git(repo, 'push', '-q', '-u', 'origin', 'no-upstream:gone');
    git(repo, 'branch', '-q', '--set-upstream-to=origin/gone', 'no-upstream');
    git(repo, 'fetch', '-q', 'origin');
    expect(git(repo, 'ls-remote', '--heads', 'origin', 'gone')).toContain('gone');

    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await openMenu(page, 'no-upstream');
    await item(page, 'delete-both').click();

    // TC-BMU-11: 영향 범위에 로컬과 원격이 둘 다 보인다.
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await expect(confirm(page)).toHaveAttribute('data-stage', '1');
    const listed = (await confirm(page).textContent()) || '';
    expect(listed).toContain('no-upstream');
    expect(listed).toContain('origin/gone');

    await confirm(page).locator('.gc-go').click();

    await expect.poll(() => git(repo, 'branch', '--list', 'no-upstream'), { timeout: 30000 }).toBe('');
    await expect.poll(() => git(repo, 'ls-remote', '--heads', 'origin', 'gone'), { timeout: 30000 }).toBe('');
  });

  /**
   * TC-BMU-13 (개정 D-BMU-6) — **한쪽만 지우는 길은 그대로이되 항목은 하나다.**
   *
   * 종전에는 원격 행에서 `delete` 가 "로컬 브랜치에서만" 으로 죽고 `remote-delete`
   * 라는 다른 항목이 원격을 지웠다. 이제 `delete` 가 문맥을 따른다.
   */
  test('delete 가 문맥을 따르고 remote-delete 는 없다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-d3');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await openMenu(page, 'no-upstream');
    await expect(item(page, 'delete')).toHaveCount(1);
    expect(await isDisabled(page, 'delete')).toBe(false);
    await expect(item(page, 'delete')).toContainText('Delete');
    await expect(item(page, 'remote-delete')).toHaveCount(0);
    await closeMenu(page);

    // FR-BMU-16c: 원격 ref 에서도 **활성**이고, 라벨이 무엇을 지우는지 말한다.
    await openMenu(page, 'origin/main');
    await expect(item(page, 'delete')).toHaveCount(1);
    expect(await isDisabled(page, 'delete')).toBe(false);
    await expect(item(page, 'delete')).toContainText('Delete remote branch');
    await expect(item(page, 'remote-delete')).toHaveCount(0);
    await closeMenu(page);
  });

  // TC-BMU-22 — 원격 행의 delete 는 그 원격만 지운다.
  test('원격 ref 의 delete 가 원격만 지운다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-d4');
    git(repo, 'push', '-q', 'origin', 'no-upstream:only-remote');
    git(repo, 'fetch', '-q', 'origin');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await openMenu(page, 'origin/only-remote');
    await item(page, 'delete').click();
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await confirm(page).locator('.gc-go').click();

    await expect.poll(() => git(repo, 'ls-remote', '--heads', 'origin', 'only-remote'),
      { timeout: 30000 }).toBe('');
    // 로컬은 건드리지 않는다 — 한쪽만 지우는 길이다.
    expect(git(repo, 'branch', '--list', 'no-upstream')).toContain('no-upstream');
  });

  // TC-BMU-24 — 원격 행에서도 짝을 지운다 (FR-BMU-16d·16e·16g).
  test('원격 ref 의 delete-both 가 짝지어진 둘을 지운다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-d6');
    git(repo, 'push', '-q', '-u', 'origin', 'no-upstream:paired');
    git(repo, 'fetch', '-q', 'origin');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    // 종전에는 여기서 "로컬 브랜치에서만 쓸 수 있습니다" 로 죽었다.
    await openMenu(page, 'origin/paired');
    expect(await isDisabled(page, 'delete-both')).toBe(false);
    await item(page, 'delete-both').click();

    // FR-BMU-12: 영향 범위에 둘 다 — 어느 행에서 눌렀든 같은 쌍이다.
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    const listed = (await confirm(page).textContent()) || '';
    expect(listed).toContain('no-upstream');
    expect(listed).toContain('origin/paired');
    await confirm(page).locator('.gc-go').click();

    await expect.poll(() => git(repo, 'branch', '--list', 'no-upstream'), { timeout: 30000 }).toBe('');
    await expect.poll(() => git(repo, 'ls-remote', '--heads', 'origin', 'paired'), { timeout: 30000 }).toBe('');
  });

  /**
   * TC-BMU-27 (FR-BMU-16h) — **Branches 탭을 열지 않아도 짝을 안다.**
   *
   * 접수: *"remote local 이 둘 다 존재하는데 `Delete local and remote` 가
   * 비활성이다."* 원인은 짝 판정이 **Branches 뷰의 사본**을 읽은 것이었다 —
   * 그 탭을 한 번도 열지 않으면 목록이 비어 "추적하는 로컬이 없다" 가 됐다.
   */
  test('Branches 탭을 열지 않은 채 History 배지에서도 짝을 찾는다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-d9');
    git(repo, 'push', '-q', '-u', 'origin', 'no-upstream:tracked');
    git(repo, 'fetch', '-q', 'origin');

    await waitForInit(page);
    await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    // **history 만** 연다 — branches 는 열지 않는다.
    await page.evaluate(() => {
      const a = (window as any).app;
      a.testing.edSetSide(a.testing.aw(), 'changes');
      a.gitPanel.openView('history');
    });
    await clickGitView(page, 'history');

    const badge = page.locator('#area .pn-body .git-hist-badge').filter({ hasText: 'origin/tracked' }).first();
    await expect(badge).toBeVisible({ timeout: 20000 });
    // 착수 시 RED: 여기서 "이 원격을 추적하는 로컬 브랜치가 없습니다" 로 죽었다.
    await badge.click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    expect(await isDisabled(page, 'delete-both')).toBe(false);
    await closeMenu(page);
  });

  // TC-BMU-25 — 짝이 없으면 사유와 함께 죽는다 (FR-BMU-16f).
  test('추적하는 로컬이 없는 원격에서는 delete-both 가 사유와 함께 비활성이다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-d7');
    // upstream 을 세우지 않고 올린다 — 이 원격을 추적하는 로컬이 없다.
    git(repo, 'push', '-q', 'origin', 'no-upstream:orphan');
    git(repo, 'fetch', '-q', 'origin');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await openMenu(page, 'origin/orphan');
    expect(await isDisabled(page, 'delete-both')).toBe(true);
    await expect(item(page, 'delete-both')).toHaveAttribute('title', /로컬 브랜치가 없습니다/);
    // 같은 행의 `delete` 는 살아 있다 — 원격 하나만 지우는 길이다.
    expect(await isDisabled(page, 'delete')).toBe(false);
    await closeMenu(page);
  });

  /**
   * TC-BMU-26 (FR-BMU-16g) — 짝은 섰는데 **그 로컬이 현재 브랜치**인 경우.
   *
   * 원격만 지우고 끝나는 경로를 만들지 않는다. 그것이 필요하면 같은 메뉴의
   * `delete` 가 이미 그 길이다.
   */
  test('짝지어진 로컬이 현재 브랜치면 delete-both 가 죽는다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-d8');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    // `main` 이 `origin/main` 을 추적하고 그것이 HEAD 다.
    await openMenu(page, 'origin/main');
    expect(await isDisabled(page, 'delete-both')).toBe(true);
    await expect(item(page, 'delete-both')).toHaveAttribute('title', /현재 브랜치/);
    expect(await isDisabled(page, 'delete')).toBe(false);
    await closeMenu(page);
  });

  // TC-BMU-23 — 로컬 행의 delete 는 종전 그대로다.
  test('로컬 ref 의 delete 는 로컬만 지운다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-d5');
    git(repo, 'push', '-q', '-u', 'origin', 'no-upstream:keep-remote');
    git(repo, 'fetch', '-q', 'origin');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await openMenu(page, 'no-upstream');
    await item(page, 'delete').click();
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await confirm(page).locator('.gc-go').click();

    await expect.poll(() => git(repo, 'branch', '--list', 'no-upstream'), { timeout: 30000 }).toBe('');
    expect(git(repo, 'ls-remote', '--heads', 'origin', 'keep-remote')).toContain('keep-remote');
  });
});

/**
 * TC-BMU-20·21 (FR-BMU-15·15a·15b·15d) — **반쪽만 지워진 것을 말한다.**
 *
 * 착수 시 이 조항은 구현되지 않고 있었다. `GitRemote.run()` 의 `ok:true` 는
 * *"작업을 띄웠다"* 이지 *"지워졌다"* 가 아닌데 `delBoth` 는 그것만 보았다 —
 * 진짜 실패는 job 의 `done` 으로 오고 아무도 보지 않았다.
 */
test.describe('묶음 F — 반쪽 실패를 말한다', () => {
  const toast = (page: Page) => page.locator('#toast-host .toast');

  // TC-BMU-20
  test('원격 삭제가 지면 그 사유가 화면에 뜬다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-f1');
    git(repo, 'push', '-q', '-u', 'origin', 'no-upstream:feature/ghost');
    git(repo, 'branch', '-q', '--set-upstream-to=origin/feature/ghost', 'no-upstream');
    git(repo, 'fetch', '-q', 'origin');
    // 원격이 삭제를 거절하게 한다 — pre-receive 훅이 막으면 `push --delete` 가 진다.
    //
    // REPO_FIX 01 §7.3: 종전에는 "원격에서만 먼저 지워 둔 ref" 로 실패를 만들었다.
    // 원격 삭제가 완전 이름(refs/heads/…)을 쓰게 된 뒤로 git 은 이미 없는 ref 의
    // 삭제를 경고와 함께 **성공**(exit 0)으로 끝낸다(실측 — 원하는 결과에 이미
    // 닿았다). 그래서 진짜 거절로 바꾼다. 검사하는 것(반쪽 실패의 사유 표시)은 같다.
    const remote = git(repo, 'remote', 'get-url', 'origin');
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "deletes are not allowed here" >&2\nexit 1\n');
    chmodSync(hook, 0o755);

    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await openMenu(page, 'no-upstream');
    await item(page, 'delete-both').click();
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await confirm(page).locator('.gc-go').click();

    // 로컬은 사라진다 (FR-BMU-13: 로컬 먼저).
    await expect.poll(() => git(repo, 'branch', '--list', 'no-upstream'), { timeout: 30000 }).toBe('');

    // FR-BMU-15d: 자리는 토스트다 — Branches 탭에서 누른 사람에게 닿아야 한다.
    await expect(toast(page)).toBeVisible({ timeout: 30000 });
    const text = (await toast(page).textContent()) || '';
    // FR-BMU-15b: 사유를 싣는다. 무엇 때문에 졌는지 없으면 다음에 할 일을 못 고른다.
    expect(text, `사유가 없다: ${text}`).toContain('pre-receive hook declined');
  });

  // TC-BMU-21 — 기다림이 거짓 경보를 만들지 않는다.
  test('원격이 실제로 지워지면 조용하다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-f2');
    git(repo, 'push', '-q', '-u', 'origin', 'no-upstream:feature/real');
    git(repo, 'branch', '-q', '--set-upstream-to=origin/feature/real', 'no-upstream');
    git(repo, 'fetch', '-q', 'origin');

    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await openMenu(page, 'no-upstream');
    await item(page, 'delete-both').click();
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await confirm(page).locator('.gc-go').click();

    await expect.poll(() => git(repo, 'branch', '--list', 'no-upstream'), { timeout: 30000 }).toBe('');
    await expect.poll(() => git(repo, 'ls-remote', '--heads', 'origin', 'feature/real'), { timeout: 30000 }).toBe('');
    // 둘 다 지워졌으므로 실패 안내가 설 이유가 없다.
    await expect(toast(page)).toHaveCount(0);
  });
});

// ── 묶음 T — 세 진입점이 같은 대상을 준다 (TC-BMU-14~16) ──
//
// 접수한 말은 "local branch 지울 때 remote 도 함께 지우는 것이 구현이 안 되어
// 있다" 였다. 구현은 있었고, **History 커밋 옆 배지에서 연 메뉴에서만** 죽어
// 있었다 — `git log` 의 decoration 은 이름과 종류뿐이라 그 대상에 `upstream` 이
// 없고, `delete-both` 는 그것을 보고 활성을 정한다 (FR-BMU-11).

async function openHistory(page: Page, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  // REPO_TAB_UNIFY_SRS: 창의 모양이 바뀌었다 — `Changes` 는 **사이드**에 살고
  // 나머지 여섯 뷰는 **본문 탭**으로 필요할 때 열린다 (FR-RTU-30·32). 스펙들이
  // "탭을 클릭한다" 로 뷰를 고르므로 여기서 여섯을 미리 세운다.
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a.testing.edSetSide(a.testing.aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees', 'submodules']) p.openView(v);
  });
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await clickGitView(page, 'history');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-history/);
}

const badge = (page: Page, name: string) =>
  page.locator('#area .pn-body .git-view.git-history .git-hist-badge')
    .filter({ hasText: new RegExp('^' + name + '$') }).first();

// upstream 이 걸려 있고 HEAD 가 **아닌** 로컬 브랜치를 만든다 — 픽스처에는 없는
// 조합이며(main 은 HEAD, no-upstream 은 upstream 이 없다) `delete-both` 의 활성이
// 드러나는 유일한 자리다.
//
// 이름은 **사본마다 다르다.** 픽스처의 사본들은 origin 으로 같은 `remote.git` 을
// 가리키므로(git_fixture.sh 가 절대경로로 add 한다), 이름을 고정하면 앞선 테스트가
// 밀어 둔 같은 이름의 원격 브랜치와 non-fast-forward 로 부딪힌다.
function trackedBranch(repo: string, tag: string) {
  const name = 'tracked-' + tag;
  git(repo, 'branch', name);
  git(repo, 'push', '-q', '-u', 'origin', name);
  return name;
}

test.describe('묶음 T — 진입점이 판정을 가르지 않는다', () => {
  test('TC-BMU-14 (FR-BMU-17·18): History 배지의 delete-both 가 Branches 탭과 같다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-t1');
    const name = trackedBranch(repo, 'bmu-t1');
    await waitForInit(page);

    // ① Branches 탭 — 기준이 되는 판정.
    await openBranches(page, repo);
    await waitRefs(page, 4);
    await openMenu(page, name);
    const inBranches = await isDisabled(page, 'delete-both');
    expect(inBranches, 'upstream 이 걸린 로컬 브랜치인데 Branches 탭에서도 죽어 있다').toBe(false);
    await closeMenu(page);

    // ② History 배지 — 같은 브랜치, 같은 항목.
    await openHistory(page, repo);
    await expect(badge(page, name)).toBeVisible({ timeout: 20000 });
    await badge(page, name).click({ button: 'right' });
    await expect(menu(page)).toBeVisible({ timeout: 10000 });
    expect(await isDisabled(page, 'delete-both'),
      'History 배지에서만 죽어 있다 — 진입점이 판정을 갈랐다').toBe(false);
    // 같은 이유로 죽던 이웃도 함께 살아난다.
    expect(await isDisabled(page, 'upstream-unset')).toBe(false);
    await closeMenu(page);
  });

  test('TC-BMU-15 (FR-BMU-18): History 배지의 delete hint 에 oid 가 있다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-t2');
    const name = trackedBranch(repo, 'bmu-t2');
    const oid = git(repo, 'rev-parse', name);
    await waitForInit(page);
    await openHistory(page, repo);
    /**
     * **refs 가 도착할 때까지 기다린다.**
     *
     * `oid` 는 decoration 이 아니라 refs 관측에서 온다 (FR-BMU-18) — 그 둘은 따로
     * 오고, 배지는 decoration 만으로도 그려진다. 기다리지 않으면 "배지는 보이는데
     * oid 는 아직 없는" 창에서 누르게 되고, **그 창의 폭은 서버가 얼마나 바쁜가에
     * 달린다** (전량 실행에서만 재현된 이유다).
     *
     * 이웃 검사들의 `waitRefs` 는 **Branches 행**을 센다 — History 뷰가 활성인
     * 여기서는 그 행이 0 이라 쓸 수 없다. 제품이 `oid` 를 꺼내는 바로 그 자료
     * (`_historyView._refs`)를 본다.
     */
    await expect.poll(() => page.evaluate(() => {
      const v = (window as any).app?.gitPanel?._historyView;
      return ((v && v._refs) || []).length;
    }), { timeout: 20000 }).toBeGreaterThanOrEqual(3);
    await expect(badge(page, name)).toBeVisible({ timeout: 20000 });
    await badge(page, name).click({ button: 'right' });
    await expect(menu(page)).toBeVisible({ timeout: 10000 });

    await item(page, 'delete').click();
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    // 되살릴 수 없는 명령(`git branch <이름> ` — oid 없음)을 보이지 않는다
    // (FR-GIT-250.2).
    const cmd = (await confirm(page).locator('.gc-hint-cmd').textContent())!.trim();
    expect(cmd, 'hint 에 지우기 전 oid 가 없다: ' + cmd).toContain(oid);
    await page.keyboard.press('Escape');
  });
});
