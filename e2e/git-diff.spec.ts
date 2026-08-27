import { execFileSync } from 'child_process';
import { realpathSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M1_STEP7_CONTRACT §4 — Diff 뷰 (D1~D10). 검증 V10·V11·V12·V26.
//
// diff 렌더링은 monaco.editor.createDiffEditor 다 (FR-GIT-43) — 자체 하이라이트
// 엔진이 없으므로 단정도 Monaco 의 DOM·API 에 걸린다.

const FIXTURES = '/tmp/dm-git-fx-diff-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
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
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
}

const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const diff = (page: Page) => page.locator('#area .pn-body .git-view.git-diff');
const row = (page: Page, group: string, path: string) =>
  changes(page).locator(`.git-group[data-group="${group}"] .git-file[data-path="${path}"]`);
const tab = (page: Page, view: string) => page.locator(`#area .pn-tab[data-git-view="${view}"]`);

const previewEditor = (page: Page) => changes(page).locator('.git-preview .monaco-diff-editor');
const diffEditor = (page: Page) => diff(page).locator('.git-diff-body .monaco-diff-editor');

// Monaco 모델 수 — FR-GIT-56 의 누수 판정 지표다 (§3.5).
const models = (page: Page) =>
  page.evaluate(() => {
    const m = (window as any).monaco;
    return m ? m.editor.getModels().length : -1;
  });

// Diff 탭 에디터가 계산한 변경 줄 수. 공백무시 토글의 효과는 DOM 이 아니라
// diff 계산 결과에서 본다 (FR-GIT-50).
const lineChanges = (page: Page) =>
  page.evaluate(() => {
    const v = (window as any).app.gitPanel._diffView;
    const ed = v && v._editor;
    if (!ed) return -1;
    const ch = ed.getLineChanges();
    return ch ? ch.length : -1;
  });

const setRepo = (page: Page, repo: string) =>
  page.evaluate((r) => (window as any).app.gitPanel.setRepo(r), repo);

const selectFile = (page: Page, group: string, path: string) =>
  page.evaluate(
    ([g, p]) => (window as any).app.gitPanel._select(g, { path: p }),
    [group, path]
  );

// 본문을 그리지 못하는 쪽의 메타 줄 (FR-GIT-46·47·48).
const noteLines = (page: Page) =>
  diff(page).locator('.git-diff-note').innerText();

