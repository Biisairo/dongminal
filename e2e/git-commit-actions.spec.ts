import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// GIT_ACTIONS_SRS §3.4 — 묶음 D 커밋 동작 (FR-GIT-263~267, 검증 V191~V194).
//
// Cherry-pick · Revert · Reset to here · Drop · Compare with. 다섯은 History 의
// 커밋 우클릭에서 열리고, 위험도가 서로 다르다 — **파괴 선언이 옵션에서
// 파생한다**(`reset --hard` 만)는 것이 이 판의 핵심이며 V192 가 그것을 본다.
//
// 픽스처를 `git_fixture.sh` 에 더하지 않는다. 이 파일의 시험은 **저장소를 바꾸는
// 것**이라 공유 픽스처를 재사용하면 테스트끼리 서로를 오염시킨다 —
// `git-operation.spec.ts` 가 같은 이유로 자기 저장소를 만든다. 만드는 방식(설정
// 3줄·gpgsign off)은 `git_fixture.sh` 의 `init` 과 같다.

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
}

function newRepo(tag: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-git-co-' + tag + '-')));
  git(dir, 'init', '-q', '-b', 'main', '.');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function commit(dir: string, name: string, body: string, msg: string) {
  writeFileSync(join(dir, name), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
}

// 선형 저장소: c1 → c2 → c3. drop·reset·compare 가 쓴다.
function linearRepo(tag: string) {
  const dir = newRepo(tag);
  // 커밋마다 **다른 파일**을 건드린다. 같은 파일을 쌓아 올리면 가운데를 빼는 순간
  // 뒤 커밋의 패치가 자리를 잃어 리베이스가 충돌로 멈춘다 — 그것은 git 의 옳은
  // 동작이지 drop 의 실패가 아니므로(그때는 묶음 A 의 출구가 답이다), 여기서는
  // 서로 기대지 않는 커밋으로 "그 커밋만 빠진다"를 본다.
  commit(dir, 'a.txt', 'one\n', 'c1');
  commit(dir, 'b.txt', 'two\n', 'c2');
  commit(dir, 'c.txt', 'three\n', 'c3');
  return dir;
}

// 머지 커밋이 **HEAD 가 아닌 자리에** 있는 저장소. cherry-pick·revert 의 부모
// 선택(V191)이 그것을 대상으로 한다 — HEAD 커밋은 항목이 비활성이므로
// (뜻이 없는 동작이다) 머지가 HEAD 이면 시험 자체가 열리지 않는다.
function mergeRepo(tag: string) {
  const dir = newRepo(tag);
  commit(dir, 'base.txt', 'base\n', 'c1');
  git(dir, 'checkout', '-q', '-b', 'side');
  commit(dir, 'side.txt', 'side\n', 'from side');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'main.txt', 'main\n', 'from main');
  git(dir, 'merge', '--no-ff', '-q', '-m', 'merge side', 'side');
  commit(dir, 'after.txt', 'after\n', 'after merge');
  return dir;
}

// 충돌로 멈춘 머지. FR-GIT-252 의 "진행 중이면 새 작업을 시작할 수 없다" 를 본다.
//
// main 에 `m1` 을 하나 더 둔다 — 시험할 행은 **HEAD 도 루트도 머지도 아니어야**
// 그 항목이 막힌 이유가 "진행 중" 하나로 좁혀진다.
function stuckRepo(tag: string) {
  const dir = newRepo(tag);
  commit(dir, 'f.txt', 'base\n', 'init');
  commit(dir, 'g.txt', 'g\n', 'm1');
  git(dir, 'checkout', '-q', '-b', 'side');
  commit(dir, 'f.txt', 'side\n', 'side');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'f.txt', 'main\n', 'main');
  try {
    git(dir, 'merge', 'side');
  } catch {
    /* 충돌이 이 픽스처의 목적이다 */
  }
  return dir;
}

async function openHistory(page: Page, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  // REPO_TAB_UNIFY_SRS: 창의 모양이 바뀌었다 — `Changes` 는 **사이드**에 살고
  // 나머지 여섯 뷰는 **본문 탭**으로 필요할 때 열린다 (FR-RTU-30·32). 스펙들이
  // "탭을 클릭한다" 로 뷰를 고르므로 여기서 여섯을 미리 세운다.
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees']) p.openView(v);
  });
  await page.click('#area .pn-tab[data-git-view="history"]');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-history/);
  await expect(rows(page).first()).toBeVisible({ timeout: 20000 });
}

