import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, GIT_VIEW_TABS, GIT_BODY_VIEWS } from './fixtures';

/**
 * UX_BATCH5_SRS 묶음 D — Submodules 탭 (FR-SUB-1~11).
 *
 * 픽스처는 부모 저장소 하나에 서브모듈 둘이다: 하나는 초기화됨(`ok`), 하나는
 * 초기화되지 않음(`-`). 둘이 함께 있어야 "상태에 따라 할 수 있는 일이 다르다"
 * (FR-SUB-8)를 잴 수 있다.
 *
 * `protocol.file.allow=always` 가 필요한 것은 git 2.38+ 이 로컬 경로의 서브모듈을
 * 기본으로 막기 때문이다 (CVE-2022-39253). 픽스처 안에서만 켠다.
 */

let BASE = '';

const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) =>
  execFileSync('git', ['-C', d, ...a], { stdio: 'pipe' });

// 커밋에 신원과 서명 설정을 매번 실어 보낸다 — 호스트의 전역 설정에 기대지 않는다.
const commit = (d: string, msg: string) =>
  execFileSync('git', [
    '-C', d, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', msg,
  ], { stdio: 'pipe' });

function mkRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', '.');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/**
 * 부모 + 서브모듈 둘. 하나는 초기화된 채로, 하나는 `deinit` 으로 비워 둔다.
 *
 * `deinit` 을 쓰는 이유는 그것이 사용자가 실제로 만나는 상태이기 때문이다 —
 * 갓 clone 한 저장소의 서브모듈이 그 모습이다.
 */
function mkTree(tag: string) {
  const root = j(BASE, tag);
  fs.mkdirSync(root, { recursive: true });
  const modA = mkRepo(j(root, 'mod-a'));
  fs.writeFileSync(j(modA, 'a.txt'), 'A\n');
  git(modA, 'add', '-A'); commit(modA, 'init a');
  const modB = mkRepo(j(root, 'mod-b'));
  fs.writeFileSync(j(modB, 'b.txt'), 'B\n');
  git(modB, 'add', '-A'); commit(modB, 'init b');

  const parent = mkRepo(j(root, 'parent'));
  fs.writeFileSync(j(parent, 'top.txt'), 'top\n');
  git(parent, 'add', '-A'); commit(parent, 'init parent');
  const add = (src: string, dst: string) =>
    execFileSync('git', [
      '-C', parent, '-c', 'protocol.file.allow=always',
      'submodule', 'add', '-q', src, dst,
    ], { stdio: 'pipe' });
  add(modA, 'vendor/alpha');
  add(modB, 'vendor/beta');
  commit(parent, 'add submodules');
  // beta 만 비운다 — alpha 는 초기화된 채로 남는다.
  git(parent, 'submodule', 'deinit', '-f', 'vendor/beta');
  return fs.realpathSync(parent);
}

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-gsub-')));
});
test.afterAll(() => {
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

async function openSubmodules(page: Page, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate((views: readonly string[]) => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    for (const v of views) a.gitPanel.openView(v);
  }, GIT_BODY_VIEWS);
  // FR-SUB-6: 고정 탭이 하나 늘었다.
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await page.click('#area .pn-tab[data-git-view="submodules"]');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-submodules/);
}

const sub = (page: Page) => page.locator('#area .pn-body .git-view.git-submodules');
const row = (page: Page, p: string) => sub(page).locator(`.git-sub-row[data-path="${p}"]`);
const box = (page: Page) => page.locator('#git-confirm .gc-box');
// Submodules 탭의 행. 위의 `row` 와 같은 것이지만 이름을 갈라 두어야
// 어느 표면을 보는지가 시험 본문에서 읽힌다.
const row2 = (page: Page, p: string) => row(page, p);

const actsOf = (page: Page, p: string) =>
  row(page, p).locator('.git-sub-act').evaluateAll(
    (els) => els.map((e) => (e as HTMLElement).dataset.act));