// diff 의 추가·삭제 줄 배경. 색을 테스트가 발명하지 않으려면 **읽어서 비교**해야
// 한다 — 기대값을 적으면 하드코딩 금지(FR-GIT-119)를 테스트가 어긴다.
const bgOf = (page: Page, cls: string) =>
  diffEditor(page).locator('.' + cls).first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe('묶음 F — Diff 뷰', () => {
  test('D1 (V26): 파일 단일 클릭이 미리보기를 채운다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    // 선택 전에는 안내만 있고 에디터가 없다.
    await expect(changes(page).locator('.git-preview .git-diff-note')).toHaveText(
      '파일을 선택하세요', { timeout: 10000 });
    await expect(previewEditor(page)).toHaveCount(0);

    await row(page, 'changes', 'tracked.txt').click();
    await expect(changes(page).locator('.git-preview .git-preview-path')).toHaveText('tracked.txt');
    await expect(changes(page).locator('.git-preview .git-preview-axis'))
      .toHaveText('worktree ↔ index');
    await expect(previewEditor(page)).toBeVisible({ timeout: 20000 });
    // 워킹 트리 쪽에만 있는 줄이 보여야 한다 (index: "one", worktree: "one\ntwo").
    await expect(previewEditor(page)).toContainText('two');
  });

  test('D2 (V26): 더블클릭이 Diff 탭으로 이동하고 그 파일을 보인다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    const r = row(page, 'changes', 'tracked.txt');
    await expect(r).toBeVisible({ timeout: 10000 });
    await r.dblclick();

    await expect(tab(page, 'diff')).toHaveClass(/active/);
    await expect(diff(page).locator('.git-diff-path')).toHaveText('tracked.txt');
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
    await expect(diffEditor(page)).toContainText('two');
  });

  test('D3 (V26): ‹ › 로 이전/다음 파일로 이동하고 n/m 이 바뀐다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    const r = row(page, 'untracked', 'untracked.txt');
    await expect(r).toBeVisible({ timeout: 10000 });
    // 목록은 그룹 순서(conflicts → staged → changes → untracked)를 따른다 —
    // untracked 는 마지막이다 (FR-GIT-53).
    const total = await changes(page).locator('.git-file').count();
    await r.dblclick();

    const pos = diff(page).locator('.git-diff-pos');
    const path = diff(page).locator('.git-diff-path');
    await expect(pos).toHaveText(`${total}/${total}`);
    const last = await path.textContent();

    await diff(page).locator('.git-diff-nav[data-nav="prev"]').click();
    await expect(pos).toHaveText(`${total - 1}/${total}`);
    await expect(path).not.toHaveText(last || '');
    // Diff 탭에서 이동하면 Changes 탭의 선택도 따라 움직인다 (같은 상태다).
    const moved = (await path.textContent()) || '';
    await tab(page, 'changes').click();
    await expect(changes(page).locator('.git-file.sel')).toHaveCount(1);
    await expect(changes(page).locator('.git-preview .git-preview-path')).toHaveText(moved);

    await tab(page, 'diff').click();
    await diff(page).locator('.git-diff-nav[data-nav="next"]').click();
    await expect(pos).toHaveText(`${total}/${total}`);
    await expect(path).toHaveText(last || '');
  });

  test('D4 (V11): side-by-side ↔ unified 전환이 동작한다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);
    await row(page, 'changes', 'tracked.txt').dblclick();
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });

    const mode = diff(page).locator('.git-diff-mode');
    await expect(mode).toHaveText('side-by-side');
    await expect(diffEditor(page)).toHaveClass(/side-by-side/);

    await mode.click();
    await expect(mode).toHaveText('unified');
    await expect(diffEditor(page)).not.toHaveClass(/side-by-side/);

    await mode.click();
    await expect(mode).toHaveText('side-by-side');
    await expect(diffEditor(page)).toHaveClass(/side-by-side/);
  });

  test('D5 (V11): 폭을 900px 아래로 줄이면 inline 으로 전환된다', async ({ page }) => {
    const repo = fx('basic');
    await page.setViewportSize({ width: 1400, height: 800 });
    await waitForInit(page);
    await openGit(page, repo);
    await row(page, 'changes', 'tracked.txt').dblclick();
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
    await expect(diffEditor(page)).toHaveClass(/side-by-side/);

    // GIT_DIFF_OPTIONS.renderSideBySideInlineBreakpoint = 900. 사이드바를 뺀
    // diff 폭이 그 아래로 떨어지면 useInlineViewWhenSpaceIsLimited 가 걸린다.
    await page.setViewportSize({ width: 820, height: 800 });
    await expect(diffEditor(page)).not.toHaveClass(/side-by-side/);
    // 모드 자체는 여전히 side-by-side 다 — 폭 때문에 접힌 것이다.
    await expect(diff(page).locator('.git-diff-mode')).toHaveText('side-by-side');

    await page.setViewportSize({ width: 1400, height: 800 });
    await expect(diffEditor(page)).toHaveClass(/side-by-side/);
  });

  test('D6 (V11): 공백무시 토글이 동작한다', async ({ page }) => {
    const repo = copyFx('basic', 'd6');
    // 공백만 다른 파일 — git 은 이것을 변경으로 취급한다.
    writeFileSync(join(repo, 'ws.txt'), 'alpha\nbeta\n');
    execFileSync('git', ['-C', repo, 'add', 'ws.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'ws']);
    writeFileSync(join(repo, 'ws.txt'), 'alpha   \nbeta\n');

    await waitForInit(page);
    await openGit(page, repo);
    const r = row(page, 'changes', 'ws.txt');
    await expect(r).toBeVisible({ timeout: 10000 });
    await r.dblclick();
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });

    // FR-GIT-50: ignoreTrimWhitespace 는 기본이 false 다 — Monaco 기본값을
    // 뒤집는다. 공백만 다른 줄도 변경으로 보인다.
    const ws = diff(page).locator('.git-diff-ws input');
    await expect(ws).not.toBeChecked();
    await expect.poll(() => lineChanges(page), { timeout: 20000 }).toBe(1);

    await ws.check();
    await expect.poll(() => lineChanges(page), { timeout: 20000 }).toBe(0);

    await ws.uncheck();
    await expect.poll(() => lineChanges(page), { timeout: 20000 }).toBe(1);
  });

  test('D7 (V12): Monaco CDN 이 막혀도 파일 목록·헤더가 동작하고 diff 가 사유를 보인다', async ({ page }) => {
    const repo = copyFx('basic', 'd7');
    // FR-GIT-55: Monaco 는 CDN 자산이다. 그 실패가 Git 창을 멈춰서는 안 된다.
    await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());

    await waitForInit(page);
    await openGit(page, repo);
    await expect(changes(page).locator('.git-head-repo')).toHaveText('copy-d7', { timeout: 10000 });

    await row(page, 'changes', 'tracked.txt').click();
    await expect(changes(page).locator('.git-preview .git-diff-note'))
      .toHaveText('에디터를 불러올 수 없습니다 — 네트워크를 확인하세요', { timeout: 20000 });
    await expect(previewEditor(page)).toHaveCount(0);

    // 헤더와 목록은 계속 동작한다.
    writeFileSync(join(repo, 'd7-new.txt'), 'x');
    await expect(changes(page).locator('.git-group[data-group="untracked"] .git-group-count'))
      .toHaveText('(2)', { timeout: 10000 });
    await expect(changes(page).locator('.git-head-branch')).toHaveText('main');

    // Diff 탭도 같은 사유를 보이고 바는 살아 있다.
    await tab(page, 'diff').click();
    await expect(diff(page).locator('.git-diff-note'))
      .toHaveText('에디터를 불러올 수 없습니다 — 네트워크를 확인하세요');
    await expect(diff(page).locator('.git-diff-path')).toHaveText('tracked.txt');
  });

  test('D8 (V12): 탭·리포를 20회 왕복해도 Monaco 모델이 늘지 않는다', async ({ page }) => {
    test.setTimeout(180_000);
    const a = fx('basic');
    const b = fx('detached');
    await waitForInit(page);
    await openGit(page, a);

    await row(page, 'changes', 'tracked.txt').click();
    await expect(previewEditor(page)).toBeVisible({ timeout: 20000 });
    await tab(page, 'diff').click();
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
    const baseline = await models(page);
    expect(baseline, 'diff 모델이 만들어지지 않았다').toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) {
      await tab(page, 'changes').click();
      await expect(previewEditor(page)).toBeVisible({ timeout: 20000 });
      await tab(page, 'diff').click();
      await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
      // 리포 전환은 두 뷰를 clear 하고 대상을 초기화한다 (§3.5).
      await setRepo(page, b);
      await expect(diffEditor(page)).toHaveCount(0);
      await setRepo(page, a);
      await selectFile(page, 'changes', 'tracked.txt');
      await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
    }

    await expect.poll(() => models(page), { timeout: 20000 }).toBeLessThanOrEqual(baseline);
    const diffs = await page.evaluate(() => (window as any).monaco.editor.getDiffEditors().length);
    expect(diffs, 'DiffEditor 인스턴스가 누적됐다').toBeLessThanOrEqual(2);
  });

  test('D9 (V10): 바이너리 파일은 본문 대신 안내를 보인다', async ({ page }) => {
    const repo = fx('blobs');
    await waitForInit(page);
    await openGit(page, repo);

    const r = row(page, 'changes', 'bin.dat');
    await expect(r).toBeVisible({ timeout: 10000 });
    await r.dblclick();
    await expect(diff(page).locator('.git-diff-note')).toContainText('바이너리', { timeout: 20000 });
    await expect(diffEditor(page)).toHaveCount(0);
  });

  test('D10 (V10): 새로 만든 파일과 지운 파일이 각각 그려진다', async ({ page }) => {
    const repo = copyFx('basic', 'd10');
    await waitForInit(page);
    await openGit(page, repo);
    await expect(row(page, 'changes', 'tracked.txt')).toBeVisible({ timeout: 10000 });

    // 추가 — original 이 absent 다. 빈 내용으로 다뤄 diff 가 성립한다 (FR-GIT-45).
    writeFileSync(join(repo, 'd10-new.txt'), 'added line\n');
    const added = row(page, 'untracked', 'd10-new.txt');
    await expect(added).toBeVisible({ timeout: 10000 });
    await added.dblclick();
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
    await expect(diffEditor(page)).toContainText('added line');
    await expect(diff(page).locator('.git-diff-note')).toContainText('새로 추가된 파일');

    // 삭제 — modified 가 absent 다.
    unlinkSync(join(repo, 'tracked.txt'));
    await tab(page, 'changes').click();
    const gone = row(page, 'changes', 'tracked.txt');
    await expect(gone).toBeVisible({ timeout: 10000 });
    await gone.dblclick();
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
    await expect(diffEditor(page)).toContainText('one');
    await expect(diff(page).locator('.git-diff-note')).toContainText('삭제된 파일');
  });
  // ── D11 — FR-GIT-119: diff 색은 테마 팔레트에서 파생한다 (V47 과 같은 결) ──
  //
  // 판정은 "무슨 색인가" 가 아니다. 팔레트에서 green ↔ red 의 자리를 맞바꾸면
  // 추가·삭제 색이 **정확히 뒤바뀌어야** 한다 — 두 색이 그 두 토큰에서 왔다는
  // 증거이고, 색 리터럴을 테스트에 두지 않는 방법이다.
  test('D11 (V47·FR-GIT-119): 테마를 바꾸면 diff 의 추가·삭제 색이 따라 바뀐다', async ({ page }) => {
    const repo = copyFx('basic', 'd11');
    await waitForInit(page);
    await openGit(page, repo);
    await expect(row(page, 'changes', 'tracked.txt')).toBeVisible({ timeout: 10000 });

    // 한 줄을 고쳐 추가와 삭제가 한 화면에 함께 나오게 한다 (index 쪽은 "one").
    writeFileSync(join(repo, 'tracked.txt'), 'ONE\ntwo\n');
    await row(page, 'changes', 'tracked.txt').dblclick();
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });

    const ins = () => bgOf(page, 'line-insert');
    const del = () => bgOf(page, 'line-delete');
    await expect.poll(ins, { timeout: 20000 }).toMatch(/^rgb/);
    await expect.poll(del, { timeout: 20000 }).toMatch(/^rgb/);
    const ins0 = await ins();
    const del0 = await del();
    expect(ins0, '추가와 삭제가 같은 색이다').not.toBe(del0);

    // ① 팔레트에서 두 색의 자리를 바꾸면 두 색이 서로 뒤바뀐다.
    await page.evaluate(() => {
      const w = window as any;
      const t = w.getCurrentTheme();
      const term = Object.assign({}, t.terminal);
      const swap = term.green; term.green = term.red; term.red = swap;
      w.customTheme = { mode: t.mode, ui: t.ui, terminal: term };
      w.applyThemeObj(w.customTheme);
    });
    await expect.poll(ins, { timeout: 10000 }).toBe(del0);
    expect(await del()).toBe(ins0);

    // ② 실제 테마 전환에서도 따라 바뀐다. 이름을 박지 않고 **지금과 다른 green**
    //    을 가진 것을 그 자리에서 고른다 — 앞선 실행이 남긴 테마와 같은 것을
    //    고르면 "바뀌었는지" 를 볼 수 없다.
    //    THEMES 는 고전 스크립트의 const 라 window 프로퍼티가 아니다 — 문자열
    //    평가로 페이지의 전역 스코프에서 읽는다. customTheme 을 비우는 것만으로는
    //    모자라다: getCurrentTheme() 은 currentThemeName 을 딛는다.
    const picked = await page.evaluate<string>(
      '(function(){' +
      'var cur=getCurrentTheme().terminal.green.toLowerCase();' +
      'var n=Object.keys(THEMES).find(function(k){' +
      'return THEMES[k].terminal.green.toLowerCase()!==cur});' +
      'customTheme=null;currentThemeName=n;applyThemeObj(THEMES[n]);return n})()');
    expect(picked, '팔레트가 다른 테마가 없다').toBeTruthy();
    await expect.poll(ins, { timeout: 10000 }).not.toBe(del0);
  });

  // ── D12 — FR-GIT-47: LFS 포인터는 포인터임과 메타를 보인다 ──
  test('D12 (V10·FR-GIT-47): LFS 포인터가 oid 와 실제 크기를 보인다', async ({ page }) => {
    const repo = copyFx('blobs', 'd12');
    // 커밋된 포인터와 **다른** 포인터를 워킹 트리에 둔다 — 양쪽 메타가 갈리는
    // 것이 LFS 파일이 바뀌었을 때의 실제 모습이다.
    writeFileSync(join(repo, 'lfs.bin'),
      'version https://git-lfs.github.com/spec/v1\n' +
      'oid sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\n' +
      'size 987654321\n');
    await waitForInit(page);
    await openGit(page, repo);

    const r = row(page, 'changes', 'lfs.bin');
    await expect(r).toBeVisible({ timeout: 10000 });
    await r.dblclick();
    await expect(diff(page).locator('.git-diff-note'))
      .toContainText('Git LFS 포인터', { timeout: 20000 });
    // 본문은 그리지 않는다 — 메타만 보인다.
    await expect(diffEditor(page)).toHaveCount(0);

    const text = await noteLines(page);
    // 양쪽 oid 앞자리. original = index(커밋된 포인터), modified = 워킹 트리.
    expect(text).toContain('sha256:0123456789ab');
    expect(text).toContain('sha256:fedcba987654');
    // 포인터 자신의 크기가 아니라 **가리키는 객체의 크기**다.
    expect(text).toContain('117.7 MB');   // 123456789 B
    expect(text).toContain('941.9 MB');   // 987654321 B
  });

  // ── D13 — FR-GIT-46·48: 본문을 못 주는 쪽은 크기를 함께 보인다 ──
  test('D13 (V10·FR-GIT-46·48): 바이너리와 상한 초과가 크기를 함께 보인다', async ({ page }) => {
    const repo = fx('blobs');
    await waitForInit(page);
    await openGit(page, repo);

    const bin = row(page, 'changes', 'bin.dat');
    await expect(bin).toBeVisible({ timeout: 10000 });
    await bin.dblclick();
    await expect(diff(page).locator('.git-diff-note'))
      .toContainText('바이너리', { timeout: 20000 });
    // 픽스처의 두 쪽 크기다 (22 B → 31 B). 양쪽이 다르므로 각각 보인다.
    expect(await noteLines(page)).toMatch(/22 B[\s\S]*31 B/);

    await tab(page, 'changes').click();
    const huge = row(page, 'changes', 'huge.txt');
    await expect(huge).toBeVisible({ timeout: 10000 });
    await huge.dblclick();
    await expect(diff(page).locator('.git-diff-note'))
      .toContainText('상한', { timeout: 20000 });
    // 상한을 얼마나 넘었는지는 안내가 아니라 크기가 답한다 (1MiB 초과).
    expect(await noteLines(page)).toMatch(/\d+\.\d MB/);
  });
});

