import { execFileSync } from 'child_process';
import { realpathSync, rmSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// HISTORY_BRANCH_BUTTON_SRS §5 TC-HBB-*
//
// 브랜치 생성 **기능**은 GIT_ACTIONS_SRS 의 것이다. 여기서 재는 것은 그 자리로
// 가는 **길 하나** — History 바의 버튼 — 이며, 그 길이 공용 머리(FR-GHM-4)를
// 건드리지 않았는지다.

const FIXTURES = '/tmp/dm-git-fx-hbb-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

function copyFx(name: string, tag: string) {
  const dst = join(FIXTURES, 'copy-' + tag);
  rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-R', join(FIXTURES, name), dst]);
  return realpathSync(dst);
}

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openView(page: Page, repo: string, view: string, cls: RegExp) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
  await page.click(`#area .pn-tab[data-git-view="${view}"]`);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(cls);
}

const openHistory = (page: Page, repo: string) =>
  openView(page, repo, 'history', /git-history/);
const openChanges = (page: Page, repo: string) =>
  openView(page, repo, 'changes', /git-changes/);

const hist = (page: Page) => page.locator('#area .pn-body .git-view.git-history');
const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const brBtn = (page: Page) => hist(page).locator('.git-hist-branch');
const create = (page: Page) => page.locator('#git-br-create .gbc-box');

test.describe('History 의 브랜치 생성 버튼', () => {
  // TC-HBB-1
  test('History 바에 버튼이 하나 선다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('basic'));
    await expect(brBtn(page)).toHaveCount(1);
    // FR-HBB-2: 자리는 여백 뒤다 — 목록을 거르는 왼쪽 무리에 속하지 않는다.
    const afterSpacer = await hist(page).evaluate((el) => {
      const bar = el.querySelector('.git-hist-bar')!;
      const kids = [...bar.children];
      return kids.indexOf(bar.querySelector('.git-hist-branch')!)
           > kids.indexOf(bar.querySelector('.git-hist-spacer')!);
    });
    expect(afterSpacer).toBe(true);
  });

  // TC-HBB-2
  test('누르면 다이얼로그가 열리고 시작 지점이 비어 있다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('basic'));
    await brBtn(page).click();
    await expect(create(page)).toBeVisible();
    // FR-HBB-4: startRef 를 채우지 않는다 — 비면 서버가 HEAD 를 쓴다.
    await expect(create(page).locator('.gbc-start')).toHaveValue('');
  });

  // TC-HBB-3
  test('이름을 넣고 Create 하면 그 브랜치가 생긴다', async ({ page }) => {
    const repo = copyFx('basic', 'hbb-make');
    await waitForInit(page);
    await openHistory(page, repo);
    await brBtn(page).click();
    await expect(create(page)).toBeVisible();

    await create(page).locator('.gbc-name').fill('hbb-new');
    await create(page).locator('.gbc-go').click();
    await expect(create(page)).toHaveCount(0, { timeout: 15000 });

    await expect
      .poll(() => git(repo, 'branch', '--list', 'hbb-new'), { timeout: 15000 })
      .toContain('hbb-new');
  });

  // TC-HBB-4 · TC-HBB-5 — 공용 머리는 그대로다 (FR-GHM-4 / FR-GIT-238·282).
  test('Changes 에는 버튼이 없고 공용 머리의 버튼 수도 그대로다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('basic'));
    const histHeadBtns = await hist(page).locator('.git-head button').count();

    await openChanges(page, fx('basic'));
    await expect(changes(page).locator('.git-hist-branch')).toHaveCount(0);
    const chHeadBtns = await changes(page).locator('.git-head button').count();

    // 머리는 한 자리에서 만들어진다 — 두 뷰의 버튼 수가 같아야 그 계약이 산다.
    expect(histHeadBtns).toBe(chHeadBtns);
  });
});