test.describe('묶음 D — Submodules 탭', () => {
  test('D1 (V-SUB-1 / FR-SUB-1·2·6): 탭이 서고 두 서브모듈이 각자의 상태로 보인다',
    async ({ page }) => {
      await waitForInit(page);
      await openSubmodules(page, mkTree('d1'));

      await expect(row(page, 'vendor/alpha')).toBeVisible({ timeout: 15000 });
      await expect(row(page, 'vendor/beta')).toBeVisible();
      // 상태의 출처는 `git submodule status` 의 접두 문자다 — 우리가 계산하지 않는다.
      await expect(row(page, 'vendor/alpha')).toHaveAttribute('data-state', 'ok');
      await expect(row(page, 'vendor/beta')).toHaveAttribute('data-state', 'uninitialized');
      // 등록된 커밋 앞 7자 (머리·History 와 같은 규약).
      await expect(row(page, 'vendor/alpha').locator('.git-sub-oid'))
        .toHaveText(/^[0-9a-f]{7}$/);
    });

  test('D2 (V-SUB-2 / FR-SUB-8): 상태에 따라 할 수 있는 일이 다르다', async ({ page }) => {
    await waitForInit(page);
    await openSubmodules(page, mkTree('d2'));
    await expect(row(page, 'vendor/beta')).toBeVisible({ timeout: 15000 });

    expect(await actsOf(page, 'vendor/alpha')).toEqual(['open', 'update', 'sync', 'term']);
    // 초기화되지 않은 것에는 **열 저장소가 없다** — 눌리지만 아무 일도 하지 않는
    // 버튼은 고장으로 읽힌다 (FR-GIT-180).
    expect(await actsOf(page, 'vendor/beta')).toEqual(['init', 'sync']);
  });

  /**
   * FR-SUB-8 (D-10): 서브모듈을 여는 것은 **worktree 와 같은 경로**다
   * (`openGitWindow`). 연결 저장소를 여는 길이 둘이면 한쪽만 고쳐진다.
   */
  test('D3 (V-SUB-3 / FR-SUB-8): Open 이 그 서브모듈의 Repo 창을 연다', async ({ page }) => {
    await waitForInit(page);
    const repo = mkTree('d3');
    await openSubmodules(page, repo);
    const r = row(page, 'vendor/alpha');
    await expect(r).toBeVisible({ timeout: 15000 });

    await r.locator('.git-sub-act[data-act="open"]').click();
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return a._isEditorWin(a._aw()) ? a._edRootOf(a._aw()) : null;
    }), { timeout: 15000 }).toBe(j(repo, 'vendor', 'alpha'));
  });

  /**
   * FR-SUB-5: `init` 은 `update --init` 이며 **파괴적 확인**을 거친다. 확인창은
   * 실행될 명령을 밝힌다 — 무엇이 도는지 모른 채 누르는 일이 없어야 한다.
   */
  test('D4 (V-SUB-4 / FR-SUB-4·5): Init 이 확인을 거쳐 서브모듈을 채운다', async ({ page }) => {
    await waitForInit(page);
    const repo = mkTree('d4');
    await openSubmodules(page, repo);
    await expect(row(page, 'vendor/beta')).toBeVisible({ timeout: 15000 });
    // 비어 있다 — deinit 이 그렇게 두었다.
    expect(fs.existsSync(j(repo, 'vendor', 'beta', 'b.txt'))).toBeFalsy();

    await row(page, 'vendor/beta').locator('.git-sub-act[data-act="init"]').click();
    await expect(box(page)).toBeVisible({ timeout: 10000 });
    await expect(box(page)).toContainText('submodule update --init');
    await box(page).locator('.gc-go').click();
    await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 30000 });

    // 상태가 바뀌면 행의 동작도 따라 바뀐다 (FR-SUB-8).
    await expect(row(page, 'vendor/beta')).toHaveAttribute('data-state', 'ok', { timeout: 30000 });
    expect(fs.existsSync(j(repo, 'vendor', 'beta', 'b.txt'))).toBeTruthy();
  });

  test('D5 (V-SUB-5 / FR-SUB-5): 확인을 취소하면 아무것도 바뀌지 않는다', async ({ page }) => {
    await waitForInit(page);
    const repo = mkTree('d5');
    await openSubmodules(page, repo);
    await expect(row(page, 'vendor/beta')).toBeVisible({ timeout: 15000 });

    await row(page, 'vendor/beta').locator('.git-sub-act[data-act="init"]').click();
    await expect(box(page)).toBeVisible({ timeout: 10000 });
    await box(page).locator('.gc-cancel').click();
    await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 10000 });

    await expect(row(page, 'vendor/beta')).toHaveAttribute('data-state', 'uninitialized');
    expect(fs.existsSync(j(repo, 'vendor', 'beta', 'b.txt'))).toBeFalsy();
  });

  /**
   * FR-SUB-9: 머리의 일괄은 **전부**가 대상이다. 경로를 비워 보내는 것이 그 뜻이며,
   * 확인창의 대상이 그 사실을 말한다.
   */
  test('D6 (V-SUB-6 / FR-SUB-9): Update all 이 초기화되지 않은 것까지 채운다',
    async ({ page }) => {
      await waitForInit(page);
      const repo = mkTree('d6');
      await openSubmodules(page, repo);
      await expect(row(page, 'vendor/beta')).toBeVisible({ timeout: 15000 });

      await sub(page).locator('.git-sub-bulk[data-act="update"]').click();
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      // 경로가 없으므로 명령에도 경로가 없다 — 그것이 "전부" 다.
      await expect(box(page)).toContainText('submodule update --init');
      await box(page).locator('.gc-go').click();
      await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 30000 });

      await expect(row(page, 'vendor/beta')).toHaveAttribute('data-state', 'ok', { timeout: 30000 });
      expect(fs.existsSync(j(repo, 'vendor', 'beta', 'b.txt'))).toBeTruthy();
    });

  test('D7 (V-SUB-7 / FR-SUB-10): 서브모듈이 없으면 그 사실을 말한다 — 탭은 남는다',
    async ({ page }) => {
      await waitForInit(page);
      const plain = mkRepo(j(BASE, 'd7-plain'));
      fs.writeFileSync(j(plain, 'f.txt'), 'x\n');
      git(plain, 'add', '-A'); commit(plain, 'init');
      await openSubmodules(page, fs.realpathSync(plain));

      await expect(sub(page).locator('.git-sub-empty')).toHaveClass(/vis/, { timeout: 15000 });
      await expect(sub(page).locator('.git-sub-row')).toHaveCount(0);
      // FR-WBR-53 과 같은 근거 — 대상이 없는 일괄은 뜻이 없다.
      await expect(sub(page).locator('.git-sub-bulk[data-act="update"]')).toBeDisabled();
      await expect(sub(page).locator('.git-sub-bulk[data-act="sync"]')).toBeDisabled();
    });

  /**
   * FR-SUB-11: Changes 에서 서브모듈 행을 고르면 **그것을 관리하는 자리**로 가는
   * 길이 함께 선다. `저장소로 이동`(서브모듈 자신의 창)과 다른 목적이다.
   *
   * 중첩 저장소에는 붙지 않는다 — `.gitmodules` 에 없으므로 그 탭에 자기 행이
   * 없고, 눌러도 빈 목록이 열린다 (FR-GIT-180).
   */
  test('D9 (V-SUB-9 / FR-SUB-11): 서브모듈 행에서 Submodules 탭으로 가는 길이 있다',
    async ({ page }) => {
      await waitForInit(page);
      const repo = mkTree('d9');
      await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
      await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
      await page.evaluate((views: readonly string[]) => {
        const a = (window as any).app;
        a._edSetSide(a._aw(), 'changes');
        for (const v of views) a.gitPanel.openView(v);
      }, GIT_BODY_VIEWS);

      // 서브모듈이 디렉터리 항목으로 서려면 그 안에 변경이 있어야 한다.
      fs.writeFileSync(j(repo, 'vendor', 'alpha', 'a.txt'), 'A changed\n');
      const side = page.locator('#area .ed-side .git-view.git-changes');
      const row = side.locator('.git-file[data-path="vendor/alpha"]');
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.click();

      const diff = page.locator('#area .pn-body .git-view.git-diff');
      await expect(diff).toBeVisible({ timeout: 15000 });
      const link = diff.locator('button', { hasText: 'Submodules' });
      await expect(link).toBeVisible({ timeout: 15000 });
      await link.click();

      await expect(page.locator('#area .pn-body .git-view.vis'))
        .toHaveClass(/git-submodules/, { timeout: 10000 });
      await expect(row2(page, 'vendor/alpha')).toBeVisible({ timeout: 15000 });
    });

  /**
   * FR-SUB-4: `sync` 는 체크아웃을 건드리지 않는다 — 1단계 확인이며, 실행 뒤에도
   * 상태가 그대로다. 그것이 `update` 와 갈리는 자리다 (FR-SUB-5).
   */
  test('D8 (V-SUB-8 / FR-SUB-4·5): Sync 는 상태를 바꾸지 않는다', async ({ page }) => {
    await waitForInit(page);
    const repo = mkTree('d8');
    await openSubmodules(page, repo);
    await expect(row(page, 'vendor/alpha')).toBeVisible({ timeout: 15000 });

    await row(page, 'vendor/alpha').locator('.git-sub-act[data-act="sync"]').click();
    await expect(box(page)).toBeVisible({ timeout: 10000 });
    await expect(box(page)).toContainText('submodule sync');
    await box(page).locator('.gc-go').click();
    await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 20000 });

    await expect(sub(page).locator('.git-sub-note')).toHaveClass(/vis/, { timeout: 10000 });
    await expect(row(page, 'vendor/alpha')).toHaveAttribute('data-state', 'ok');
  });
});
