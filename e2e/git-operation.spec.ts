import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// GIT_ACTIONS_SRS §3.1 — 묶음 A 진행 중 작업 (FR-GIT-251·252, 검증 V176).
//
// merge·rebase·cherry-pick·revert 는 충돌하면 **중간 상태를 남기고 멈춘다.** 그
// 사실과 나갈 길이 함께 보이지 않으면 사용자는 GUI 안에 갇힌다 — 이 파일이 그
// 요구사항의 시험이다.
//
// 픽스처를 `git_fixture.sh` 에 더하지 않는다: 충돌 상태는 **저장소를 멈춘 채로
// 두는 것**이라 다른 테스트가 그 저장소를 재사용하면 서로를 오염시킨다. 그래서
// 테스트마다 자기 저장소를 만든다.

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
}

// 충돌하는 머지를 만들어 **멈춘 채로** 남긴다. 같은 파일의 같은 줄을 두 갈래가
// 다르게 고치므로 git 이 반드시 멈춘다.
function repoWithConflictedMerge(tag: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-git-op-' + tag + '-')));
  git(dir, 'init', '-q', '-b', 'main', '.');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 'f.txt'), 'side\n');
  git(dir, 'commit', '-qam', 'side');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'f.txt'), 'main\n');
  git(dir, 'commit', '-qam', 'main');
  // 충돌하므로 실패한다 — 그 실패가 이 픽스처의 목적이다.
  try {
    git(dir, 'merge', 'side');
  } catch {
    /* 의도한 충돌 */
  }
  return dir;
}

async function openChanges(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
}

const bar = (page: Page) => page.locator('#area .pn-body .git-changes .git-op-bar');
const act = (page: Page, a: string) => bar(page).locator(`.git-op-act[data-act="${a}"]`);
const opKind = (page: Page) =>
  page.evaluate(() => (((window as any).app.gitPanel.statusOf() || {}).operation || {}).kind || '');

test.describe('묶음 A — 진행 중 작업의 출구 (V176)', () => {
  const dirs: string[] = [];
  test.afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('A10 (V176 / FR-GIT-251·252): 멈춘 머지에 상태와 출구가 보인다 — merge 에 Skip 은 없다', async ({ page }) => {
    const repo = repoWithConflictedMerge('a10');
    dirs.push(repo);
    await waitForInit(page);
    await openChanges(page, repo);

    // 관측이 진행 중을 싣는다 (FR-GIT-251).
    await expect.poll(() => opKind(page), { timeout: 20000 }).toBe('merge');
    await expect(bar(page), '진행 중 줄이 안 보인다').toBeVisible({ timeout: 20000 });
    expect((await bar(page).locator('.git-op-kind').textContent())!.trim().length).toBeGreaterThan(0);

    // 출구는 **서버가 준 목록**이다 — merge 에는 skip 이 없다.
    await expect(act(page, 'continue')).toBeVisible({ timeout: 15000 });
    await expect(act(page, 'abort')).toBeVisible();
    await expect(act(page, 'skip'), 'merge 에 없는 Skip 이 보인다').toBeHidden();
  });

  test('A11 (V176 / FR-GIT-89·252): 중단은 확인을 거치고, 저장소가 시작 전으로 돌아간다', async ({ page }) => {
    const repo = repoWithConflictedMerge('a11');
    dirs.push(repo);
    await waitForInit(page);
    await openChanges(page, repo);
    await expect.poll(() => opKind(page), { timeout: 20000 }).toBe('merge');

    await act(page, 'abort').click();
    // 파괴적이지만 확인은 한 걸음이다 (CONFIRM_ONE_STAGE_SRS FR-COS-1).
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
    await page.locator('#git-confirm .gc-go').click();
    await expect(page.locator('#git-confirm'), '성공했는데 확인 상자가 안 닫혔다')
      .toHaveCount(0, { timeout: 15000 });

    // 진행 중이 사라지고 줄도 사라진다.
    await expect.poll(() => opKind(page), { timeout: 20000 }).toBe('');
    await expect(bar(page)).toBeHidden();
    // 저장소도 실제로 돌아왔다 — 화면만 바뀐 것이 아니다.
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  test('A12 (V176 / FR-GIT-252): 중단을 취소하면 진행 중 상태가 그대로 남는다', async ({ page }) => {
    const repo = repoWithConflictedMerge('a12');
    dirs.push(repo);
    await waitForInit(page);
    await openChanges(page, repo);
    await expect.poll(() => opKind(page), { timeout: 20000 }).toBe('merge');

    await act(page, 'abort').click();
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 10000 });

    await page.waitForTimeout(1000);
    expect(await opKind(page), '취소했는데 머지가 중단됐다').toBe('merge');
    await expect(bar(page)).toBeVisible();
  });
});
