import { execFileSync } from 'child_process';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, GIT_VIEW_TABS } from './fixtures';

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

const copyFx = makeCopyFx(FIXTURES);
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openBranches(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
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

// ── 묶음 T — 세 진입점이 같은 대상을 준다 (TC-BMU-14~16) ──
//
// 접수한 말은 "local branch 지울 때 remote 도 함께 지우는 것이 구현이 안 되어
// 있다" 였다. 구현은 있었고, **History 커밋 옆 배지에서 연 메뉴에서만** 죽어
// 있었다 — `git log` 의 decoration 은 이름과 종류뿐이라 그 대상에 `upstream` 이
// 없고, `delete-both` 는 그것을 보고 활성을 정한다 (FR-BMU-11).

async function openHistory(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await page.click('#area .pn-tab[data-git-view="history"]');
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
