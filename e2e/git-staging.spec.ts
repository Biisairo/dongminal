import { execFileSync } from 'child_process';
import { readFileSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M2_STEP1011_CONTRACT §3 — 스테이징 클라이언트. 검증 V30·V32·V37
// (E1·E2·E8 + FR-GIT-72).
//
// 테스트 저장소는 scripts/git_fixture.sh 가 만든다 (design/README.md) — 테스트
// 안에서 git init 을 되풀이하지 않는다. 상태를 **바꾸는** 테스트는 픽스처를
// 복사해 쓴다.

const FIXTURES = '/tmp/dm-git-fx-staging-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['scripts/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['scripts/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

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
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
}

const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const group = (page: Page, key: string) => changes(page).locator(`.git-group[data-group="${key}"]`);
const count = (page: Page, key: string) => group(page, key).locator('.git-group-count');
const row = (page: Page, key: string, path: string) =>
  group(page, key).locator(`.git-file[data-path="${path}"]`);
const allRows = (page: Page) => changes(page).locator('.git-files .git-file');

// 인라인 동작 버튼은 자리를 늘 잡고 hover 에서만 보인다 — 클릭 전에 행 위로
// 옮겨야 사용자와 같은 경로를 지난다.
async function act(page: Page, key: string, path: string, action: string) {
  const r = row(page, key, path);
  await expect(r).toBeVisible({ timeout: 10000 });
  await r.hover();
  await r.locator(`.git-file-act[data-act="${action}"]`).click();
}

test.describe('묶음 H — 스테이징 (클라이언트)', () => {
  test('E1 (V30): 파일 단위 stage/unstage 가 목록에 반영된다', async ({ page }) => {
    const repo = copyFx('basic', 'e1');
    await waitForInit(page);
    await openGit(page, repo);

    await expect(count(page, 'untracked')).toHaveText('(1)', { timeout: 10000 });
    await act(page, 'untracked', 'untracked.txt', 'stage');

    // FR-GIT-71: 폴링 주기를 기다리지 않고 응답의 status 로 즉시 갱신된다.
    await expect(row(page, 'staged', 'untracked.txt')).toBeVisible({ timeout: 3000 });
    await expect(count(page, 'untracked')).toHaveText('(0)');

    await act(page, 'staged', 'untracked.txt', 'unstage');
    await expect(row(page, 'untracked', 'untracked.txt')).toBeVisible({ timeout: 3000 });
  });

  test('E1b (V30): 그룹 일괄 stage/unstage 가 그룹 전체에 걸린다', async ({ page }) => {
    const repo = copyFx('basic', 'e1b');
    await waitForInit(page);
    await openGit(page, repo);

    await expect(count(page, 'changes')).toHaveText('(2)', { timeout: 10000 });
    await group(page, 'changes').locator('.git-group-bulk[data-act="stage"]').click();
    await expect(count(page, 'changes')).toHaveText('(0)', { timeout: 5000 });

    // staged 그룹 일괄은 언스테이지다 (FR-GIT-67).
    await group(page, 'staged').locator('.git-group-bulk[data-act="unstage"]').click();
    await expect(count(page, 'staged')).toHaveText('(0)', { timeout: 5000 });
  });

  test('E1c (V30): 다중 선택과 Shift 범위 선택으로 일괄 stage 한다', async ({ page }) => {
    const repo = copyFx('basic', 'e1c');
    await waitForInit(page);
    await openGit(page, repo);

    // conflicts(0) + staged(2) + changes(2) + untracked(1)
    await expect(allRows(page)).toHaveCount(5, { timeout: 10000 });
    const sel = changes(page).locator('.git-sel');
    await expect(sel).toBeHidden();

    // 체크박스 하나 → 선택 1개.
    await allRows(page).nth(2).locator('.git-file-check').click();
    await expect(sel).toBeVisible();
    await expect(changes(page).locator('.git-sel-count')).toHaveText('선택 1개');

    // Shift 는 목록 순서대로 범위를 고른다 (FR-GIT-69).
    await allRows(page).nth(4).locator('.git-file-check').click({ modifiers: ['Shift'] });
    await expect(changes(page).locator('.git-sel-count')).toHaveText('선택 3개');

    await changes(page).locator('.git-sel-act[data-act="stage"]').click();
    await expect(count(page, 'changes')).toHaveText('(0)', { timeout: 5000 });
    await expect(count(page, 'untracked')).toHaveText('(0)');
    // 처리한 대상은 선택에서 빠진다 — 같은 선택이 남아 다음 동작에 끌려가지 않는다.
    await expect(sel).toBeHidden();
  });

  test('E2 (V32): 일부만 staged 인 파일이 구분 표시된다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    const r = row(page, 'staged', '디렉터리 한글/파일 이름.txt');
    await expect(r).toBeVisible({ timeout: 10000 });
    await expect(r).toHaveClass(/partial/);
    await expect(r).toHaveAttribute('title', /일부만 스테이지됨/);
    // FR-GIT-70: 체크박스의 indeterminate 로도 구분한다.
    expect(await r.locator('.git-file-check')
      .evaluate((el) => (el as HTMLInputElement).indeterminate),
      'indeterminate 가 아니다').toBe(true);

    // 온전히 staged 인 파일은 partial 이 아니다.
    const clean = row(page, 'staged', 'renamed to.txt');
    await expect(clean).not.toHaveClass(/partial/);
    expect(await clean.locator('.git-file-check')
      .evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(false);
  });

  test('E8 (V37): discard 가 2단계 확인을 거치고 파일 목록을 보인다', async ({ page }) => {
    const repo = copyFx('basic', 'e8');
    await waitForInit(page);
    await openGit(page, repo);

    await act(page, 'changes', 'tracked.txt', 'discard');

    // 1단계는 영향 범위다 — 개수만이 아니라 목록을 보인다 (FR-GIT-91).
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await expect(box).toHaveAttribute('data-action', 'discard');
    await expect(box.locator('.gc-target')).toHaveText(['tracked.txt']);
    await expect(box.locator('.gc-count')).toContainText('1개');
    // 파괴적이므로 2단계다 — 1단계에서는 아직 실행 버튼이 아니다.
    await expect(box.locator('.gc-go')).toHaveText('계속');
    await expect(box.locator('.gc-hint')).toBeHidden();

    await box.locator('.gc-go').click();
    // 2단계는 recovery hint 를 보인다 (FR-GIT-92). stash 는 안내만이다 (O8).
    await expect(box.locator('.gc-hint')).toBeVisible();
    await expect(box.locator('.gc-hint-cmd')).toContainText('git stash push -- tracked.txt');
    await expect(box.locator('.gc-go')).toHaveText('실행');

    await box.locator('.gc-go').click();
    await expect(box).toHaveCount(0, { timeout: 10000 });
    await expect(row(page, 'changes', 'tracked.txt')).toHaveCount(0, { timeout: 5000 });
    // 워킹 트리가 실제로 되돌아갔다.
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('one\n');
  });

  test('E8b (V37): discard 를 취소하면 아무것도 바뀌지 않는다', async ({ page }) => {
    const repo = copyFx('basic', 'e8b');
    await waitForInit(page);
    await openGit(page, repo);

    await act(page, 'changes', 'tracked.txt', 'discard');
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await box.locator('.gc-cancel').click();
    await expect(box).toHaveCount(0);

    await expect(row(page, 'changes', 'tracked.txt')).toBeVisible();
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  test('E10 (FR-GIT-72): 충돌 파일 stage 는 해결됨 표시임을 먼저 알린다', async ({ page }) => {
    const repo = copyFx('conflict', 'e10');
    await waitForInit(page);
    await openGit(page, repo);

    await act(page, 'conflicts', 'c.txt', 'stage');

    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await expect(box.locator('.gc-head')).toHaveText('충돌을 해결됨으로 표시합니다');
    await expect(box.locator('.gc-target')).toHaveText(['c.txt']);
    // 파괴적이 아니므로 1단계다 — 바로 실행 버튼이다.
    await expect(box.locator('.gc-go')).toHaveText('실행');

    await box.locator('.gc-go').click();
    await expect(box).toHaveCount(0, { timeout: 10000 });
    await expect(count(page, 'conflicts')).toHaveText('(0)', { timeout: 5000 });
    await expect(row(page, 'staged', 'c.txt')).toBeVisible();
  });

  test('E10b (FR-GIT-72): 알림을 취소하면 충돌이 그대로 남는다', async ({ page }) => {
    const repo = copyFx('conflict', 'e10b');
    await waitForInit(page);
    await openGit(page, repo);

    await act(page, 'conflicts', 'c.txt', 'stage');
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await box.locator('.gc-cancel').click();
    await expect(box).toHaveCount(0);
    await expect(row(page, 'conflicts', 'c.txt')).toBeVisible();
  });
});