async function openChanges(page: Page, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  // REPO_TAB_UNIFY_SRS: 창의 모양이 바뀌었다 — `Changes` 는 **사이드**에 살고
  // 나머지 여섯 뷰는 **본문 탭**으로 필요할 때 열린다 (FR-RTU-30·32). 스펙들이
  // "탭을 클릭한다" 로 뷰를 고르므로 여기서 여섯을 미리 세운다.
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees']) p.openView(v);
  });
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const hist = (page: Page) => page.locator('#area .pn-body .git-view.git-history');
const rows = (page: Page) => hist(page).locator('.git-hist-row[data-oid]');
const menu = (page: Page) => page.locator('.git-menu');
const item = (page: Page, id: string) => menu(page).locator(`.git-menu-item[data-id="${id}"]`);
const dialog = (page: Page) => page.locator('.git-dialog .git-dialog-box');
const dialogGo = (page: Page) => dialog(page).locator('.git-dialog-go');
const confirmBox = (page: Page) => page.locator('#git-confirm .gc-box');
const diff = (page: Page) => page.locator('#area .pn-body .git-view.git-diff');

// 제목으로 커밋 행을 고른다 — 해시를 테스트가 따로 들고 있으면 픽스처를 고칠
// 때마다 테스트가 함께 깨진다.
const rowOf = (page: Page, subject: string) =>
  rows(page).filter({ has: page.locator('.git-hist-subject', { hasText: subject }) }).first();

async function openMenuOn(page: Page, subject: string) {
  await rowOf(page, subject).click({ button: 'right' });
  await expect(menu(page)).toHaveCount(1);
  expect(await menu(page).getAttribute('data-kind')).toBe('commit');
}

const headOid = (dir: string) => git(dir, 'rev-parse', 'HEAD').trim();
const subjects = (dir: string) =>
  git(dir, 'log', '--format=%s').split('\n').map((s) => s.trim()).filter(Boolean);

