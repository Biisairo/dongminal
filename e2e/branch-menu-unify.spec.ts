import { execFileSync } from 'child_process';
import { realpathSync, rmSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// BRANCH_MENU_UNIFY_SRS §5 TC-BMU-*
//
// 브랜치 메뉴가 로컬용·원격용 항목을 나란히 두고 각각 반대쪽에서 비활성으로
// 만들던 것을 정리한다. merge 는 **동작이 하나였으므로** 항목도 하나가 되고,
// 삭제는 동작이 둘이므로 **둘을 함께 하는 셋째 길**이 생긴다.

const FIXTURES = '/tmp/dm-git-fx-bmu-' + process.pid;

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

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openBranches(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
  await page.click('#area .pn-tab[data-git-view="branches"]');
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
  await row(page, short).click({ button: 'right' });
  await expect(menu(page)).toBeVisible({ timeout: 10000 });
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
    await expect(confirm(page)).toHaveAttribute('data-stage', '2');
    await confirm(page).locator('.gc-go').click();

    await expect.poll(() => git(repo, 'branch', '--list', 'no-upstream'), { timeout: 30000 }).toBe('');
    await expect.poll(() => git(repo, 'ls-remote', '--heads', 'origin', 'gone'), { timeout: 30000 }).toBe('');
  });

  // TC-BMU-13 — 한쪽만 지우는 길은 그대로 남는다.
  test('delete 와 remote-delete 가 그대로 있다', async ({ page }) => {
    const repo = copyFx('with-remote', 'bmu-d3');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await openMenu(page, 'no-upstream');
    await expect(item(page, 'delete')).toHaveCount(1);
    expect(await isDisabled(page, 'delete')).toBe(false);
    await closeMenu(page);

    await openMenu(page, 'origin/main');
    await expect(item(page, 'remote-delete')).toHaveCount(1);
    expect(await isDisabled(page, 'remote-delete')).toBe(false);
    await closeMenu(page);
  });
});
