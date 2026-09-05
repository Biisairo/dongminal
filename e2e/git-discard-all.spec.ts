import { execFileSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit } from './fixtures';

// WORKBENCH_REVIEW_SRS 묶음 D — `Changes`·`Untracked` 의 Discard All
// (FR-WBR-50~56, 검증 V-WBR-50~57).
//
// 폭 시험(V-WBR-58 / NFR-WBR-10)은 여기 없다 — 규칙이 사는 `repo-tab` 묶음 N 의
// N3 이고, 그 파일에 `setSideWidth`·`measure` 장치가 이미 있다.

const FIXTURES = '/tmp/dm-git-fx-discardall-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const copyFx = makeCopyFx(FIXTURES);

async function openGit(page: Page, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
  });
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const group = (page: Page, key: string) => changes(page).locator(`.git-group[data-group="${key}"]`);
const count = (page: Page, key: string) => group(page, key).locator('.git-group-count');
const bulk = (page: Page, key: string) => group(page, key).locator('.git-group-bulk');
// 아이콘은 뜻의 출처가 아니다 — `data-act` 가 그것이다 (`GIT_GROUP_BULK` 의 값).
const bulkAct = (page: Page, key: string, act: string) =>
  group(page, key).locator(`.git-group-bulk[data-act="${act}"]`);
const row = (page: Page, key: string, path: string) =>
  group(page, key).locator(`.git-file[data-path="${path}"]`);
const box = (page: Page) => page.locator('#git-confirm .gc-box');

// 한글 파일 이름은 픽스처가 정한다 — 여기서 되풀이하지 않는다.
const KO = '디렉터리 한글/파일 이름.txt';

async function rowAct(page: Page, key: string, path: string, action: string) {
  const r = row(page, key, path);
  await expect(r).toBeVisible({ timeout: 10000 });
  await r.hover();
  await r.locator(`.git-file-act[data-act="${action}"]`).click();
}

