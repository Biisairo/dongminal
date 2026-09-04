import { execFileSync } from 'child_process';
import { realpathSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, GIT_VIEW_TABS } from './fixtures';

// GIT_M5_STEP1821_CONTRACT §1.3 — Branches 탭. 검증 V53~V55 · V67 · V68.
//
// 테스트 저장소는 e2e/git_fixture.sh 가 만든다 (design/README.md). 쓰기를
// 하는 스펙은 **복사본**에서 돈다 — 원본을 옮기면 뒤따르는 스펙이 다른 저장소를
// 본다.

const FIXTURES = '/tmp/dm-git-fx-br-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

const copyFx = makeCopyFx(FIXTURES);
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

async function openBranches(page: Page, repo: string) {
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
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await page.click('#area .pn-tab[data-git-view="branches"]');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-branches/);
}

const br = (page: Page) => page.locator('#area .pn-body .git-view.git-branches');
const group = (page: Page, key: string) => br(page).locator(`.git-br-group[data-group="${key}"]`);
const rows = (page: Page) => br(page).locator('.git-br-row');
const row = (page: Page, short: string) =>
  br(page).locator(`.git-br-row[data-short="${short}"]`);
const menu = (page: Page) => page.locator('.git-menu');
const items = (page: Page) => menu(page).locator('.git-menu-item');
const confirm = (page: Page) => page.locator('#git-confirm .gc-box');
const choice = (page: Page) => page.locator('#git-choice .gch-box');
const create = (page: Page) => page.locator('#git-br-create .gbc-box');