test.describe('묶음 D — 커밋 동작 (V191~V194)', () => {
  const dirs: string[] = [];
  const keep = (d: string) => {
    dirs.push(d);
    return d;
  };
  test.afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // ── V191: 머지 커밋의 부모를 묻는다 ──

  test('D1 (V191 / FR-GIT-263): 머지 커밋의 cherry-pick 은 부모를 묻고, 묻지 않고 실행하지 않는다', async ({ page }) => {
    const repo = keep(mergeRepo('d1'));
    const before = headOid(repo);
    await waitForInit(page);
    await openHistory(page, repo);

    await openMenuOn(page, 'merge side');
    await item(page, 'cherry-pick').click();

    // **다이얼로그가 뜬다.** 곧장 실행되면 틀린 부모를 집은 채 끝난다.
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });
    expect(await dialog(page).getAttribute('data-action')).toBe('cherry_pick');
    // 부모 수만큼의 선택지가 있다 — 머지 커밋의 부모는 둘이다.
    await expect(dialog(page).locator('input[data-key="mainline"]')).toHaveCount(2);

    // 취소하면 저장소는 그대로다.
    await page.keyboard.press('Escape');
    await expect(page.locator('.git-dialog')).toHaveCount(0, { timeout: 10000 });
    await page.waitForTimeout(500);
    expect(headOid(repo), '취소했는데 실행됐다').toBe(before);
  });

  test('D2 (V191 / FR-GIT-264): 머지 커밋의 revert 도 같은 부모 선택을 받고, 고르면 되돌리는 커밋이 생긴다', async ({ page }) => {
    const repo = keep(mergeRepo('d2'));
    const before = subjects(repo).length;
    await waitForInit(page);
    await openHistory(page, repo);

    await openMenuOn(page, 'merge side');
    await item(page, 'revert').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });
    expect(await dialog(page).getAttribute('data-action')).toBe('revert');
    await expect(dialog(page).locator('input[data-key="mainline"]')).toHaveCount(2);
    // `--no-commit` 은 옵션으로 함께 있고 **기본은 꺼짐**이다 (FR-GIT-173).
    const noCommit = dialog(page).locator('input[data-key="noCommit"]');
    await expect(noCommit).toHaveCount(1);
    expect(await noCommit.isChecked()).toBe(false);

    // 첫 부모를 기준으로 되돌린다.
    await dialog(page).locator('input[data-key="mainline"][value="1"]').check();
    await dialogGo(page).click();
    await expect(page.locator('.git-dialog')).toHaveCount(0, { timeout: 20000 });

    await expect.poll(() => subjects(repo).length, { timeout: 20000 }).toBe(before + 1);
    expect(subjects(repo)[0]).toContain('Revert');
  });

  // ── V192: reset 은 영향 커밋 수를 보이고 --hard 만 확인을 거친다 ──

  test('D3 (V192 / FR-GIT-265): reset 다이얼로그가 영향 커밋 수를 보이고, mixed 는 확인 없이 실행된다', async ({ page }) => {
    const repo = keep(linearRepo('d3'));
    const target = git(repo, 'rev-parse', 'HEAD~2').trim();
    await waitForInit(page);
    await openHistory(page, repo);

    await openMenuOn(page, 'c1');
    await item(page, 'reset').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });

    // 영향 커밋 수가 실행 **전에** 보인다 (G11) — c1..HEAD 는 2개다.
    await expect(dialog(page).locator('.git-dialog-body')).toContainText('2', { timeout: 10000 });
    // 세 모드가 있고 **첫 선택지가 기본**이다 (FR-GIT-173).
    const modes = dialog(page).locator('input[data-key="mode"]');
    await expect(modes).toHaveCount(3);
    expect(await modes.first().getAttribute('value')).toBe('mixed');
    expect(await modes.first().isChecked()).toBe(true);

    await dialogGo(page).click();
    // mixed 는 잃는 것이 없다 — 확인이 뜨지 않는다.
    await expect(confirmBox(page)).toHaveCount(0);
    await expect.poll(() => headOid(repo), { timeout: 20000 }).toBe(target);
    // 워킹 트리는 남는다 (mixed 의 뜻) — 되돌린 내용이 unstaged 로 있다.
    expect(git(repo, 'status', '--porcelain').trim().length).toBeGreaterThan(0);
  });

  test('D4 (V192 / FR-GIT-89·265): `--hard` 만 확인을 거치고, 확인을 취소하면 HEAD 가 움직이지 않는다', async ({ page }) => {
    const repo = keep(linearRepo('d4'));
    const before = headOid(repo);
    await waitForInit(page);
    await openHistory(page, repo);

    await openMenuOn(page, 'c1');
    await item(page, 'reset').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });
    await dialog(page).locator('input[data-key="mode"][value="hard"]').check();
    await dialogGo(page).click();

    // 파괴 선언이 **옵션에서 파생한다** — hard 를 고른 순간에만 확인이 뜬다.
    await expect(confirmBox(page)).toBeVisible({ timeout: 10000 });
    expect(await confirmBox(page).getAttribute('data-action')).toBe('reset_hard');
    // hint 는 되살릴 수 있는 명령이며 그 한 화면에 함께 있다 (FR-GIT-92·250.2, FR-COS-2).
    await expect(confirmBox(page).locator('.gc-hint-cmd')).toContainText('reset --hard ' + before);

    // 취소하면 저장소는 그대로다.
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 10000 });
    await page.waitForTimeout(500);
    expect(headOid(repo), '취소했는데 --hard 가 실행됐다').toBe(before);
  });

  // ── V193: drop 은 그 커밋만 빼고 hint 로 되돌아간다 ──

  test('D5 (V193 / FR-GIT-266): drop 이 그 커밋만 빼고, hint 의 명령이 원래 HEAD 로 되돌린다', async ({ page }) => {
    const repo = keep(linearRepo('d5'));
    const before = headOid(repo);
    await waitForInit(page);
    await openHistory(page, repo);

    await openMenuOn(page, 'c2');
    // 파괴적이므로 항목 자체가 확인을 연다 — 다이얼로그를 따로 세우지 않는다.
    await item(page, 'drop').click();
    await expect(confirmBox(page)).toBeVisible({ timeout: 10000 });
    expect(await confirmBox(page).getAttribute('data-action')).toBe('commit_drop');
    await expect(confirmBox(page).locator('.gc-hint-cmd')).toContainText('reset --hard ' + before);
    await confirmBox(page).locator('.gc-go').click();
    await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 20000 });

    // c2 만 빠졌다 — c1·c3 는 남는다.
    await expect.poll(() => subjects(repo).join(','), { timeout: 20000 }).toBe('c3,c1');

    // hint 가 실제로 되돌린다 (FR-GIT-92) — 안내문이 아니라 명령이다.
    git(repo, 'reset', '--hard', before);
    expect(subjects(repo).join(',')).toBe('c3,c2,c1');
  });

  test('D6 (FR-GIT-266): 첫 커밋과 머지 커밋의 drop 은 비활성이고 사유가 보인다', async ({ page }) => {
    const repo = keep(mergeRepo('d6'));
    await waitForInit(page);
    await openHistory(page, repo);

    // 머지 커밋: `<oid>^` 는 첫 부모만 남기므로 나머지 갈래가 조용히 사라진다.
    await openMenuOn(page, 'merge side');
    await expect(item(page, 'drop')).toHaveClass(/disabled/);
    expect((await item(page, 'drop').getAttribute('title'))!.length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');

    // 첫 커밋: `^` 가 가리킬 것이 없다.
    await openMenuOn(page, 'c1');
    await expect(item(page, 'drop')).toHaveClass(/disabled/);
    await page.keyboard.press('Escape');
  });

  // ── V194: Compare with 는 이미 있는 rev↔rev 축으로 연다 ──

  test('D7 (V194 / FR-GIT-267): 커밋 둘을 골라 비교하면 Diff 탭이 rev↔rev 축으로 열린다', async ({ page }) => {
    const repo = keep(linearRepo('d7'));
    const c1 = git(repo, 'rev-parse', 'HEAD~2').trim();
    const head = headOid(repo);
    await waitForInit(page);
    await openHistory(page, repo);

    // 하나를 기준으로 표시하고,
    await openMenuOn(page, 'c1');
    await item(page, 'compare-mark').click();
    await expect(hist(page).locator('.git-hist-note')).toBeVisible({ timeout: 10000 });

    // 다른 하나에서 Compare with 를 연다 — 리비전 칸이 기준으로 채워져 있다.
    await openMenuOn(page, 'c3');
    await item(page, 'compare-with').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });
    expect(await dialog(page).locator('input[data-key="rev"]').inputValue()).toBe(c1);

    await dialog(page).locator('input[data-key="path"]').fill('f.txt');
    await dialogGo(page).click();
    await expect(page.locator('.git-dialog')).toHaveCount(0, { timeout: 20000 });

    // **새 축이 아니다** — 이미 있는 commit ↔ parent 축의 두 끝이다 (FR-GIT-138).
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-diff/);
    const rev = diff(page).locator('.git-diff-rev');
    await expect(rev).toBeVisible({ timeout: 10000 });
    await expect(rev).toContainText(c1.slice(0, 8));
    await expect(rev).toContainText(head.slice(0, 8));
  });

  test('D8 (V194 / FR-GIT-267): `A..B` 입력도 같은 자리로 들어온다', async ({ page }) => {
    const repo = keep(linearRepo('d8'));
    const c1 = git(repo, 'rev-parse', 'HEAD~2').trim();
    const c2 = git(repo, 'rev-parse', 'HEAD~1').trim();
    await waitForInit(page);
    await openHistory(page, repo);

    await openMenuOn(page, 'c3');
    await item(page, 'compare-with').click();
    await expect(dialog(page)).toBeVisible({ timeout: 10000 });

    // 범위 표현을 그대로 적는다 — 우클릭한 커밋(c3)은 오른쪽에서 밀려난다.
    await dialog(page).locator('input[data-key="rev"]').fill(c1 + '..' + c2);
    await dialog(page).locator('input[data-key="path"]').fill('f.txt');
    await dialogGo(page).click();
    await expect(page.locator('.git-dialog')).toHaveCount(0, { timeout: 20000 });

    const rev = diff(page).locator('.git-diff-rev');
    await expect(rev).toBeVisible({ timeout: 10000 });
    await expect(rev).toContainText(c1.slice(0, 8));
    await expect(rev).toContainText(c2.slice(0, 8));
  });

  // ── FR-GIT-252: 진행 중이면 새 작업을 시작할 수 없다 ──

  test('D9 (FR-GIT-252): 진행 중 작업이 있으면 네 항목이 비활성이고 사유가 보인다', async ({ page }) => {
    const repo = keep(stuckRepo('d9'));
    await waitForInit(page);
    // 진행 중 판정이 관측에 실릴 때까지 Changes 탭에서 기다린다 (FR-GIT-251).
    await openChanges(page, repo);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (((window as any).app.gitPanel.statusOf() || {}).operation || {}).kind || '',
          ),
        { timeout: 20000 },
      )
      .toBe('merge');

    await page.click('#area .pn-tab[data-git-view="history"]');
    await expect(rows(page).first()).toBeVisible({ timeout: 20000 });
    // HEAD 도 루트도 머지도 아닌 행이다 — 막힌 이유가 "진행 중" 하나로 좁혀진다.
    await openMenuOn(page, 'm1');

    for (const id of ['cherry-pick', 'revert', 'reset', 'drop']) {
      await expect(item(page, id), id + ' 가 진행 중인데 열려 있다').toHaveClass(/disabled/);
      // 왜 못 누르는지 보이지 않으면 사용자는 고장으로 읽는다 (FR-GIT-180).
      expect((await item(page, id).getAttribute('title'))!.length).toBeGreaterThan(0);
    }
    // Compare with 는 저장소를 바꾸지 않으므로 막지 않는다.
    await expect(item(page, 'compare-with')).not.toHaveClass(/disabled/);
  });
});