test.describe('묶음 D — Changes·Untracked 의 Discard All', () => {
  test('D1 (V-WBR-50·51 / FR-WBR-50·51·52·52a): 아이콘 둘과 그 순서, 그리고 갈리는 툴팁',
    async ({ page }) => {
      const repo = copyFx('basic', 'd1');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'changes')).toHaveText('(2)', { timeout: 10000 });

      // FR-WBR-50·51·52: 행 동작과 **같은 어휘**의 아이콘이고 파괴적인 것이
      // 오른쪽이다. 글자 라벨은 220px 에 들어가지 않는다 (D-WBR-18).
      await expect(bulk(page, 'changes')).toHaveText(['+', '↺']);
      await expect(bulk(page, 'untracked')).toHaveText(['+', '↺']);
      // staged 는 그대로 하나다 — 폐기가 뜻을 갖지 않는다.
      await expect(bulk(page, 'staged')).toHaveText(['−']);

      // FR-WBR-52a: 갈리는 것은 툴팁이다 — untracked 의 폐기는 삭제이고 되살릴
      // 수 없다. 두 그룹의 명령이 다르다는 사실을 여기서 말한다.
      await expect(bulk(page, 'changes').nth(1)).toHaveAttribute('title', /버립니다/);
      const del = bulk(page, 'untracked').nth(1);
      await expect(del).toHaveAttribute('title', /삭제/);
      await expect(del).toHaveAttribute('title', /되살릴 수 없/);
    });

  test('D1b (V-WBR-59 / NFR-WBR-10): 기본 폭에서 네 그룹의 머리 높이가 같다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd1b');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'changes')).toHaveText('(2)', { timeout: 10000 });

      // 아이콘을 고른 이유가 이것이다 — 글자 라벨은 줄을 늘려 36→71px 이 됐다.
      const hs = await changes(page).locator('.git-group-head').evaluateAll(
        (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      expect([...new Set(hs)], '머리 높이가 그룹마다 다르다: ' + JSON.stringify(hs))
        .toHaveLength(1);
    });

  test('D2 (V-WBR-52 / FR-WBR-50): Changes 의 Discard All 은 그룹 전부를 되돌리고 staged 분은 남긴다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd2');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'changes')).toHaveText('(2)', { timeout: 10000 });

      await bulkAct(page, 'changes', 'discard').click();
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      // 그려진 행이 아니라 그룹 전체다 (FR-GIT-66·67 의 규약).
      await expect(box(page).locator('.gc-count')).toContainText('2개');
      await box(page).locator('.gc-go').click();
      await expect(box(page)).toHaveCount(0, { timeout: 10000 });

      await expect(count(page, 'changes')).toHaveText('(0)', { timeout: 5000 });
      // 워킹 트리가 index 로 돌아갔다.
      expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('one\n');
      expect(readFileSync(join(repo, KO), 'utf8')).toBe('ko\nboth\n');
      // staged 분은 남는다 — discard 는 index 를 건드리지 않는다.
      await expect(row(page, 'staged', KO)).toBeVisible();
      await expect(row(page, 'staged', 'renamed to.txt')).toBeVisible();
    });

  test('D3 (V-WBR-53 / FR-WBR-50·52): Untracked 의 Delete All 은 파일을 지운다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd3');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'untracked')).toHaveText('(1)', { timeout: 10000 });
      expect(existsSync(join(repo, 'untracked.txt'))).toBeTruthy();

      await bulkAct(page, 'untracked', 'discard').click();
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      await box(page).locator('.gc-go').click();
      await expect(box(page)).toHaveCount(0, { timeout: 10000 });

      await expect(count(page, 'untracked')).toHaveText('(0)', { timeout: 5000 });
      // 되돌리기가 아니라 삭제다 — 라벨이 말한 그대로다.
      expect(existsSync(join(repo, 'untracked.txt'))).toBeFalsy();
      // tracked 쪽은 건드리지 않는다.
      expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('one\ntwo\n');
    });

  test('D4 (V-WBR-54 / FR-WBR-53): 그룹이 비면 두 버튼이 다 비활성이다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd4');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'untracked')).toHaveText('(1)', { timeout: 10000 });

      // 처음에는 둘 다 살아 있다.
      await expect(bulk(page, 'untracked').nth(0)).toBeEnabled();
      await expect(bulk(page, 'untracked').nth(1)).toBeEnabled();

      await bulkAct(page, 'untracked', 'stage').click();
      await expect(count(page, 'untracked')).toHaveText('(0)', { timeout: 5000 });

      // 지금은 그룹의 **유일한** 버튼에만 걸리므로 이 단언이 둘째를 잡는다.
      await expect(bulk(page, 'untracked').nth(0)).toBeDisabled();
      await expect(bulk(page, 'untracked').nth(1)).toBeDisabled();
    });

  test('D5 (V-WBR-55 / FR-WBR-54): Conflicts 머리에는 폐기가 없다',
    async ({ page }) => {
      const repo = copyFx('conflict', 'd5');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'conflicts')).toHaveText('(1)', { timeout: 10000 });

      // 일괄 자체가 없다 — 충돌 stage 는 "해결됨 표시" 라 한 번에 밀 동작이 아니다.
      await expect(bulk(page, 'conflicts')).toHaveCount(0);
    });

  test('D6 (V-WBR-56 / FR-WBR-55): 확인창의 note 가 그룹에 맞춰 갈린다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd6');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'untracked')).toHaveText('(1)', { timeout: 10000 });

      // untracked — 파일 자체가 사라지고 되살릴 값이 없다는 것을 먼저 말한다.
      await bulkAct(page, 'untracked', 'discard').click();
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      const note = box(page).locator('.gc-hint-note');
      await expect(note).toContainText('삭제');
      await expect(note).toContainText('되살릴 값이 없');
      await box(page).locator('.gc-cancel').click();
      await expect(box(page)).toHaveCount(0);

      // tracked — 되돌리기이므로 그 말을 하지 않는다.
      await bulkAct(page, 'changes', 'discard').click();
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      await expect(box(page).locator('.gc-hint-note')).not.toContainText('되살릴 값이 없');
    });

  test('D7 (V-WBR-57 / FR-WBR-56): recovery hint 의 명령이 언제나 `-u` 를 갖는다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd7');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'untracked')).toHaveText('(1)', { timeout: 10000 });

      // ① 그룹 일괄 — untracked 만. `-u` 가 없으면 이 명령이 실패한다 (SRS §2.7).
      await bulkAct(page, 'untracked', 'discard').click();
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      await expect(box(page).locator('.gc-hint-cmd')).toContainText('git stash push -u -- ');
      await box(page).locator('.gc-cancel').click();
      await expect(box(page)).toHaveCount(0);

      // ② 행의 `↺` 도 같은 자리를 지난다 — 고치는 것이 한 자리라는 뜻이다.
      await rowAct(page, 'untracked', 'untracked.txt', 'discard');
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      await expect(box(page).locator('.gc-hint-cmd')).toContainText('git stash push -u -- ');
      await box(page).locator('.gc-cancel').click();
      await expect(box(page)).toHaveCount(0);

      // ③ tracked 만이어도 `-u` 다 — 붙여도 대상이 넓어지지 않는다 (실측).
      await rowAct(page, 'changes', 'tracked.txt', 'discard');
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      await expect(box(page).locator('.gc-hint-cmd')).toContainText('git stash push -u -- ');
    });
});
