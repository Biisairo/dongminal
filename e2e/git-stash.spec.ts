import { execFileSync } from 'child_process';
import { realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M5_STEP1821_CONTRACT §2 — Stash 탭. 검증 V56~V58 · V69.
//
// `stashes` 픽스처는 stash 2개 + 현재 변경 1개다 (design/README.md). 쓰기를 하는
// 스펙은 **복사본**에서 돈다.

const FIXTURES = '/tmp/dm-git-fx-stash-' + process.pid;

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

const stashCount = (repo: string) =>
  git(repo, 'stash', 'list').split('\n').filter((l) => l.trim()).length;

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openStash(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
  await page.click('#area .pn-tab[data-git-view="stash"]');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-stash/);
}

const st = (page: Page) => page.locator('#area .pn-body .git-view.git-stash');
const rows = (page: Page) => st(page).locator('.git-stash-row');
const row = (page: Page, i: number) => st(page).locator(`.git-stash-row[data-index="${i}"]`);
const note = (page: Page) => st(page).locator('.git-stash-note');
const menu = (page: Page) => page.locator('.git-menu');
const items = (page: Page) => menu(page).locator('.git-menu-item');
const confirm = (page: Page) => page.locator('#git-confirm .gc-box');
const create = (page: Page) => page.locator('#git-stash-create .gsc-box');
const diff = (page: Page) => page.locator('#area .pn-body .git-view.git-diff');

async function waitStashes(page: Page, n: number) {
  await expect(rows(page)).toHaveCount(n, { timeout: 20000 });
}

