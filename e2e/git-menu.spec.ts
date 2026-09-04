import { execFileSync } from 'child_process';
import { realpathSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, openGit, waitForInit } from './fixtures';

// GIT_M4_STEP1417_CONTRACT §4.2 — 컨텍스트 메뉴 프레임워크. 검증 V52 + FR-GIT-140~146.
//
// V52 의 요구는 "항목 집합만 선언한 가짜 kind 로 렌더·키보드·닫기가 동작함" 이다.
// 그래서 이 스펙은 GIT_MENUS 에 테스트용 kind 를 얹고 프레임워크만 시험한다 —
// 실제 항목의 동작은 커밋 메뉴(FR-GIT-142~144)로 따로 본다.

const FIXTURES = '/tmp/dm-git-fx-menu-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

const copyFx = makeCopyFx(FIXTURES);
async function openHistory(page: Page, repo: string) {
  await openGit(page, repo);
  await page.click('#area .pn-tab[data-git-view="history"]');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-history/);
}

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

const menu = (page: Page) => page.locator('.git-menu');
const items = (page: Page) => menu(page).locator('.git-menu-item');
const hist = (page: Page) => page.locator('#area .pn-body .git-view.git-history');
const confirmBox = (page: Page) => page.locator('#git-confirm .gc-box');
const choice = (page: Page) => page.locator('#git-choice .gch-box');
const create = (page: Page) => page.locator('#git-br-create .gbc-box');

// HEAD 가 아닌 커밋 행. 이미 HEAD 인 커밋으로는 옮겨 간 것도 시작점을 고정한 것도
// 볼 수 없다.
async function otherCommit(page: Page, repo: string) {
  const head = git(repo, 'rev-parse', 'HEAD');
  const row = hist(page).locator(`.git-hist-row[data-oid]:not([data-oid="${head}"])`).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  return { head, row, oid: (await row.getAttribute('data-oid'))! };
}

// 가짜 kind 를 선언한다 — 프레임워크가 항목 집합만으로 동작해야 한다 (V52).
// 실행 결과는 window.__menuRan 에 남긴다.
async function declareFakeKind(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__menuRan = [];
    w.GIT_MENUS.__v52 = [
      { id: 'a', label: '항목 A', run: () => w.__menuRan.push('a') },
      { id: 'b', label: '항목 B', run: () => w.__menuRan.push('b') },
      { sep: true },
      { id: 'off', label: '막힌 항목', disabled: () => '막힌 사유', run: () => w.__menuRan.push('off') },
      { id: 'c', label: '항목 C', run: () => w.__menuRan.push('c') },
    ];
  });
}

const openFake = (page: Page, x = 120, y = 120) =>
  page.evaluate(
    ([px, py]: number[]) =>
      (window as any).GitMenu.open('__v52', { id: 't1' }, { clientX: px, clientY: py }),
    [x, y],
  );