// 목록이 한 번 채워질 때까지 기다린다 — refs 조회는 비동기다.
async function waitRefs(page: Page, min = 1) {
  await expect.poll(() => rows(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(min);
}

test.describe('18단계 — Branches 탭', () => {
  test('B1 (V53 / FR-GIT-147·148·152·153): 로컬·원격 그룹, 현재 브랜치, upstream, ahead', async ({ page }) => {
    await waitForInit(page);
    await openBranches(page, fx('with-remote'));
    await waitRefs(page, 3);

    // 그룹은 로컬 / 원격 / 태그 + 즐겨찾기다 (FR-GIT-148·149).
    for (const k of ['fav', 'local', 'remote', 'tag']) {
      await expect(group(page, k)).toHaveCount(1);
    }
    // 로컬에 main·no-upstream, 원격에 origin/main 이 있다.
    await expect(group(page, 'local').locator('.git-br-row[data-short="main"]')).toHaveCount(1);
    await expect(group(page, 'local').locator('.git-br-row[data-short="no-upstream"]')).toHaveCount(1);
    await expect(group(page, 'remote').locator('.git-br-row[data-short="origin/main"]')).toHaveCount(1);

    // FR-GIT-152: 현재 브랜치는 main 이다.
    await expect(row(page, 'main')).toHaveClass(/current/);
    await expect(row(page, 'main').locator('.git-br-cur')).toHaveCount(1);
    await expect(row(page, 'no-upstream')).not.toHaveClass(/current/);

    // FR-GIT-153: ahead 1 · upstream 표시. 0 은 숨긴다.
    await expect(row(page, 'main').locator('.git-br-ab')).toHaveText('↑1');
    await expect(row(page, 'main').locator('.git-br-up')).toHaveText('(origin/main)');
    // upstream 이 없는 브랜치는 그 자리가 비어 있다 — 없는 값을 발명하지 않는다.
    await expect(row(page, 'no-upstream').locator('.git-br-up')).toHaveText('');
    await expect(row(page, 'no-upstream').locator('.git-br-ab')).toHaveText('');
  });

  test('B2 (FR-GIT-153): upstream 사라짐은 ahead/behind 0 과 구분해 보인다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b2');
    // upstream 설정은 남기고 원격 추적 ref 만 지운다 — for-each-ref 가 [gone] 을 준다.
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await expect(row(page, 'main').locator('.git-br-gone')).toHaveCount(1);
    await expect(row(page, 'main').locator('.git-br-gone')).not.toHaveText('');
    // upstream 이 애초에 없는 브랜치는 gone 이 아니다 — 둘을 같게 보이면 실패다.
    await expect(row(page, 'no-upstream').locator('.git-br-gone')).toHaveCount(0);
  });

  test('B3 (FR-GIT-150): 접두사 그룹핑은 접을 수 있다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b3');
    git(repo, 'branch', 'feature/a');
    git(repo, 'branch', 'feature/b');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 4);

    const pfx = group(page, 'local').locator('.git-br-pfx[data-prefix="feature/"]');
    await expect(pfx).toHaveCount(1);
    await expect(pfx.locator('.git-br-row')).toHaveCount(2);
    // 접두사가 없는 이름은 그룹 밖에 그대로 있다.
    await expect(group(page, 'local').locator('> .git-br-group-body > .git-br-row[data-short="main"]'))
      .toHaveCount(1);

    await pfx.locator('.git-br-pfx-head').click();
    await expect(pfx.locator('.git-br-row')).toHaveCount(0);
    await pfx.locator('.git-br-pfx-head').click();
    await expect(pfx.locator('.git-br-row')).toHaveCount(2);
  });

  test('B4 (FR-GIT-151): 부분 일치 검색은 일치 항목의 상위 그룹을 펼친다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b4');
    git(repo, 'branch', 'feature/needle');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    const pfx = group(page, 'local').locator('.git-br-pfx[data-prefix="feature/"]');
    // 먼저 접어 둔다 — 검색이 스스로 펼치는 것을 봐야 한다.
    await pfx.locator('.git-br-pfx-head').click();
    await expect(pfx.locator('.git-br-row')).toHaveCount(0);

    await br(page).locator('.git-br-search').fill('eedl');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveAttribute('data-short', 'feature/needle');

    // 일치가 없으면 사실을 알린다 — 빈 화면은 실패와 구분되지 않는다.
    await br(page).locator('.git-br-search').fill('zzzz-none');
    await expect(rows(page)).toHaveCount(0);
    await expect(br(page).locator('.git-br-empty')).toHaveCount(1);
  });

  test('B5 (V53 / FR-GIT-149, O13): ★ 는 ws.git.favorites 에 남고 git.pinned 를 지우지 않는다', async ({ page, request }) => {
    const repo = copyFx('with-remote', 'b5');
    await waitForInit(page);
    // 핀은 각 테스트가 스스로 만든다 (design/README.md).
    await page.evaluate((r) => (window as any).app._gitPin(r), repo);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    // 고정하면 같은 ref 가 즐겨찾기 그룹에도 나타나므로 로컬 그룹으로 좁혀 본다.
    const local = group(page, 'local').locator('.git-br-row[data-short="no-upstream"]');
    await local.locator('.git-br-fav').click();
    await expect(local.locator('.git-br-fav')).toHaveClass(/on/);
    // 즐겨찾기 그룹에 같은 이름이 함께 보인다.
    await expect(group(page, 'fav').locator('.git-br-row[data-short="no-upstream"]')).toHaveCount(1);

    // workspace.json 최상위 git.favorites[<repo>] 다 (O13).
    await expect
      .poll(async () => {
        const r = await request.get('/api/workspace');
        const ws = await r.json();
        return ws?.git?.favorites?.[repo] || [];
      }, { timeout: 15000 })
      .toContain('no-upstream');
    // git.pinned 는 서버가 권위로 쓴다 — 즐겨찾기 저장이 그것을 지우면 실패다.
    const ws = await (await request.get('/api/workspace')).json();
    expect(ws?.git?.pinned || []).toContain(repo);

    // 새로고침 후에도 남는다 (FR-GIT-149: 고정 목록은 영속한다).
    // 활성 창이 Git 창이므로 포커스된 분할 칸에 터미널이 없다 — 탭이 서기를 기다린다.
    await page.reload();
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7, { timeout: 15000 });
    await page.click('#area .pn-tab[data-git-view="branches"]');
    await waitRefs(page, 2);
    await expect(group(page, 'fav').locator('.git-br-row[data-short="no-upstream"]')).toHaveCount(1);
  });

  test('B6 (V54 / FR-GIT-155): 로컬 브랜치 우클릭 Checkout 이 HEAD 를 옮긴다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b6');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'no-upstream').click({ button: 'right' });
    await items(page).filter({ hasText: /^Checkout$/ }).click();

    await expect.poll(() => git(repo, 'branch', '--show-current'), { timeout: 20000 })
      .toBe('no-upstream');
    // FR-GIT-160: 조작 후 목록이 갱신된다 — 현재 표시가 따라 옮겨 간다.
    await expect(row(page, 'no-upstream')).toHaveClass(/current/, { timeout: 15000 });
    await expect(row(page, 'main')).not.toHaveClass(/current/);
  });

  test('B7 (V54 / FR-GIT-156): 원격 브랜치는 로컬을 만들며 추적을 설정한다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b7');
    // origin/feat 를 만든다 — 같은 이름의 로컬은 없다.
    git(repo, 'push', '-q', 'origin', 'no-upstream:feat');
    git(repo, 'fetch', '-q', 'origin');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 3);

    await row(page, 'origin/feat').click({ button: 'right' });
    await items(page).filter({ hasText: 'Checkout as local' }).click();

    await expect.poll(() => git(repo, 'branch', '--show-current'), { timeout: 20000 }).toBe('feat');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'feat@{upstream}')).toBe('origin/feat');
  });

  test('B8 (V54 / FR-GIT-156, O14): 이름 충돌은 선택지를 보이고 기본은 취소다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b8');
    git(repo, 'push', '-q', 'origin', 'no-upstream:feat');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'branch', 'feat', 'main'); // 같은 이름의 로컬이 이미 있다
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 4);

    await row(page, 'origin/feat').click({ button: 'right' });
    await items(page).filter({ hasText: 'Checkout as local' }).click();

    // 서버가 준 순서 그대로 3개다 — 목록을 프론트가 복제하지 않는다.
    await expect(choice(page)).toBeVisible({ timeout: 15000 });
    const opts = choice(page).locator('.gch-opt');
    await expect(opts).toHaveCount(3);
    await expect(opts.nth(0)).toHaveAttribute('data-opt', 'checkout_existing');
    await expect(opts.nth(1)).toHaveAttribute('data-opt', 'create_other_name');
    await expect(opts.nth(2)).toHaveAttribute('data-opt', 'cancel');
    // 기본 선택은 취소다 (O14).
    await expect(choice(page).locator('.gch-opt[data-opt="cancel"]')).toBeFocused();

    // 기존 브랜치로 checkout 을 고르면 그 브랜치로 옮겨 간다.
    await opts.nth(0).click();
    await expect.poll(() => git(repo, 'branch', '--show-current'), { timeout: 20000 }).toBe('feat');
    // 기존 feat 는 main 에서 만든 것이므로 origin/feat 를 추적하지 않는다.
    expect(git(repo, 'rev-parse', 'feat')).toBe(git(repo, 'rev-parse', 'main'));
  });

  test('B9 (V55 / FR-GIT-157, O14): dirty checkout 의 기본은 취소이고 강제는 확인을 거친다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b9');
    writeFileSync(join(repo, 'f.txt'), 'dirty\n');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'no-upstream').click({ button: 'right' });
    await items(page).filter({ hasText: /^Checkout$/ }).click();

    await expect(choice(page)).toBeVisible({ timeout: 15000 });
    const opts = choice(page).locator('.gch-opt');
    await expect(opts).toHaveCount(3);
    // 취소 / stash 후 진행 / 강제 — **강제가 기본이 아니다** (V55).
    await expect(opts.nth(0)).toHaveAttribute('data-opt', 'cancel');
    await expect(opts.nth(1)).toHaveAttribute('data-opt', 'stash');
    await expect(opts.nth(2)).toHaveAttribute('data-opt', 'force');
    await expect(choice(page).locator('.gch-opt[data-opt="cancel"]')).toBeFocused();

    // 강제는 파괴적이므로 GitConfirm 을 거친다 — 걸음은 하나다 (FR-COS-1).
    await opts.nth(2).click();
    await expect(confirm(page)).toBeVisible({ timeout: 15000 });
    await expect(confirm(page)).toHaveAttribute('data-stage', '1');
    // 기본 포커스는 취소다 — 강제 확인에서도 그대로다 (FR-GIT-97).
    await expect(confirm(page).locator('.gc-cancel')).toBeFocused();
    await confirm(page).locator('.gc-go').click();

    await expect.poll(() => git(repo, 'branch', '--show-current'), { timeout: 20000 })
      .toBe('no-upstream');
    // 강제는 워킹 트리의 변경을 버린다.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('B10 (V55 / FR-GIT-157): stash 후 진행은 변경을 stash 로 남기고 옮겨 간다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b10');
    writeFileSync(join(repo, 'f.txt'), 'keep-me\n');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await row(page, 'no-upstream').click({ button: 'right' });
    await items(page).filter({ hasText: /^Checkout$/ }).click();
    await expect(choice(page)).toBeVisible({ timeout: 15000 });
    await choice(page).locator('.gch-opt[data-opt="stash"]').click();

    await expect.poll(() => git(repo, 'branch', '--show-current'), { timeout: 20000 })
      .toBe('no-upstream');
    // 변경은 버려지지 않았다 — stash 에 남아 있다.
    expect(git(repo, 'stash', 'list')).not.toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('B11 (V68 / FR-GIT-158): 생성 다이얼로그는 이름·시작점·checkout 3필드다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b11');
    const start = git(repo, 'rev-parse', 'no-upstream');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await br(page).locator('.git-br-new').click();
    await expect(create(page)).toBeVisible();
    await expect(create(page).locator('.gbc-name')).toHaveCount(1);
    await expect(create(page).locator('.gbc-start')).toHaveCount(1);
    await expect(create(page).locator('.gbc-checkout')).toHaveCount(1);
    // 생성 후 checkout 은 기본이 아니다 — 기본은 늘 안전한 쪽이다 (FR-GIT-97).
    await expect(create(page).locator('.gbc-checkout')).not.toBeChecked();

    await create(page).locator('.gbc-name').fill('made/here');
    await create(page).locator('.gbc-start').fill(start);
    await create(page).locator('.gbc-checkout').check();
    await create(page).locator('.gbc-go').click();

    await expect.poll(() => git(repo, 'branch', '--show-current'), { timeout: 20000 })
      .toBe('made/here');
    expect(git(repo, 'rev-parse', 'made/here')).toBe(start);
    // FR-GIT-160: 새 브랜치가 목록에 나타난다.
    await expect(row(page, 'made/here')).toHaveCount(1, { timeout: 15000 });
  });

  test('B12 (V67 / FR-GIT-159): 이름 규칙 위반은 입력 단계에서 막힌다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b12');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    await br(page).locator('.git-br-new').click();
    await expect(create(page)).toBeVisible();
    // 이름이 비면 실행할 수 없다.
    await expect(create(page).locator('.gbc-go')).toBeDisabled();

    // `..` 는 git 의 이름 규칙 위반이다 — /api/git/branch/validate 가 판정한다.
    await create(page).locator('.gbc-name').fill('bad..name');
    await expect(create(page).locator('.gbc-why')).not.toHaveText('', { timeout: 15000 });
    await expect(create(page).locator('.gbc-go')).toBeDisabled();

    // 이미 있는 이름은 규칙 위반이 아니지만 생성할 수 없다 — 사유가 달라야 한다.
    await create(page).locator('.gbc-name').fill('main');
    await expect(create(page).locator('.gbc-why')).toHaveAttribute('data-why', 'exists',
      { timeout: 15000 });
    await expect(create(page).locator('.gbc-go')).toBeDisabled();

    // 유효한 이름이면 다시 열린다.
    await create(page).locator('.gbc-name').fill('ok-name');
    await expect(create(page).locator('.gbc-go')).toBeEnabled({ timeout: 15000 });
    await expect(create(page).locator('.gbc-why')).toHaveText('');
    // 브랜치는 만들어지지 않았다 — 검사만으로 쓰기가 일어나면 실패다.
    expect(git(repo, 'branch', '--list', 'ok-name')).toBe('');
  });

  test('B13 (V67 / FR-GIT-154·160): 우클릭 Copy Name 과 태그 메뉴', async ({ page }) => {
    await waitForInit(page);
    await openBranches(page, fx('many-commits'));
    await waitRefs(page, 2);

    // 복사는 클립보드가 막힌 환경에서도 동작해야 하므로 execCommand 를 가로챈다.
    await page.evaluate(() => {
      const w = window as any;
      w.__copied = [];
      document.addEventListener('copy', (e) => {
        w.__copied.push((e.target as HTMLTextAreaElement).value);
      }, true);
    });
    await row(page, 'main').click({ button: 'right' });
    await items(page).filter({ hasText: '브랜치 이름 복사' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('main');

    // 태그는 태그 그룹에 있고 메뉴 kind 가 다르다 (detached 로 옮겨 간다).
    const tag = group(page, 'tag').locator('.git-br-row').first();
    await expect(tag).toHaveCount(1);
    await tag.click({ button: 'right' });
    await expect(menu(page)).toHaveAttribute('data-kind', 'tag');
    await expect(items(page).filter({ hasText: 'detached' })).toHaveCount(1);
  });

  // ── FR-GIT-222 (V99): 더블클릭은 그 행의 기본 동작이다 ──
  //
  // 체크아웃은 이미 우클릭 메뉴에 있었다. 없던 것은 기능이 아니라 발견
  // 가능성이다 — 사용자가 두 번 "안 된다" 고 읽었다면 그 진입점은 없는 것과 같다.
  test('B12 (V99 / FR-GIT-222): 로컬 브랜치 더블클릭이 checkout 한다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b12');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    const cur = await br(page).locator('.git-br-row.current').getAttribute('data-short');
    const other = await rows(page).evaluateAll((els, c) =>
      els.map((e) => (e as HTMLElement).dataset.short)
        .filter((n) => n && n !== c)[0], cur);
    expect(other, '다른 로컬 브랜치가 없다').toBeTruthy();

    await row(page, other!).dblclick();
    // 메뉴와 같은 경로로 간다 — dirty 3선택도 이름 충돌도 그대로 걸린다.
    await expect.poll(async () =>
      br(page).locator('.git-br-row.current').getAttribute('data-short'),
      { timeout: 20000 }).toBe(other);
  });

  test('B13 (V99 / FR-GIT-222): 현재 브랜치와 태그의 더블클릭은 아무 일도 하지 않는다', async ({ page }) => {
    const repo = copyFx('with-remote', 'b13');
    await waitForInit(page);
    await openBranches(page, repo);
    await waitRefs(page, 2);

    const cur = await br(page).locator('.git-br-row.current').getAttribute('data-short');
    await row(page, cur!).dblclick();
    // 더블클릭이 메뉴보다 관대해지면 두 진입점의 뜻이 갈라진다 — 확인창도 뜨지 않는다.
    await page.waitForTimeout(700);
    await expect(confirm(page)).toBeHidden();
    await expect(choice(page)).toBeHidden();
    expect(await br(page).locator('.git-br-row.current').getAttribute('data-short')).toBe(cur);

    // 태그는 detached 가 되는 동작이라 가벼운 제스처에 싣지 않는다.
    const tag = br(page).locator('.git-br-group[data-group="tags"] .git-br-row').first();
    if (await tag.count()) {
      await tag.dblclick();
      await page.waitForTimeout(700);
      await expect(confirm(page)).toBeHidden();
      expect(await br(page).locator('.git-br-row.current').getAttribute('data-short')).toBe(cur);
    }
  });
});