test.describe('19단계 — Stash 탭', () => {
  test('S1 (V56 / FR-GIT-161): 인덱스·메시지·기준 브랜치·시각을 보인다', async ({ page }) => {
    const repo = copyFx('stashes', 's1');
    await waitForInit(page);
    await openStash(page, repo);
    await waitStashes(page, 2);

    // stash@{0} 이 가장 최근이다.
    await expect(row(page, 0).locator('.git-stash-ref')).toHaveText('stash@{0}');
    await expect(row(page, 0).locator('.git-stash-msg')).toContainText('두 번째');
    await expect(row(page, 1).locator('.git-stash-msg')).toContainText('첫 번째');
    await expect(row(page, 0).locator('.git-stash-base')).toHaveText('main');
    await expect(row(page, 0).locator('.git-stash-date')).not.toHaveText('');
  });

  test('S2 (V56 / FR-GIT-162·163): Apply 는 stash 를 남긴다', async ({ page }) => {
    const repo = copyFx('stashes', 's2');
    // 워킹 트리를 깨끗이 한다 — apply 가 얹을 자리를 만든다.
    git(repo, 'checkout', '--', '.');
    await waitForInit(page);
    await openStash(page, repo);
    await waitStashes(page, 2);

    await row(page, 1).click({ button: 'right' });
    await expect(menu(page)).toHaveAttribute('data-kind', 'stash');
    await items(page).filter({ hasText: /^Apply$/ }).click();

    // 변경은 워킹 트리에 얹히고 stash 는 그대로 2개다.
    await expect.poll(() => git(repo, 'status', '--porcelain'), { timeout: 20000 }).not.toBe('');
    expect(stashCount(repo)).toBe(2);
    await waitStashes(page, 2);
  });

  test('S3 (V56 / FR-GIT-163): Apply (--index) 는 index 까지 되돌린다', async ({ page }) => {
    const repo = copyFx('stashes', 's3');
    git(repo, 'checkout', '--', '.');
    // staged 변경을 담은 stash 를 하나 더 만든다 — --index 의 차이를 볼 대상이다.
    writeFileSync(join(repo, 'f.txt'), 'staged-wip\n');
    git(repo, 'add', 'f.txt');
    git(repo, 'stash', 'push', '-q', '-m', 'staged 것');
    await waitForInit(page);
    await openStash(page, repo);
    await waitStashes(page, 3);

    await row(page, 0).click({ button: 'right' });
    await items(page).filter({ hasText: 'Apply (--index)' }).click();

    // index 가 복원됐으므로 staged 로 돌아온다 (porcelain 의 첫 칸이 M).
    await expect.poll(() => git(repo, 'status', '--porcelain'), { timeout: 20000 })
      .toMatch(/^M /m);
    expect(stashCount(repo)).toBe(3);
  });

  test('S4 (V56 / FR-GIT-164, V69 / FR-GIT-170): Pop 은 stash 를 지우고 목록을 갱신한다', async ({ page }) => {
    const repo = copyFx('stashes', 's4');
    git(repo, 'checkout', '--', '.');
    await waitForInit(page);
    await openStash(page, repo);
    await waitStashes(page, 2);

    await row(page, 0).click({ button: 'right' });
    await items(page).filter({ hasText: /^Pop$/ }).click();

    // 조작 후 목록이 갱신된다 — 폴링 주기를 기다리지 않는다 (FR-GIT-170).
    await waitStashes(page, 1);
    expect(stashCount(repo)).toBe(1);
    expect(git(repo, 'status', '--porcelain')).not.toBe('');
  });

  test('S5 (V57 / FR-GIT-165): pop 이 충돌하면 stash 가 남은 것을 명시한다', async ({ page }) => {
    const repo = copyFx('stashes', 's5');
    // stash@{1}(첫 번째 작업) 과 같은 줄을 건드리는 커밋을 얹는다 — pop 이 충돌한다.
    git(repo, 'commit', '-qam', '충돌을 만드는 커밋');
    await waitForInit(page);
    await openStash(page, repo);
    await waitStashes(page, 2);

    await row(page, 1).click({ button: 'right' });
    await items(page).filter({ hasText: /^Pop$/ }).click();

    // 실패인데도 "작업은 남아 있다" 를 그 자리에서 알린다 — 조용히 넘기면
    // 사용자가 작업을 잃었다고 오해한다.
    await expect(note(page)).toHaveClass(/vis/, { timeout: 20000 });
    await expect(note(page)).toHaveAttribute('data-kind', 'stash_kept');
    await expect(note(page).locator('.git-stash-note-msg')).toContainText('남겨');
    // 목록에 그대로 남아 있다 — 서버가 실패 응답에 목록을 함께 준다.
    await waitStashes(page, 2);
    expect(stashCount(repo)).toBe(2);
  });

  test('S6 (V58 / FR-GIT-166): 생성 다이얼로그는 메시지·untracked·keep-index 를 받는다', async ({ page }) => {
    const repo = copyFx('stashes', 's6');
    writeFileSync(join(repo, 'brand-new.txt'), 'untracked\n');
    await waitForInit(page);
    await openStash(page, repo);
    await waitStashes(page, 2);

    await st(page).locator('.git-stash-new').click();
    await expect(create(page)).toBeVisible();
    await expect(create(page).locator('.gsc-msg')).toHaveCount(1);
    // 옵션의 기본값은 안전한 쪽이다 (FR-GIT-97) — 둘 다 꺼져 있다.
    await expect(create(page).locator('.gsc-untracked')).not.toBeChecked();
    await expect(create(page).locator('.gsc-keepindex')).not.toBeChecked();

    await create(page).locator('.gsc-msg').fill('내가 만든 stash');
    await create(page).locator('.gsc-untracked').check();
    await create(page).locator('.gsc-go').click();

    await waitStashes(page, 3);
    await expect(row(page, 0).locator('.git-stash-msg')).toContainText('내가 만든 stash');
    // --include-untracked 를 켰으므로 untracked 도 담겼다.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('S7 (V58 / FR-GIT-167): 변경이 없으면 생성이 비활성이고 사유를 보인다', async ({ page }) => {
    const repo = copyFx('with-remote', 's7'); // 깨끗한 워킹 트리
    await waitForInit(page);
    await openStash(page, repo);
    await expect(st(page).locator('.git-stash-empty')).toHaveCount(1, { timeout: 20000 });

    const btn = st(page).locator('.git-stash-new');
    await expect(btn).toBeDisabled({ timeout: 20000 });
    // 사유 없이 꺼진 버튼은 사용자가 해소할 수 없다.
    await expect(st(page).locator('.git-stash-why')).toHaveClass(/vis/);
    await expect(st(page).locator('.git-stash-why')).not.toHaveText('');

    // 변경이 생기면 다시 열린다.
    writeFileSync(join(repo, 'f.txt'), 'now dirty\n');
    await expect(btn).toBeEnabled({ timeout: 20000 });
    await expect(st(page).locator('.git-stash-why')).not.toHaveClass(/vis/);
  });

  test('S8 (V58 / FR-GIT-168): drop 은 2단계 확인과 recovery hint 를 거친다', async ({ page }) => {
    const repo = copyFx('stashes', 's8');
    const oid = git(repo, 'rev-parse', 'stash@{0}');
    await waitForInit(page);
    await openStash(page, repo);
    await waitStashes(page, 2);

    await row(page, 0).click({ button: 'right' });
    await items(page).filter({ hasText: /^Drop$/ }).click();

    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await expect(confirm(page)).toHaveAttribute('data-action', 'stash_drop');
    // 1단계는 영향 범위, 2단계가 recovery hint 다.
    await expect(confirm(page)).toHaveAttribute('data-stage', '1');
    await expect(confirm(page).locator('.gc-target')).toHaveCount(1);
    await expect(confirm(page).locator('.gc-cancel')).toBeFocused();
    await confirm(page).locator('.gc-go').click();
    await expect(confirm(page)).toHaveAttribute('data-stage', '2');
    // hint 의 명령에 stash 의 sha 가 들어 있다 — 안내문만으로는 되살릴 수 없다.
    await expect(confirm(page).locator('.gc-hint-cmd')).toContainText(oid);
    await confirm(page).locator('.gc-go').click();

    await waitStashes(page, 1);
    expect(stashCount(repo)).toBe(1);
  });

  test('S9 (V69 / FR-GIT-169): 미리보기 파일을 누르면 Diff 탭이 커밋 축으로 열린다', async ({ page }) => {
    const repo = copyFx('stashes', 's9');
    await waitForInit(page);
    await openStash(page, repo);
    await waitStashes(page, 2);

    await row(page, 1).click();
    await expect(row(page, 1)).toHaveClass(/sel/);
    const files = st(page).locator('.git-stash-file');
    await expect(files).toHaveCount(1, { timeout: 20000 });
    await expect(files.first()).toHaveAttribute('data-path', 'f.txt');

    await files.first().click();
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-diff/);
    // 축은 commit-parent 이고 대상은 stash@{1} 이다.
    await expect(diff(page).locator('.git-diff-rev')).toContainText('commit ↔ parent');
    await expect(diff(page).locator('.git-diff-rev')).toContainText('stash@{1}');
    await expect(diff(page).locator('.git-diff-path')).toContainText('f.txt');
    await expect(diff(page).locator('.git-diff-body .monaco-diff-editor'))
      .toHaveCount(1, { timeout: 30000 });
  });

  test('S10 (V58 / FR-GIT-168): drop 을 취소하면 아무것도 지워지지 않는다', async ({ page }) => {
    const repo = copyFx('stashes', 's10');
    await waitForInit(page);
    await openStash(page, repo);
    await waitStashes(page, 2);

    await row(page, 0).click({ button: 'right' });
    await items(page).filter({ hasText: /^Drop$/ }).click();
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    // Enter 의 기본 동작은 취소다 (FR-GIT-176) — 파괴적 확인에서 실행이 아니다.
    await page.keyboard.press('Enter');
    await expect(page.locator('#git-confirm')).toHaveCount(0);

    await waitStashes(page, 2);
    expect(stashCount(repo)).toBe(2);
  });
});
