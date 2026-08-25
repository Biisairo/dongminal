import { execFileSync } from 'child_process';
import { realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M1_STEP56_CONTRACT §4 — Changes 탭. 검증 V22·V23·V24 + FR-GIT-36·39.
//
// 테스트 저장소는 scripts/git_fixture.sh 가 만든다 (design/README.md) — 테스트
// 안에서 git init 을 되풀이하지 않는다.

const FIXTURES = '/tmp/dm-git-fx-changes-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['scripts/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['scripts/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

// 서버는 rev-parse 로 정규화한 루트를 준다 (macOS 의 /tmp → /private/tmp).
// 활성 리포도 그 값이어야 헤더의 title 비교가 성립한다.
const fx = (name: string) => realpathSync(join(FIXTURES, name));

// 상태를 바꾸는 테스트는 픽스처를 복사해 쓴다 — 원본을 오염시키면 뒤 테스트가
// 앞 테스트의 순서에 묶인다.
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
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
}

const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const group = (page: Page, key: string) => changes(page).locator(`.git-group[data-group="${key}"]`);
const rows = (page: Page, key: string) => group(page, key).locator('.git-file');

test.describe('묶음 E — Changes 탭', () => {
  test('C1 (V22): 헤더에 리포명·브랜치가 나오고 원격 버튼은 전부 disabled 다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    const head = changes(page).locator('.git-head');
    await expect(head.locator('.git-head-repo')).toHaveText('basic', { timeout: 10000 });
    await expect(head.locator('.git-head-repo')).toHaveAttribute('title', repo);
    await expect(head.locator('.git-head-branch')).toHaveText('main', { timeout: 10000 });

    // 원격은 M3 다 — 자리만 있고 사유를 title 로 알린다.
    const remote = head.locator('.git-head-remote button');
    await expect(remote).toHaveCount(3);
    expect(await remote.evaluateAll((els) => els.every((e) => (e as HTMLButtonElement).disabled)),
      '원격 버튼이 활성화돼 있다').toBe(true);
    // 커밋 영역은 M2 에서 살아 있다 (FR-GIT-74~85). 메시지가 비어 있으므로
    // Commit 만 disabled 이고 그 사유가 보인다 (FR-GIT-84).
    const commit = changes(page).locator('.git-commit');
    await expect(commit.locator('.git-commit-msg')).toBeEnabled();
    await expect(commit.locator('.git-commit-amend input')).toBeEnabled();
    await expect(commit.locator('.git-commit-btn')).toBeDisabled();
    await expect(commit.locator('.git-commit-why')).toBeVisible();
  });

  test('C2 (V22): detached HEAD 저장소에서 detached 배지가 나온다', async ({ page }) => {
    const repo = fx('detached');
    await waitForInit(page);
    await openGit(page, repo);

    const head = changes(page).locator('.git-head');
    await expect(head.locator('.git-badge-detached')).toBeVisible({ timeout: 10000 });
    // 브랜치 자리에는 해시 앞 7자가 온다.
    await expect(head.locator('.git-head-branch')).toHaveText(/^[0-9a-f]{7}$/);
    // detached 면 upstream 배지를 겹쳐 보이지 않는다.
    await expect(head.locator('.git-badge-noupstream')).toHaveCount(0);
  });

  test('C3 (V22): upstream 없는 브랜치에서 noupstream 배지가 나온다', async ({ page }) => {
    const repo = fx('basic'); // 원격이 없다 → upstream 없음
    await waitForInit(page);
    await openGit(page, repo);
    await expect(changes(page).locator('.git-head .git-badge-noupstream')).toBeVisible({ timeout: 10000 });
  });

  test('C4 (V23): 파일을 만들면 untracked 그룹 개수가 늘고 행이 보인다', async ({ page }) => {
    const repo = copyFx('basic', 'c4');
    await waitForInit(page);
    await openGit(page, repo);

    const g = group(page, 'untracked');
    await expect(g.locator('.git-group-count')).toHaveText('(1)', { timeout: 10000 });
    writeFileSync(join(repo, 'c4-new.txt'), 'x');
    await expect(g.locator('.git-group-count')).toHaveText('(2)', { timeout: 10000 });
    await expect(g.locator('.git-file[data-path="c4-new.txt"]')).toBeVisible();
    await expect(g.locator('.git-file[data-path="c4-new.txt"] .git-file-st')).toHaveText('?');
  });

  test('C5 (V23): git add 한 파일이 staged 그룹에 있다', async ({ page }) => {
    const repo = copyFx('basic', 'c5');
    await waitForInit(page);
    await openGit(page, repo);

    await expect(rows(page, 'untracked').first()).toBeVisible({ timeout: 10000 });
    execFileSync('git', ['-C', repo, 'add', 'untracked.txt']);
    await expect(group(page, 'staged').locator('.git-file[data-path="untracked.txt"]'))
      .toBeVisible({ timeout: 10000 });
    await expect(group(page, 'untracked').locator('.git-group-count')).toHaveText('(0)');
  });

  test('C6 (V23): 트리/플랫 토글이 동작한다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    const files = changes(page).locator('.git-files');
    await expect(rows(page, 'changes').first()).toBeVisible({ timeout: 10000 });
    // 기본은 플랫 — 디렉터리 노드가 없고 경로가 통째로 보인다.
    await expect(files.locator('.git-dir')).toHaveCount(0);
    await expect(rows(page, 'changes').filter({ hasText: '디렉터리 한글/파일 이름.txt' })).toHaveCount(1);

    await files.locator('.git-files-mode[data-mode="tree"]').click();
    await expect(files.locator('.git-dir').first()).toBeVisible();
    await expect(files.locator('.git-dir .git-dir-name').filter({ hasText: '디렉터리 한글' }).first())
      .toBeVisible();

    await files.locator('.git-files-mode[data-mode="flat"]').click();
    await expect(files.locator('.git-dir')).toHaveCount(0);
  });

  test('C7 (V24): 우클릭 메뉴에 3항목이 있고 파괴적 항목이 없다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    const row = rows(page, 'untracked').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.click({ button: 'right' });
    // 17단계가 이 메뉴를 GitMenu 프레임워크로 흡수했다 (FR-GIT-146).
    const menu = page.locator('.git-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.git-menu-item')).toHaveText(['Open Changes', 'Open File', 'Copy Path']);

    // M1 에는 저장소를 바꾸는 항목이 하나도 없다 (FR-GIT-41).
    const text = (await menu.textContent()) || '';
    for (const bad of ['Stage', 'stage', 'Unstage', 'Discard', 'discard', 'Commit', '커밋', '되돌리기', '버리기']) {
      expect(text, `파괴적 메뉴 항목이 있다: ${bad}`).not.toContain(bad);
    }

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('C8 (FR-GIT-39): 목록을 스크롤해도 커밋 영역이 화면에 남는다', async ({ page }) => {
    const repo = fx('many-files');
    await waitForInit(page);
    await openGit(page, repo);

    const commit = changes(page).locator('.git-commit');
    const files = changes(page).locator('.git-files');
    await expect(rows(page, 'changes').first()).toBeVisible({ timeout: 20000 });
    await expect(commit).toBeInViewport();
    const before = (await commit.boundingBox())!;

    const scrolled = await files.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(scrolled, '목록이 스크롤되지 않았다 — 스크롤 컨테이너가 .git-files 가 아니다')
      .toBeGreaterThan(0);

    await expect(commit).toBeInViewport();
    const after = (await commit.boundingBox())!;
    expect(Math.abs(after.y - before.y), '커밋 영역이 목록과 함께 스크롤됐다').toBeLessThan(1);
  });

  test('C9 (FR-GIT-36): rename 한 파일이 원본 → 대상 으로 보인다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    const row = group(page, 'staged').locator('.git-file[data-path="renamed to.txt"]');
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.locator('.git-file-path')).toHaveText('renamed from.txt → renamed to.txt');
    await expect(row).toHaveAttribute('data-orig-path', 'renamed from.txt');
    // title 에 유사도가 실린다 (R100).
    await expect(row).toHaveAttribute('title', /100/);
  });
});