test.describe('17단계 — 컨텍스트 메뉴 프레임워크', () => {
  test('N1 (V52): 항목 집합 선언만으로 메뉴가 렌더된다 — 구분선·disabled 사유 포함', async ({ page }) => {
    await waitForInit(page);
    await declareFakeKind(page);
    await openFake(page);

    await expect(menu(page)).toBeVisible();
    await expect(items(page)).toHaveCount(4);
    await expect(items(page).nth(0)).toHaveText('항목 A');
    await expect(menu(page).locator('.git-menu-sep')).toHaveCount(1);
    // disabled 항목은 사유를 title 로 보인다 (계약 §4.2).
    const off = items(page).filter({ hasText: '막힌 항목' });
    await expect(off).toHaveClass(/disabled/);
    await expect(off).toHaveAttribute('title', '막힌 사유');
  });

  test('N2 (V52): ↑↓ 로 이동하고 Enter 로 실행한다 — disabled 는 건너뛴다', async ({ page }) => {
    await waitForInit(page);
    await declareFakeKind(page);
    await openFake(page);

    // 처음에는 아무 항목도 활성이 아니다 — 첫 ↓ 가 첫 항목을 잡는다.
    await page.keyboard.press('ArrowDown');
    await expect(items(page).nth(0)).toHaveClass(/active/);
    await page.keyboard.press('ArrowDown');
    await expect(items(page).nth(1)).toHaveClass(/active/);
    // 다음은 disabled 를 건너뛴 '항목 C' 다.
    await page.keyboard.press('ArrowDown');
    await expect(items(page).nth(3)).toHaveClass(/active/);
    await page.keyboard.press('ArrowUp');
    await expect(items(page).nth(1)).toHaveClass(/active/);

    await page.keyboard.press('Enter');
    await expect(menu(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__menuRan)).toEqual(['b']);
  });

  test('N3 (V52): Esc · 바깥 클릭으로 닫힌다', async ({ page }) => {
    await waitForInit(page);
    await declareFakeKind(page);

    await openFake(page);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);

    await openFake(page);
    await expect(menu(page)).toBeVisible();
    await page.mouse.click(900, 600);
    await expect(menu(page)).toHaveCount(0);
    // 닫기만 했고 아무 항목도 실행되지 않았다.
    expect(await page.evaluate(() => (window as any).__menuRan)).toEqual([]);
  });

  test('N4 (V52): 화면 경계에서 위치를 뒤집는다', async ({ page }) => {
    await waitForInit(page);
    await declareFakeKind(page);
    const vp = page.viewportSize()!;
    await openFake(page, vp.width - 2, vp.height - 2);

    const box = (await menu(page).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  });

  test('N5 (V52): warn:true 와 destructive:true 는 각각 자동으로 확인을 거치고, 파괴 여부가 테두리로 갈린다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => {
      const w = window as any;
      w.__menuRan = [];
      w.GIT_MENUS.__v52warn = [
        { id: 'w', label: '경고 항목', warn: true, action: '__v52_not_destructive',
          run: () => w.__menuRan.push('w') },
        // 'discard' 는 서버의 파괴적 목록에 있다 — 항목이 확인 코드를 따로 쓰지 않는다.
        { id: 'd', label: '파괴 항목', destructive: true, action: 'discard',
          run: () => w.__menuRan.push('d') },
      ];
    });

    await page.evaluate(() =>
      (window as any).GitMenu.open('__v52warn', { id: 't' }, { clientX: 100, clientY: 100 }));
    await items(page).filter({ hasText: '경고 항목' }).click();
    // 파괴적이 아닌 확인: soft 테두리이고 실행 버튼이 바로 '실행' 이다.
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible();
    await expect(box).toHaveClass(/soft/);
    await expect(box).toHaveAttribute('data-stage', '1');
    await box.locator('.gc-go').click();
    await expect(box).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__menuRan)).toEqual(['w']);

    await page.evaluate(() =>
      (window as any).GitMenu.open('__v52warn', { id: 't' }, { clientX: 100, clientY: 100 }));
    await items(page).filter({ hasText: '파괴 항목' }).click();
    await expect(box).toBeVisible();
    // 파괴적이면 soft 가 아니다 — 걸음 수가 아니라 이 클래스가 둘을 가른다 (FR-COS-3).
    await expect(box).not.toHaveClass(/soft/);
    await expect(box).toHaveAttribute('data-stage', '1');
    await box.locator('.gc-go').click();
    await expect(box).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__menuRan)).toEqual(['w', 'd']);
  });

  test('N6 (V66 / FR-GIT-142·143): 커밋 우클릭에서 해시·제목을 복사한다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    // 클립보드가 막힌 환경을 흉내내지 않고, 실제 복사 호출을 가로챈다.
    await page.evaluate(() => {
      const w = window as any;
      w.__copied = [];
      w.app.gitPanel.copyText = (t: string) => w.__copied.push(t);
    });
    await openHistory(page, repo);
    const row = hist(page).locator('.git-hist-row[data-oid]').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    const oid = await row.getAttribute('data-oid');

    await row.click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(items(page).filter({ hasText: '커밋 해시 복사' })).toHaveCount(1);
    await items(page).filter({ hasText: '커밋 해시 복사' }).click();
    expect(await page.evaluate(() => (window as any).__copied)).toEqual([oid]);

    await row.click({ button: 'right' });
    await items(page).filter({ hasText: '커밋 제목 복사' }).click();
    const copied: string[] = await page.evaluate(() => (window as any).__copied);
    expect(copied).toHaveLength(2);
    expect(copied[1]).not.toBe('');
    expect(copied[1]).not.toBe(oid);
  });

  test('N7 (V66 / FR-GIT-141·158): 커밋 우클릭에서 그 커밋을 시작점으로 브랜치를 만든다', async ({ page }) => {
    const repo = copyFx('with-remote', 'n7');
    await waitForInit(page);
    await openHistory(page, repo);
    const { head, row, oid } = await otherCommit(page, repo);

    await row.click({ button: 'right' });
    const it = items(page).filter({ hasText: '브랜치 생성' });
    await expect(it).not.toHaveClass(/disabled/);
    await it.click();

    // 18단계의 생성 다이얼로그를 그대로 쓴다 — 같은 것을 두 벌로 만들지 않는다.
    await expect(create(page)).toBeVisible();
    // 시작점은 우클릭한 커밋으로 고정돼 열린다 (FR-GIT-158).
    await expect(create(page).locator('.gbc-start')).toHaveValue(oid);
    // 만든 뒤 옮겨 가지 않는 것이 기본이다 (FR-GIT-97·173).
    await expect(create(page).locator('.gbc-checkout')).not.toBeChecked();

    // 이름 검사는 입력 단계에서 돈다 (FR-GIT-159) — 판정이 올 때까지 실행이 막힌다.
    await create(page).locator('.gbc-name').fill('from-commit');
    await expect(create(page).locator('.gbc-go')).toBeEnabled({ timeout: 15000 });
    await create(page).locator('.gbc-go').click();
    await expect(create(page)).toHaveCount(0, { timeout: 15000 });

    // 브랜치가 그 커밋을 가리키고, HEAD 는 움직이지 않았다.
    expect(git(repo, 'rev-parse', 'from-commit')).toBe(oid);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('N8 (V66 / FR-GIT-144·157, O14): dirty 면 3선택을 거치고 기본은 취소다', async ({ page }) => {
    const repo = copyFx('with-remote', 'n8');
    writeFileSync(join(repo, 'f.txt'), 'dirty\n');
    await waitForInit(page);
    await openHistory(page, repo);
    const { head, row } = await otherCommit(page, repo);
    // 판정은 status 를 딛는다 — 폴링이 한 번 온 뒤에 본다.
    await expect(hist(page).locator('.git-hist-row.uncommitted')).toHaveCount(1, { timeout: 15000 });

    await row.click({ button: 'right' });
    const it = items(page).filter({ hasText: 'detached' });
    // 더 이상 막지 않는다 — dirty 는 묶음 N 의 처리를 따른다 (FR-GIT-144).
    await expect(it).not.toHaveClass(/disabled/);
    await it.click();

    // detached 사전 경고는 dirty 여도 그대로 1단계다.
    await expect(confirmBox(page)).toBeVisible({ timeout: 15000 });
    await expect(confirmBox(page)).toHaveClass(/soft/);
    await confirmBox(page).locator('.gc-go').click();

    // 그 다음이 묶음 N 의 3선택이다 — Branches 탭과 같은 흐름이다 (FR-GIT-157).
    await expect(choice(page)).toBeVisible({ timeout: 15000 });
    const opts = choice(page).locator('.gch-opt');
    await expect(opts).toHaveCount(3);
    await expect(opts.nth(0)).toHaveAttribute('data-opt', 'cancel');
    await expect(opts.nth(1)).toHaveAttribute('data-opt', 'stash');
    await expect(opts.nth(2)).toHaveAttribute('data-opt', 'force');
    // 기본은 취소다 (FR-GIT-97, O14) — 강제가 기본이 아니다.
    await expect(choice(page).locator('.gch-opt[data-opt="cancel"]')).toBeFocused();

    // Esc 는 취소이고, 취소는 아무것도 하지 않는다 (FR-GIT-176).
    await page.keyboard.press('Escape');
    await expect(choice(page)).toHaveCount(0);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).not.toBe('');
  });

  test('N9 (V66 / FR-GIT-144): clean 이면 detached 경고를 1단계 거친 뒤 checkout 한다', async ({ page }) => {
    const repo = copyFx('with-remote', 'n9'); // clean 워킹 트리
    await waitForInit(page);
    await openHistory(page, repo);
    const rows = hist(page).locator('.git-hist-row[data-oid]');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    // HEAD 가 아닌 커밋을 고른다 — 이미 그 커밋이면 detached 로 옮겨진 것을 볼 수 없다.
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
    const target = hist(page)
      .locator(`.git-hist-row[data-oid]:not([data-oid="${head}"])`).first();
    const oid = await target.getAttribute('data-oid');

    await target.click({ button: 'right' });
    const it = items(page).filter({ hasText: 'detached' });
    await expect(it).not.toHaveClass(/disabled/);
    await it.click();
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible();
    await expect(box).toHaveClass(/soft/);
    await box.locator('.gc-go').click();
    await expect(box).toHaveCount(0);

    // 저장소가 실제로 그 커밋의 detached HEAD 가 된다.
    await expect
      .poll(() => execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim(),
        { timeout: 15000 })
      .toBe(oid);
    // detached 면 현재 브랜치가 없다.
    expect(execFileSync('git', ['-C', repo, 'branch', '--show-current']).toString().trim()).toBe('');
  });

  test('N10 (FR-GIT-146): 5단계의 파일 우클릭이 이 프레임워크로 흡수됐다', async ({ page }) => {
    const repo = copyFx('basic', 'n10');
    writeFileSync(join(repo, 'n10.txt'), 'x');
    await waitForInit(page);
    await openGit(page, repo);
    const file = page.locator('#area .ed-side .git-view.git-changes .git-file').first();
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click({ button: 'right' });
    // 같은 것을 두 번 만들지 않는다 — 옛 .git-ctxmenu 는 더 이상 없다.
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('.git-ctxmenu')).toHaveCount(0);
    await expect(items(page).filter({ hasText: 'Copy Path' })).toHaveCount(1);
  });

  test('N11 (V66 / FR-GIT-144·157): dirty 에서 stash 후 진행하면 변경이 stash 로 남고 detached 가 된다', async ({ page }) => {
    const repo = copyFx('with-remote', 'n11');
    writeFileSync(join(repo, 'f.txt'), 'keep-me\n');
    await waitForInit(page);
    await openHistory(page, repo);
    const { oid, row } = await otherCommit(page, repo);
    await expect(hist(page).locator('.git-hist-row.uncommitted')).toHaveCount(1, { timeout: 15000 });

    await row.click({ button: 'right' });
    await items(page).filter({ hasText: 'detached' }).click();
    await expect(confirmBox(page)).toBeVisible({ timeout: 15000 });
    await confirmBox(page).locator('.gc-go').click();
    await expect(choice(page)).toBeVisible({ timeout: 15000 });
    await choice(page).locator('.gch-opt[data-opt="stash"]').click();

    await expect
      .poll(() => git(repo, 'rev-parse', 'HEAD'), { timeout: 20000 })
      .toBe(oid);
    expect(git(repo, 'branch', '--show-current')).toBe('');
    // 변경은 버려지지 않았다.
    expect(git(repo, 'stash', 'list')).not.toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});