test.describe('FR-GIT-276 — Blame (Diff 탭의 모드)', () => {
  const menu = (page: Page) => page.locator('.git-menu');
  const item = (page: Page, id: string) => menu(page).locator(`.git-menu-item[data-id="${id}"]`);
  const blame = (page: Page) => diff(page).locator('.git-blame');
  const blameRow = (page: Page, n: number) => blame(page).locator(`.git-blame-row[data-line="${n}"]`);

  // 픽스처는 커밋 둘과 미커밋 한 줄을 갖는다 — 줄마다 다른 커밋을 가리키는 것과
  // 미커밋 줄의 구분을 한 파일에서 다 본다.
  function repoWithHistory(tag: string) {
    const repo = copyFx('basic', tag);
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
    writeFileSync(join(repo, 'bl.txt'), '첫째 줄\n둘째 줄\n');
    git('add', '-A');
    git('commit', '-qm', 'AAFIRSTCOMMIT');
    writeFileSync(join(repo, 'bl.txt'), '첫째 줄\n고친 둘째\n');
    git('add', '-A');
    git('commit', '-qm', 'BBSECONDCOMMIT');
    writeFileSync(join(repo, 'bl.txt'), '첫째 줄\n고친 둘째\n아직 커밋 안 한 줄\n');
    return repo;
  }

  test('BL1 (V211·FR-GIT-276): 파일 메뉴의 Blame 이 Diff 탭을 blame 모드로 연다', async ({ page }) => {
    const repo = repoWithHistory('bl1');
    await waitForInit(page);
    await openGit(page, repo);

    const r = row(page, 'changes', 'bl.txt');
    await expect(r).toBeVisible({ timeout: 20000 });
    await r.click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await item(page, 'blame').click();

    await expect(tab(page, 'diff')).toHaveClass(/active/);
    await expect(blame(page)).toBeVisible({ timeout: 20000 });
    // blame 모드에서는 diff 편집기가 자리를 비운다 — 둘이 함께 보이면 사용자는
    // 무엇을 보고 있는지 모른다.
    await expect(diffEditor(page)).toBeHidden();

    await expect(blameRow(page, 1)).toContainText('첫째 줄');
    await expect(blameRow(page, 2)).toContainText('고친 둘째');
    await expect(blameRow(page, 3)).toContainText('아직 커밋 안 한 줄');
    // 줄마다 제 커밋을 가리킨다.
    await expect(blameRow(page, 1).locator('.git-blame-oid')).toHaveAttribute('title', /AAFIRSTCOMMIT/);
    await expect(blameRow(page, 2).locator('.git-blame-oid')).toHaveAttribute('title', /BBSECONDCOMMIT/);
    // 미커밋 줄을 커밋으로 그리면 사용자는 없는 커밋을 열려고 한다.
    await expect(blameRow(page, 3)).toHaveClass(/uncommitted/);

    // 끄면 diff 로 돌아온다.
    await diff(page).locator('.git-diff-blame').click();
    await expect(blame(page)).toBeHidden();
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
  });

  // 인계 규약 2: 거부 사유는 **누른 자리**에 보인다. Diff 탭에서 낸 실패가 화면에
  // 아무 자국도 남기지 않으면 사용자는 고장으로 읽는다.
  test('BL2 (V211): blame 할 수 없는 파일은 Diff 탭 안에서 사유를 보인다', async ({ page }) => {
    const repo = repoWithHistory('bl2');
    writeFileSync(join(repo, 'untracked-new.txt'), 'x\n');
    await waitForInit(page);
    await openGit(page, repo);

    const r = row(page, 'untracked', 'untracked-new.txt');
    await expect(r).toBeVisible({ timeout: 20000 });
    await r.click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await item(page, 'blame').click();

    await expect(diff(page).locator('.git-blame-note')).toBeVisible({ timeout: 20000 });
    await expect(diff(page).locator('.git-blame-row')).toHaveCount(0);
  });
});
