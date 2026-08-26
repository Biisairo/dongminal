import { execFileSync } from 'child_process';
import { realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// 묶음 Q — Console 탭 (GIT_UI_REVISION_SRS FR-GIT-218, 검증 V95).
//
// Console 은 터미널이 아니라 **dongminal 이 대신 실행한 git 명령의 기록**이다.
// 그 명령들은 서버 프로세스 안에서 돌아 사용자의 터미널에는 남지 않는다.

const FIXTURES = '/tmp/dm-git-fx-console-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

function copyFx(name: string, tag: string) {
  const dst = join(FIXTURES, 'copy-' + tag);
  rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-R', join(FIXTURES, name), dst]);
  return realpathSync(dst);
}

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
}

const tab = (page: Page, v: string) => page.locator(`#area .pn-tab[data-git-view="${v}"]`);
const con = (page: Page) => page.locator('#area .pn-body .git-view.git-console');
const rows = (page: Page) => con(page).locator('.git-con-row');
const argvs = (page: Page) => rows(page).locator('.git-con-argv').allTextContents();

async function openConsole(page: Page, repo: string) {
  await openGit(page, repo);
  await tab(page, 'console').click();
  await expect(con(page)).toHaveClass(/vis/);
}

test.describe('묶음 Q — Console 탭', () => {
  test('K1 (V95): Console 은 준비 중이 아니라 실행 기록을 보인다', async ({ page }) => {
    const repo = copyFx('basic', 'k1');
    await waitForInit(page);
    await openConsole(page, repo);

    await expect(con(page).locator('.git-pending')).toHaveCount(0);
    await expect(con(page).locator('.git-con-list')).toBeVisible({ timeout: 10000 });
  });

  test('K2 (V95): 쓰기를 하면 그 명령이 맨 위에 나타난다', async ({ page }) => {
    const repo = copyFx('basic', 'k2');
    await waitForInit(page);
    await openGit(page, repo);

    // Changes 에서 파일 하나를 스테이지한다 — dongminal 이 `git add` 를 실행한다.
    const row = page.locator('#area .pn-body .git-group[data-group="changes"] .git-file[data-path="tracked.txt"]');
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.hover();
    await row.locator('.git-file-act[data-act="stage"]').click();
    await expect(page.locator('#area .pn-body .git-group[data-group="staged"] .git-file[data-path="tracked.txt"]'))
      .toBeVisible({ timeout: 15000 });

    await tab(page, 'console').click();
    await expect.poll(async () => (await argvs(page))[0], { timeout: 15000 })
      .toContain('add');
  });

  test('K3 (V95): 기본에서 폴링이 보이지 않고 토글하면 나타난다', async ({ page }) => {
    const repo = copyFx('basic', 'k3');
    await waitForInit(page);
    await openConsole(page, repo);

    // status 폴링은 1초에 한 번 기록된다 — 거르지 않으면 목록이 그것으로만 찬다.
    await expect.poll(async () => (await argvs(page)).some((a) => a.includes('status')),
      { timeout: 10000 }).toBe(false);

    await con(page).locator('.git-con-reads input').check();
    await expect.poll(async () => (await argvs(page)).some((a) => a.includes('status')),
      { timeout: 15000 }).toBe(true);
  });

  test('K4 (V95): 행을 펼치면 cwd 를 보이고, 파괴적 실행은 표식을 갖는다', async ({ page }) => {
    const repo = copyFx('basic', 'k4');
    await waitForInit(page);
    await openGit(page, repo);

    // discard 는 파괴적이다 (FR-GIT-95, 해석 I5) — 2단계 확인을 거친다.
    writeFileSync(join(repo, 'k4.txt'), 'x\n');
    const row = page.locator('#area .pn-body .git-group[data-group="untracked"] .git-file[data-path="k4.txt"]');
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.hover();
    await row.locator('.git-file-act[data-act="discard"]').click();
    // 파괴적 동작은 2단계 확인이다 (FR-GIT-95~97) — 1단계에서 2단계로 넘어간 뒤
    // 실행한다.
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await page.locator('#git-confirm .gc-go').click();
    await expect(box).toHaveAttribute('data-stage', '2');
    await page.locator('#git-confirm .gc-go').click();
    await expect(row).toHaveCount(0, { timeout: 15000 });

    await tab(page, 'console').click();
    const destructive = con(page).locator('.git-con-row[data-destructive="1"]');
    await expect(destructive.first()).toBeVisible({ timeout: 15000 });

    // 펼치면 cwd 를 본다 — 어느 저장소에서 돌았는지가 이력의 절반이다.
    await destructive.first().click();
    await expect(con(page).locator('.git-con-detail').first()).toContainText(repo, { timeout: 10000 });
  });

  test('K5 (V95): 리포를 바꾸면 그 리포의 기록만 보인다', async ({ page }) => {
    const a = copyFx('basic', 'k5a');
    const b = copyFx('with-remote', 'k5b');
    await waitForInit(page);
    await openConsole(page, a);
    await expect.poll(async () => (await argvs(page)).length, { timeout: 15000 })
      .toBeGreaterThan(0);

    await page.evaluate((r) => (window as any).app.gitPanel.setRepo(r), b);
    // 앞 리포의 기록이 남아 있으면 이력이 아니라 잡음이다.
    await expect.poll(async () => {
      const d = await con(page).locator('.git-con-detail').allTextContents();
      return d.some((t) => t.includes(a));
    }, { timeout: 15000 }).toBe(false);
  });
});
