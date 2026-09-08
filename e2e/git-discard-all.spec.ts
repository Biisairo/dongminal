import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, openGit as fxOpenGit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, cssPath } from './osenv';

// WORKBENCH_REVIEW_SRS 묶음 D — 워킹 그룹의 Discard All (FR-WBR-50~56,
// 검증 V-WBR-50~57).
//
// PANEL_SURFACE_SRS FR-CMG-6·7·8 (V-9)로 **두 그룹이 하나가 됐다.** 종전에는
// `Changes` 와 `Untracked` 가 각자 폐기 버튼을 가졌고 뜻은 툴팁에만 있었다.
// 지금은 버튼 하나가 둘을 지나며, 되돌림과 삭제를 가르는 자리는 **확인창**이다 —
// 그것이 유일한 방어선이므로(SRS §5) 확인창 없이 실행되는 길이 없어야 한다.
//
// 폭 시험(V-WBR-58 / NFR-WBR-10)은 여기 없다 — 규칙이 사는 `repo-tab` 묶음 N 의
// N3 이고, 그 파일에 `setSideWidth`·`measure` 장치가 이미 있다.

const FIXTURES = tmpPath('dm-git-fx-discardall-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);

async function openGit(page: Page, repo: string) {
  await fxOpenGit(page, repo);
}

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const group = (page: Page, key: string) => changes(page).locator(`.git-group[data-group="${key}"]`);
const count = (page: Page, key: string) => group(page, key).locator('.git-group-count');
const bulk = (page: Page, key: string) => group(page, key).locator('.git-group-bulk');
// 아이콘은 뜻의 출처가 아니다 — `data-act` 가 그것이다 (`GIT_GROUP_BULK` 의 값).
const bulkAct = (page: Page, key: string, act: string) =>
  group(page, key).locator(`.git-group-bulk[data-act="${act}"]`);
const row = (page: Page, key: string, path: string) =>
  group(page, key).locator(`.git-file[data-path="${cssPath(path)}"]`);
const box = (page: Page) => page.locator('#git-confirm .gc-box');

// 한글 파일 이름은 픽스처가 정한다 — 여기서 되풀이하지 않는다.
const KO = '디렉터리 한글/파일 이름.txt';

async function rowAct(page: Page, key: string, path: string, action: string) {
  const r = row(page, key, path);
  await expect(r).toBeVisible({ timeout: 10000 });
  await r.hover();
  await r.locator(`.git-file-act[data-act="${action}"]`).click();
}

test.describe('묶음 D — 워킹 그룹의 Discard All', () => {
  test('D1 (V-WBR-50·51 / FR-CMG-6): 아이콘 둘과 그 순서, 그리고 삭제를 알리는 툴팁',
    async ({ page }) => {
      const repo = copyFx('basic', 'd1');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'working')).toHaveText('(3)', { timeout: 10000 });

      // FR-WBR-50·51·52: 행 동작과 **같은 어휘**의 아이콘이고 파괴적인 것이
      // 오른쪽이다. FR-CMG-6: 일괄은 `stage` 하나와 `discard` 하나다.
      //
      // 뜻의 출처는 `data-act` 다 — 라벨이 글자에서 스프라이트 아이콘이 됐고
      // (UI_KIT_SRS §7.1), 글자를 재면 그 교체가 이 시험을 깨뜨린다.
      expect(await bulk(page, 'working').evaluateAll(
        (els) => els.map((e) => (e as HTMLElement).dataset.act))).toEqual(['stage', 'discard']);
      // staged 는 그대로 하나다 — 폐기가 뜻을 갖지 않는다.
      expect(await bulk(page, 'staged').evaluateAll(
        (els) => els.map((e) => (e as HTMLElement).dataset.act))).toEqual(['unstage']);
      // 요구 ③/⑤: 아이콘이 상자를 꽉 채운다 — 스프라이트를 참조하는 `<svg>` 다.
      await expect(bulk(page, 'working').first().locator('svg.ui-icon use'))
        .toHaveAttribute('href', '#i-plus');

      // 버튼 하나가 삭제를 포함하므로 툴팁이 그 사실을 말한다. 정확한 내역은
      // 확인창이 보인다 (FR-CMG-7).
      const del = bulk(page, 'working').nth(1);
      await expect(del).toHaveAttribute('title', /Discard/);
      await expect(del).toHaveAttribute('title', /deleted/);
      await expect(del).toHaveAttribute('title', /cannot be undone/);

      // FR-CMG-5: **행**의 폐기는 그 행의 출신을 말한다 — 그룹이 아니다.
      const nu = row(page, 'working', 'untracked.txt');
      await nu.hover();
      await expect(nu.locator('.git-file-act[data-act="discard"]'))
        .toHaveAttribute('title', /Delete this file/);
      const tr = row(page, 'working', 'tracked.txt');
      await tr.hover();
      await expect(tr.locator('.git-file-act[data-act="discard"]'))
        .toHaveAttribute('title', 'Discard changes');
    });

  test('D1b (V-WBR-59 / NFR-WBR-10): 기본 폭에서 그룹 머리의 높이가 같다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd1b');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'working')).toHaveText('(3)', { timeout: 10000 });

      // 아이콘을 고른 이유가 이것이다 — 글자 라벨은 줄을 늘려 36→71px 이 됐다.
      const hs = await changes(page).locator('.git-group:not(.gone) .git-group-head').evaluateAll(
        (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      expect([...new Set(hs)], '머리 높이가 그룹마다 다르다: ' + JSON.stringify(hs))
        .toHaveLength(1);
      // FR-CMG-1: 그룹은 셋이되 충돌이 없는 `basic` 에서는 둘만 선다.
      expect(hs).toHaveLength(2);
    });

  test('D2 (V-9 / FR-CMG-7·8): 확인창이 되돌릴 것과 지울 것을 나눠 보이고, 둘 다 실행된다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd2');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'working')).toHaveText('(3)', { timeout: 10000 });
      expect(existsSync(join(repo, 'untracked.txt'))).toBeTruthy();

      await bulkAct(page, 'working', 'discard').click();
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      // 그려진 행이 아니라 그룹 전체다 (FR-GIT-66·67 의 규약).
      await expect(box(page).locator('.gc-count')).toContainText('3개');
      // FR-CMG-7: 두 무리를 나눠 보인다 — 되돌릴 수 없는 삭제가 눈에 보여야 한다.
      await expect(box(page).locator('.gc-target-sect')).toHaveText(['되돌릴 2개', '지울 1개']);

      await box(page).locator('.gc-go').click();
      await expect(box(page)).toHaveCount(0, { timeout: 10000 });

      await expect(count(page, 'working')).toHaveText('(0)', { timeout: 5000 });
      // FR-CMG-8: 두 명령이 다 실행됐다 — 되돌림(checkout)과 삭제(clean).
      expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('one\n');
      expect(readFileSync(join(repo, KO), 'utf8')).toBe('ko\nboth\n');
      expect(existsSync(join(repo, 'untracked.txt'))).toBeFalsy();
      // staged 분은 남는다 — discard 는 index 를 건드리지 않는다.
      await expect(row(page, 'staged', KO)).toBeVisible();
      await expect(row(page, 'staged', 'renamed to.txt')).toBeVisible();
    });

  test('D3 (V-9 / FR-CMG-7): 지울 것이 없으면 그 무리를 적지 않는다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd3');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'working')).toHaveText('(3)', { timeout: 10000 });

      // 새 파일을 스테이지로 옮기면 워킹 그룹에는 되돌릴 것만 남는다.
      await rowAct(page, 'working', 'untracked.txt', 'stage');
      await expect(count(page, 'working')).toHaveText('(2)', { timeout: 10000 });

      await bulkAct(page, 'working', 'discard').click();
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      // 무리가 하나뿐이면 머리를 붙이지 않는다 — 읽을 것만 늘어난다.
      await expect(box(page).locator('.gc-target-sect')).toHaveCount(0);
      await expect(box(page).locator('.gc-count')).toContainText('2개');
      await box(page).locator('.gc-go').click();
      await expect(box(page)).toHaveCount(0, { timeout: 10000 });

      // 스테이지로 옮겨 둔 새 파일은 지워지지 않았다.
      expect(existsSync(join(repo, 'untracked.txt'))).toBeTruthy();
    });

  test('D4 (V-WBR-54 / FR-WBR-53): 그룹이 비면 두 버튼이 다 비활성이다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd4');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'working')).toHaveText('(3)', { timeout: 10000 });

      // 처음에는 둘 다 살아 있다.
      await expect(bulk(page, 'working').nth(0)).toBeEnabled();
      await expect(bulk(page, 'working').nth(1)).toBeEnabled();

      await bulkAct(page, 'working', 'stage').click();
      await expect(count(page, 'working')).toHaveText('(0)', { timeout: 10000 });

      await expect(bulk(page, 'working').nth(0)).toBeDisabled();
      await expect(bulk(page, 'working').nth(1)).toBeDisabled();
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

  test('D6 (V-WBR-56 / FR-CMG-5): 확인창의 note 가 대상의 출신에 맞춰 갈린다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd6');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'working')).toHaveText('(3)', { timeout: 10000 });

      // 새 파일이 섞여 있다 — 파일 자체가 사라지고 되살릴 값이 없다는 것을 먼저 말한다.
      await rowAct(page, 'working', 'untracked.txt', 'discard');
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      const note = box(page).locator('.gc-hint-note');
      await expect(note).toContainText('삭제');
      await expect(note).toContainText('되살릴 값이 없');
      await box(page).locator('.gc-cancel').click();
      await expect(box(page)).toHaveCount(0);

      // tracked 만이면 되돌리기이므로 그 말을 하지 않는다.
      await rowAct(page, 'working', 'tracked.txt', 'discard');
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      await expect(box(page).locator('.gc-hint-note')).not.toContainText('되살릴 값이 없');
    });

  test('D7 (V-WBR-57 / FR-WBR-56): recovery hint 의 명령이 언제나 `-u` 를 갖는다',
    async ({ page }) => {
      const repo = copyFx('basic', 'd7');
      await waitForInit(page);
      await openGit(page, repo);
      await expect(count(page, 'working')).toHaveText('(3)', { timeout: 10000 });

      // ① 그룹 일괄 — 두 출신이 섞인다. `-u` 가 없으면 이 명령이 실패한다 (SRS §2.7).
      await bulkAct(page, 'working', 'discard').click();
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      await expect(box(page).locator('.gc-hint-cmd')).toContainText('git stash push -u -- ');
      await box(page).locator('.gc-cancel').click();
      await expect(box(page)).toHaveCount(0);

      // ② 행의 `↺` 도 같은 자리를 지난다 — 고치는 것이 한 자리라는 뜻이다.
      await rowAct(page, 'working', 'untracked.txt', 'discard');
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      await expect(box(page).locator('.gc-hint-cmd')).toContainText('git stash push -u -- ');
      await box(page).locator('.gc-cancel').click();
      await expect(box(page)).toHaveCount(0);

      // ③ tracked 만이어도 `-u` 다 — 붙여도 대상이 넓어지지 않는다 (실측).
      await rowAct(page, 'working', 'tracked.txt', 'discard');
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      await expect(box(page).locator('.gc-hint-cmd')).toContainText('git stash push -u -- ');
    });
});
