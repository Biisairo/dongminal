import { execFileSync } from 'child_process';
import { readFileSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, GIT_VIEW_TABS } from './fixtures';

// GIT_M4_STEP1417_CONTRACT §3·§4·§5 — History 탭. 검증 V47~V51 · V64 · V65 + V48 성능.
//
// 테스트 저장소는 e2e/git_fixture.sh 가 만든다 (design/README.md).
// 성능은 many-commits(10,000 커밋)로만 본다 — 그보다 작은 저장소에서는 가상
// 스크롤과 전부 그리기가 구분되지 않는다.

const FIXTURES = '/tmp/dm-git-fx-hist-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

const copyFx = makeCopyFx(FIXTURES);
async function openHistory(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await page.click('#area .pn-tab[data-git-view="history"]');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-history/);
}

const hist = (page: Page) => page.locator('#area .pn-body .git-view.git-history');
const list = (page: Page) => hist(page).locator('.git-hist-list');
const rows = (page: Page) => hist(page).locator('.git-hist-row');
const commits = (page: Page) => hist(page).locator('.git-hist-row[data-oid]');
const loaded = (page: Page) => hist(page).locator('.git-hist-loaded');
const diff = (page: Page) => page.locator('#area .pn-body .git-view.git-diff');
const diffBar = (page: Page, sel: string) => diff(page).locator('.git-diff-bar ' + sel);
const diffEditor = (page: Page) => diff(page).locator('.git-diff-body .monaco-diff-editor');

// 로드된 커밋 수. 화면 행 수와 구분해 읽어야 가상 스크롤을 판정할 수 있다.
async function loadedCount(page: Page): Promise<number> {
  const n = await loaded(page).getAttribute('data-n');
  return Number(n || '0');
}

async function waitLoaded(page: Page, min: number) {
  await expect.poll(() => loadedCount(page), { timeout: 20000 }).toBeGreaterThanOrEqual(min);
}

// 고정 행 높이는 constants.js 가 정하고 목록이 CSS 변수로 싣는다 — 테스트가
// 숫자를 따로 갖지 않는다.
const rowH = (page: Page) =>
  list(page).evaluate((el) =>
    parseFloat(getComputedStyle(el).getPropertyValue('--git-row-h')));

test.describe('16단계 — History 탭', () => {
  test('H1 (V48): 10,000 커밋에서 DOM 행 수가 화면 행 수에 비례한다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    const h = await rowH(page);
    const view = await list(page).evaluate((el) => (el as HTMLElement).clientHeight);
    // 화면 행 수 + 위아래 여유분. 로드된 커밋 수(300)에 비례하면 실패다.
    const cap = Math.ceil(view / h) + 16;
    expect(await rows(page).count()).toBeLessThanOrEqual(cap);

    // 스크롤해도 늘지 않는다 — 지나간 행을 DOM 에 쌓아 두면 요구사항 실패다.
    await list(page).evaluate((el) => { el.scrollTop = 3000; });
    await expect.poll(() => commits(page).first().getAttribute('data-oid')).not.toBe(null);
    expect(await rows(page).count()).toBeLessThanOrEqual(cap);
    // 스크롤 높이는 전체 커밋 수만큼이다 (스페이서 두 개).
    const total = await list(page).evaluate((el) => el.scrollHeight);
    expect(total).toBeGreaterThan(300 * (await rowH(page)) * 0.9);
  });

  test('H2 (FR-GIT-114·115): 초기 300개를 로드하고 끝에 닿으면 100개씩 늘어난다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);
    expect(await loadedCount(page)).toBe(300);

    await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await waitLoaded(page, 400);
    await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await waitLoaded(page, 500);
  });

  test('H3 (FR-GIT-118): 그래프는 행별 인라인 SVG 다 — 캔버스가 없다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    const first = commits(page).first();
    await expect(first.locator('.git-hist-graph svg')).toHaveCount(1);
    await expect(first.locator('.git-hist-graph svg .git-lane-dot')).toHaveCount(1);
    await expect(hist(page).locator('canvas')).toHaveCount(0);
  });

  test('H4 (V47): 레인 색은 테마에서 파생한다 — 테마를 바꾸면 따라 바뀐다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    const dot = () => commits(page).first().locator('.git-hist-graph .git-lane-dot');
    const before = await dot().getAttribute('fill');
    expect(before).toBeTruthy();
    // 현재 테마의 팔레트에서 온 값이어야 한다.
    const inPalette = await page.evaluate(
      (c) => (window as any).GitHistory.palette().includes(c), before);
    expect(inPalette).toBe(true);

    // 색을 테스트가 발명하지 않는다 — 현재 테마의 팔레트에서 두 색의 자리를
    // 바꿔 넣는다. 레인 0 은 GIT_LANE_COLOR_KEYS 의 첫 색이다.
    await page.evaluate(() => {
      const w = window as any;
      const t = w.getCurrentTheme();
      const term = Object.assign({}, t.terminal);
      const swap = term.blue; term.blue = term.green; term.green = swap;
      w.customTheme = { mode: t.mode, ui: t.ui, terminal: term };
      w.applyThemeObj(w.customTheme);
    });
    await expect.poll(() => dot().getAttribute('fill'), { timeout: 10000 }).not.toBe(before);
  });

  test('H4b (V47): git-history.js·git-lanes.js 에 색 리터럴이 없다', async () => {
    for (const f of ['web/js/git/history.js', 'web/js/git/lanes.js', 'web/js/git/menu.js']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f + ' 에 #rrggbb 리터럴이 있다').not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(src, f + ' 에 #rgb 리터럴이 있다').not.toMatch(/['"]#[0-9a-fA-F]{3}['"]/);
      expect(src, f + ' 에 rgb( 리터럴이 있다').not.toMatch(/\brgba?\(/);
    }
  });

  test('H5 (V50·FR-GIT-125): 폭이 줄면 Commit → Date → Author 순으로 숨는다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    const cls = () => list(page).getAttribute('class');
    expect(await cls()).not.toMatch(/hide-hash/);

    // ResizeObserver 로 **목록 폭**을 본다 — 창 폭이 아니다 (분할 안의 Git 창).
    // 그래서 refs 사이드바가 먹는 폭을 더해 목록 폭을 겨눈다.
    const refsW = await hist(page).locator('.git-refs')
      .evaluate((el) => (el as HTMLElement).offsetWidth);
    const shrink = (listPx: number) =>
      hist(page).evaluate((el, px) => {
        (el as HTMLElement).style.width = px + 'px';
      }, listPx + refsW);

    await shrink(700);
    await expect.poll(cls, { timeout: 5000 }).toMatch(/hide-hash/);
    expect(await cls()).not.toMatch(/hide-date/);
    await shrink(500);
    await expect.poll(cls, { timeout: 5000 }).toMatch(/hide-date/);
    expect(await cls()).not.toMatch(/hide-author/);
    await shrink(400);
    await expect.poll(cls, { timeout: 5000 }).toMatch(/hide-author/);
    // 그래프와 메시지는 항상 남는다.
    await expect(commits(page).first().locator('.git-hist-graph')).toBeVisible();
    await expect(commits(page).first().locator('.git-hist-msg')).toBeVisible();
  });

  test('H6 (V50·FR-GIT-122·123): refs 사이드바 3그룹과 ref 필터', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('with-remote'));
    const refs = hist(page).locator('.git-refs');
    await expect(refs.locator('.git-refs-group[data-kind="local"] .git-ref')).toHaveCount(2, { timeout: 15000 });
    await expect(refs.locator('.git-refs-group[data-kind="remote"] .git-ref')).toHaveCount(1);
    await expect(refs.locator('.git-refs-group[data-kind="tag"]')).toHaveCount(1);
    // upstream 이 사라진 것은 ahead/behind 0 과 다르다 — 구분해 보인다.
    await expect(refs.locator('.git-ref[data-ref="refs/heads/main"] .git-ref-ab')).toHaveText(/↑1/);
    await expect(refs.locator('.git-ref[data-ref="refs/heads/no-upstream"] .git-ref-ab')).toHaveText('');

    const all = await loadedCount(page);
    await refs.locator('.git-ref[data-ref="refs/remotes/origin/main"]').click();
    await expect(refs.locator('.git-ref[data-ref="refs/remotes/origin/main"]')).toHaveClass(/sel/);
    await expect.poll(() => loadedCount(page), { timeout: 15000 }).toBeLessThan(all);
    // 해제하면 --all 로 돌아온다.
    await refs.locator('.git-refs-all').click();
    await expect.poll(() => loadedCount(page), { timeout: 15000 }).toBe(all);
  });

  test('H7 (V64·FR-GIT-124·126): 컬럼 5개와 ref 배지 · HEAD 구분', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('with-remote'));
    await waitLoaded(page, 1);

    const head = hist(page).locator('.git-hist-row.head');
    await expect(head).toHaveCount(1);
    for (const c of ['.git-hist-graph', '.git-hist-msg', '.git-hist-author', '.git-hist-date', '.git-hist-hash'])
      await expect(head.locator(c)).toHaveCount(1);
    // `HEAD -> main` 은 ref 에 붙은 표식이고, 행의 head 클래스는 HEAD 의 위치다.
    await expect(head.locator('.git-hist-badge.head')).toHaveText(/main/);
    // O12: 상대시간이 기본이고 절대시간은 title 로 항상 닿는다.
    const date = head.locator('.git-hist-date');
    expect((await date.getAttribute('title')) || '').toMatch(/\d{4}/);
    expect(await date.textContent()).not.toMatch(/\d{4}-\d{2}/);
  });

  test('H8 (FR-GIT-127): 미커밋 변경 행이 최상단에 있고 클릭하면 Changes 탭으로 간다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('basic'));
    const unc = hist(page).locator('.git-hist-row.uncommitted');
    await expect(unc).toHaveCount(1, { timeout: 15000 });
    // 최상단이다.
    await expect(rows(page).first()).toHaveClass(/uncommitted/);
    await unc.click();
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
  });

  test('H9 (V64·FR-GIT-128): 정렬 순서를 고르면 그 순서로 다시 받는다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    const seen: string[] = [];
    await page.route('**/api/git/log**', (route) => {
      seen.push(new URL(route.request().url()).searchParams.get('order') || '');
      route.continue();
    });
    await hist(page).locator('.git-hist-order').selectOption('topo');
    await expect.poll(() => seen.length, { timeout: 15000 }).toBeGreaterThan(0);
    expect(seen[0]).toBe('topo');
    await waitLoaded(page, 300);
  });

  test('H10 (V49·FR-GIT-129): 검색 두 모드가 화면에 구분되고 0건이면 전체 검색을 권한다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    const mode = hist(page).locator('.git-hist-smode');
    await expect(mode).toHaveAttribute('data-mode', 'loaded');
    await expect(mode).toHaveText(/로드된 범위/);

    // 로드된 300개(9700~9999) 안에 있는 제목.
    await hist(page).locator('.git-hist-search').fill('commit 9998');
    await expect.poll(() => commits(page).count(), { timeout: 10000 }).toBeGreaterThan(0);
    await expect(hist(page).locator('.git-hist-searchnone')).toBeHidden();

    // 로드 범위 밖의 제목 — 0건이므로 저장소 전체 검색을 권한다.
    await hist(page).locator('.git-hist-search').fill('commit 12 —');
    const none = hist(page).locator('.git-hist-searchnone');
    await expect(none).toBeVisible({ timeout: 10000 });
    await expect(none).toHaveText(/300/);
    await none.locator('.git-hist-searchrepo').click();
    await expect(mode).toHaveAttribute('data-mode', 'repo', { timeout: 15000 });
    await expect(mode).toHaveText(/저장소 전체/);
    // 저장소 전체 질의는 로드 범위에 없던 커밋을 찾아낸다.
    await expect.poll(() => loadedCount(page), { timeout: 20000 }).toBeGreaterThan(0);
    await expect(commits(page).first().locator('.git-hist-subject')).toHaveText(/commit 12 —/);
  });

  test('H11 (V65·FR-GIT-130): author·path 필터를 git 옵션으로 내려보낸다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    await hist(page).locator('.git-hist-f[data-f="path"]').fill('f7.txt');
    await hist(page).locator('.git-hist-apply').click();
    // 걸러낸 결과가 오기를 기다린다 — 필터 전의 300 을 그대로 읽으면 안 된다.
    await expect.poll(() => loadedCount(page), { timeout: 20000 }).toBeLessThan(300);
    expect(await loadedCount(page)).toBeGreaterThan(0);

    await hist(page).locator('.git-hist-f[data-f="author"]').fill('아무도아님');
    await hist(page).locator('.git-hist-apply').click();
    await expect.poll(() => loadedCount(page), { timeout: 20000 }).toBe(0);
    await expect(hist(page).locator('.git-hist-empty')).toBeVisible();
  });

  test('H12 (V65·FR-GIT-131): 로드 범위 밖의 해시로 jump 하면 로드한 뒤 이동한다', async ({ page }) => {
    const repo = fx('many-commits');
    // 로드 범위(최근 300개) 밖의 커밋.
    const far = execFileSync('git', ['-C', repo, 'rev-parse', 'main~800']).toString().trim();
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 300);

    await hist(page).locator('.git-hist-jump').fill(far);
    await hist(page).locator('.git-hist-jump-go').click();
    await expect.poll(() => loadedCount(page), { timeout: 40000 }).toBeGreaterThan(800);
    await expect(hist(page).locator(`.git-hist-row[data-oid="${far}"]`))
      .toHaveClass(/jumped/, { timeout: 20000 });

    // 없는 대상은 사실만 알린다.
    await hist(page).locator('.git-hist-jump').fill('0000000000000000000000000000000000000000');
    await hist(page).locator('.git-hist-jump-go').click();
    await expect(hist(page).locator('.git-hist-note')).toHaveText(/찾지 못했습니다/, { timeout: 20000 });
  });

  test('H13 (V65·FR-GIT-132): 로드 실패는 사유를 보이고 이미 로드된 목록을 지우지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    await page.route('**/api/git/log**', (route) => route.abort());
    await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(hist(page).locator('.git-hist-note')).toBeVisible({ timeout: 15000 });
    await expect(hist(page).locator('.git-hist-note')).toHaveText(/불러오지 못했습니다/);
    // 목록은 그대로다.
    expect(await loadedCount(page)).toBe(300);
    expect(await commits(page).count()).toBeGreaterThan(0);
  });

  test('H14 (V50·FR-GIT-133): 리포를 바꾸면 목록·필터·선택이 초기화된다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);
    await hist(page).locator('.git-hist-f[data-f="path"]').fill('f7.txt');
    await hist(page).locator('.git-hist-apply').click();
    await expect.poll(() => loadedCount(page), { timeout: 20000 }).toBeLessThan(300);

    await page.evaluate((r) => (window as any).app.gitPanel.setRepo(r), fx('basic'));
    // 필터가 남아 새 리포의 목록을 조용히 걸러내면 요구사항 실패다.
    await expect(hist(page).locator('.git-hist-f[data-f="path"]')).toHaveValue('');
    await expect(hist(page).locator('.git-hist-detail')).toHaveCount(0);
    await waitLoaded(page, 1);
    await expect(commits(page).first().locator('.git-hist-subject')).not.toHaveText(/commit 9999/);
  });
});

test.describe('17단계 — 커밋 상세', () => {
  test('H15 (V51·FR-GIT-135~137): 행 아래에 인라인으로 상세가 펼쳐진다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    const row = commits(page).first();
    const oid = (await row.getAttribute('data-oid'))!;
    await row.click();
    const d = hist(page).locator('.git-hist-detail');
    await expect(d).toBeVisible({ timeout: 15000 });
    // 행 **바로 아래**다 — 별도 고정 영역이 아니다.
    expect(await d.evaluate((el) =>
      (el.previousElementSibling as HTMLElement).classList.contains('git-hist-row'))).toBe(true);
    await expect(d.locator('.git-hist-d-oid')).toHaveText(oid);
    await expect(d.locator('.git-hist-d-parent')).toHaveCount(1);
    await expect(d.locator('.git-hist-d-body')).toHaveText(/body line/);
    await expect(d.locator('.git-hist-d-who')).toHaveText(/Fixture/);
    await expect(d.locator('.git-hist-file')).toHaveCount(1);

    // 펼침은 한 번에 하나만이다 — 여러 개를 허용하면 가변 높이 문제가 되돌아온다.
    await commits(page).nth(2).click();
    await expect(hist(page).locator('.git-hist-detail')).toHaveCount(1);
    // 다시 누르면 접힌다.
    await commits(page).nth(2).click();
    await expect(hist(page).locator('.git-hist-detail')).toHaveCount(0);
  });

  test('H16 (V51·FR-GIT-139): 머지 커밋은 비교 부모를 고를 수 있다', async ({ page }) => {
    const repo = fx('many-commits');
    const merge = execFileSync('git', ['-C', repo, 'log', '--merges', '-1', '--format=%H'])
      .toString().trim();
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 300);

    // 머지 커밋은 로드 범위 안에 있다 (200 커밋마다 하나).
    await hist(page).locator('.git-hist-jump').fill(merge);
    await hist(page).locator('.git-hist-jump-go').click();
    const row = hist(page).locator(`.git-hist-row[data-oid="${merge}"]`);
    await expect(row).toHaveClass(/jumped/, { timeout: 20000 });
    await row.click();

    const d = hist(page).locator('.git-hist-detail');
    await expect(d).toBeVisible({ timeout: 15000 });
    await expect(d.locator('.git-hist-d-parent')).toHaveCount(2);
    const pick = d.locator('.git-hist-d-parentpick');
    await expect(pick).toBeVisible();
    await expect(pick).toHaveValue('0');
    const n0 = await d.locator('.git-hist-file').count();
    await pick.selectOption('1');
    await expect.poll(() => d.locator('.git-hist-file').count(), { timeout: 15000 }).not.toBe(n0);
  });

  test('H17 (FR-GIT-138): 상세의 파일을 누르면 Diff 탭이 commit ↔ parent 축으로 보인다', async ({ page }) => {
    const repo = fx('many-commits');
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
    const parent = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD~1']).toString().trim();
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 300);

    await commits(page).first().click();
    const d = hist(page).locator('.git-hist-detail');
    await expect(d.locator('.git-hist-file').first()).toBeVisible({ timeout: 15000 });
    await expect(d.locator('.git-hist-file').first()).toHaveText(/f49\.txt/);
    await d.locator('.git-hist-file').first().click();
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-diff/);

    await expect(diffBar(page, '.git-diff-path')).toHaveText('f49.txt');
    // 어느 두 리비전을 비교하는지 함께 보인다 (FR-GIT-139).
    const rev = diffBar(page, '.git-diff-rev');
    await expect(rev).toBeVisible();
    await expect(rev).toHaveText(
      new RegExp(`commit ↔ parent · ${parent.slice(0, 8)}\\.\\.${head.slice(0, 8)}`));
    // ‹ › 와 n/m 은 워킹 트리 목록의 것이다 — 커밋 축에서는 뜻이 없다.
    await expect(diffBar(page, '.git-diff-pos')).toHaveText('');
    await expect(diff(page).locator('.git-diff-nav').first()).toBeDisabled();
    await expect(diffBar(page, '.git-diff-gone')).toBeHidden();

    // 양쪽 내용이 실제로 그려진다 (부모: line 9949, 커밋: line 9999).
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
    await expect(diffEditor(page)).toContainText('line 9999');
    await expect(diffEditor(page)).toContainText('line 9949');
  });

  test('H19 (V51·FR-GIT-139·54): 비교 부모를 바꾸면 Diff 도 그 부모와의 비교로 바뀐다', async ({ page }) => {
    const repo = fx('many-commits');
    const merge = execFileSync('git', ['-C', repo, 'log', '--merges', '-1', '--format=%H'])
      .toString().trim();
    const p2 = execFileSync('git', ['-C', repo, 'rev-parse', merge + '^2']).toString().trim();
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 300);

    await hist(page).locator('.git-hist-jump').fill(merge);
    await hist(page).locator('.git-hist-jump-go').click();
    const row = hist(page).locator(`.git-hist-row[data-oid="${merge}"]`);
    await expect(row).toHaveClass(/jumped/, { timeout: 20000 });
    await row.click();

    const d = hist(page).locator('.git-hist-detail');
    const f0 = d.locator('.git-hist-file[data-path="f0.txt"]');
    await expect(f0).toBeVisible({ timeout: 15000 });
    await f0.click();
    // 첫 부모(9900) 와의 비교다.
    await expect(diffEditor(page)).toContainText('line 9900', { timeout: 20000 });

    // 두 번째 부모로 바꾼다 — 같은 (리포, 축, 경로) 이므로 리비전이 식별자에
    // 들어 있지 않으면 이전 응답이 그대로 남는다 (FR-GIT-54·145).
    await page.click('#area .pn-tab[data-git-view="history"]');
    await d.locator('.git-hist-d-parentpick').selectOption('1');
    await expect(d.locator('.git-hist-file[data-path="f0.txt"]')).toBeVisible({ timeout: 15000 });
    await d.locator('.git-hist-file[data-path="f0.txt"]').click();
    await expect(diffEditor(page)).toContainText('line 9850', { timeout: 20000 });
    await expect(diffEditor(page)).not.toContainText('line 9900');
    await expect(diffBar(page, '.git-diff-rev')).toHaveText(new RegExp(p2.slice(0, 8)));
  });

  test('H20 (FR-GIT-138): 루트 커밋은 부모가 없고 이전 내용이 없다 — 오류가 아니다', async ({ page }) => {
    // basic 의 유일한 커밋이 루트다.
    await waitForInit(page);
    await openHistory(page, fx('basic'));
    await waitLoaded(page, 1);

    await commits(page).first().click();
    const d = hist(page).locator('.git-hist-detail');
    await expect(d).toBeVisible({ timeout: 15000 });
    await expect(d.locator('.git-hist-d-parent')).toHaveCount(0);
    await expect(d.locator('.git-hist-d-plabel')).toHaveText('루트 커밋');

    await d.locator('.git-hist-file[data-path="tracked.txt"]').click();
    await expect(diffBar(page, '.git-diff-rev')).toHaveText(/루트 커밋\.\./);
    // 이전 내용이 없다는 사실을 사유로 알리고, 새 내용은 그린다 (FR-GIT-45).
    await expect(diff(page).locator('.git-diff-note')).toHaveText(/새로 추가된 파일입니다/);
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
    await expect(diffEditor(page)).toContainText('one');
  });

  test('H22 (FR-GIT-116·135): 탭을 떠났다 돌아와도 스크롤 위치와 펼친 상세가 남는다', async ({ page }) => {
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    const firstOid = await commits(page).first().getAttribute('data-oid');
    await list(page).evaluate((el) => { el.scrollTop = 2600; });
    // 행 창이 다시 잡힐 때까지 기다린다 — 움직이는 중에 행을 집으면 클릭이 재시도
    // 되면서 다른 행에 닿는다.
    await expect.poll(() => commits(page).first().getAttribute('data-oid'), { timeout: 10000 })
      .not.toBe(firstOid);
    const row = commits(page).nth(3);
    const oid = (await row.getAttribute('data-oid'))!;
    await row.click();
    await expect(hist(page).locator('.git-hist-detail')).toBeVisible({ timeout: 15000 });
    const top = await list(page).evaluate((el) => el.scrollTop);
    expect(top).toBeGreaterThan(0);

    // 탭이 비활성인 사이 목록에는 높이가 없다 — 그 상태로 행 창을 다시 잡으면
    // 화면 한 줄만 남고 펼친 상세와 스크롤 위치를 잃는다.
    await page.click('#area .pn-tab[data-git-view="changes"]');
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
    await page.click('#area .pn-tab[data-git-view="history"]');
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-history/);

    await expect(hist(page).locator(`.git-hist-row[data-oid="${oid}"]`)).toBeVisible();
    await expect(hist(page).locator('.git-hist-detail')).toBeVisible();
    await expect.poll(() => list(page).evaluate((el) => el.scrollTop), { timeout: 5000 }).toBe(top);
  });

  test('H21 (FR-GIT-138): 이름이 바뀐 파일은 origPath 를 함께 보낸다', async ({ page }) => {
    const repo = copyFx('with-remote', 'h21');
    execFileSync('git', ['-C', repo, 'mv', 'f.txt', 'renamed.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'rename f.txt']);
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 1);

    await commits(page).first().click();
    const d = hist(page).locator('.git-hist-detail');
    const file = d.locator('.git-hist-file[data-path="renamed.txt"]');
    await expect(file).toBeVisible({ timeout: 15000 });
    await expect(file).toHaveText(/f\.txt → renamed\.txt/);
    await file.click();

    await expect(diffBar(page, '.git-diff-path')).toHaveText('f.txt → renamed.txt');
    // origPath 를 보내지 않으면 이전 내용이 없다고 답한다 — 그 사유가 나오면 실패다.
    await expect(diffEditor(page)).toBeVisible({ timeout: 20000 });
    await expect(diffEditor(page)).toContainText('a');
    await expect(diff(page).locator('.git-diff-note')).toBeHidden();
  });

  test('H18 (FR-GIT-145): 리포가 바뀌면 진행 중인 상세 응답을 폐기한다', async ({ page }) => {
    const repo = copyFx('basic', 'h18');
    writeFileSync(join(repo, 'h18.txt'), 'x');
    await waitForInit(page);
    await openHistory(page, fx('many-commits'));
    await waitLoaded(page, 300);

    // 상세 응답을 붙잡아 둔 사이 리포를 바꾼다.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/api/git/commit**', async (route) => {
      await held;
      await route.continue();
    });
    await commits(page).first().click();
    await page.evaluate((r) => (window as any).app.gitPanel.setRepo(r), repo);
    release();

    // 이전 리포의 상세가 새 리포의 목록과 함께 보이는 순간이 있어서는 안 된다.
    await expect(hist(page).locator('.git-hist-detail')).toHaveCount(0);
    await waitLoaded(page, 1);
    await expect(hist(page).locator('.git-hist-detail')).toHaveCount(0);
  });

  // ── FR-GIT-222 (V99): refs 사이드바에서도 같은 제스처가 같은 뜻이다 ──
  test('H12 (V99 / FR-GIT-222): refs 의 로컬 브랜치 더블클릭이 checkout 한다', async ({ page }) => {
    const repo = copyFx('with-remote', 'h12');
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 1);

    const local = '.git-refs-group[data-kind="local"] .git-ref';
    await expect.poll(() => hist(page).locator(local).count(), { timeout: 20000 })
      .toBeGreaterThanOrEqual(2);
    // `.git-ref:not(.head)` 는 **형제 필터**다 — locator.locator() 는 자손을 찾는다.
    const target = hist(page).locator(local + ':not(.head)').first();
    const short = (await target.locator('.git-ref-short').textContent())!.trim();
    expect(short).toBeTruthy();

    await target.dblclick();
    // 목록이 다시 그려지므로 조회와 판정을 한 번의 evaluate 안에서 한다.
    await expect.poll(async () => page.evaluate((sel) => {
      const e = document.querySelector(sel + '.head .git-ref-short');
      return e ? (e.textContent || '').trim() : '';
    }, local), { timeout: 20000 }).toBe(short);

    // 단일 클릭의 필터는 살아 있고, 더블클릭이 그것을 **되돌리지 않는다**.
    const sel = await hist(page).locator('.git-ref.sel').count();
    expect(sel, '더블클릭이 필터를 되돌렸다').toBeGreaterThan(0);
  });
});

// ── GIT_REVIEW4_SRS §3.4 / FR-GIT-232 (V121~V123) ──
//
// 커밋 행의 ref 배지에는 리스너가 하나도 없었다. FR-GIT-222 는 Branches 탭과 refs
// 사이드바만 덮었고, 사용자가 말한 "히스토리에서 브랜치 더블클릭"은 이 자리였다.
test.describe('4차 검토 — 커밋 행의 ref 배지 (V121~V123)', () => {
  const badge = (page: Page, kind: string) =>
    hist(page).locator(`.git-hist-badge.${kind}`);

  test('H20 (V121 / FR-GIT-232): 커밋 행의 로컬 브랜치 배지 더블클릭이 checkout 한다', async ({ page }) => {
    const repo = copyFx('with-remote', 'h13');
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 1);

    // 현재 브랜치가 아닌 로컬 배지를 고른다 — 현재 브랜치는 아무 일도 하지 않는다.
    const target = badge(page, 'local').and(hist(page).locator('.git-hist-badge:not(.head)')).first();
    await expect(target).toBeVisible({ timeout: 20000 });
    const name = (await target.textContent())!.trim();
    expect(name).toBeTruthy();

    await target.dblclick();
    // 체크아웃이 실제로 일어났다.
    await expect.poll(async () => page.evaluate(() => (window as any).app.gitPanel.headName()),
      { timeout: 20000 }).toBe(name);
    // FR-GIT-233 (V125): 그 배지에 HEAD 표식이 서고, 이전 브랜치의 표식은 사라진다.
    // 목록이 다시 그려지므로 조회와 판정을 한 번의 evaluate 안에서 한다.
    await expect.poll(async () => page.evaluate(() =>
      [...document.querySelectorAll('.git-hist-badge.local.head')]
        .map(e => (e.textContent || '').trim()).join(','),
    ), { timeout: 20000 }).toBe(name);
  });

  test('H21 (V122 / FR-GIT-232): 현재 브랜치 배지와 태그 배지의 더블클릭은 아무 일도 하지 않는다', async ({ page }) => {
    const repo = copyFx('basic', 'h14');
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 1);

    const head = badge(page, 'local').and(hist(page).locator('.git-hist-badge.head')).first();
    await expect(head).toBeVisible({ timeout: 20000 });
    const was = (await head.textContent())!.trim();
    await head.dblclick();
    // 이름이 그대로고, 상세도 열리지 않는다 (배지 클릭은 행으로 올라가지 않는다).
    await expect(head).toHaveText(was);
    await expect(hist(page).locator('.git-hist-detail')).toHaveCount(0);

    const tag = badge(page, 'tag').first();
    if (await tag.count()) {
      const before = await page.evaluate(() => (window as any).app.gitPanel.headName());
      await tag.dblclick();
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => (window as any).app.gitPanel.headName())).toBe(before);
      await expect(hist(page).locator('.git-hist-detail')).toHaveCount(0);
    }
  });

  test('H22 (V123 / FR-GIT-232): 배지 단일 클릭은 상세를 열지 않고, 우클릭은 ref 메뉴를 연다', async ({ page }) => {
    const repo = copyFx('basic', 'h15');
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 1);

    const b = badge(page, 'local').first();
    await expect(b).toBeVisible({ timeout: 20000 });
    await b.click();
    await page.waitForTimeout(200);
    await expect(hist(page).locator('.git-hist-detail')).toHaveCount(0);

    // 우클릭은 branch 메뉴다 — 커밋 메뉴가 아니다.
    await b.click({ button: 'right' });
    const menu = page.locator('.git-menu');
    await expect(menu).toHaveCount(1);
    expect(await menu.getAttribute('data-kind')).toBe('branch');
    await page.keyboard.press('Escape');

    // 태그 배지의 우클릭은 tag 메뉴다.
    const tag = badge(page, 'tag').first();
    if (await tag.count()) {
      await tag.click({ button: 'right' });
      await expect(menu).toHaveCount(1);
      expect(await menu.getAttribute('data-kind')).toBe('tag');
      await page.keyboard.press('Escape');
    }
  });
});

// ── GIT_REVIEW4_SRS §3.7.1 / FR-GIT-248 (V165~V167) ──
//
// E5: FR-GIT-233 은 **표식**을 관측 파생으로 옮겼지만 배지가 `GitMenu` 에 넘기는
// **대상**은 `git log` decoration 의 `isHead` 를 그대로 실었다. 체크아웃해도 커밋
// 목록은 다시 받지 않으므로(FR-GIT-233 의 근거) 떠나온 브랜치는 영원히 "현재
// 브랜치"로 비활성이 되고, `GitMenu.primary` 가 null 을 돌려 **요청조차 나가지
// 않는다.** 체크아웃이 실패한 것이 아니라 실행되지 않은 것이다.
test.describe('5차 검토 — HEAD 판정의 근거 (V165~V167)', () => {
  const badges = (page: Page) => hist(page).locator('.git-hist-badge');
  const badge = (page: Page, name: string) =>
    badges(page).filter({ hasText: new RegExp('^' + name + '$') }).first();
  const refItem = (page: Page, name: string) =>
    hist(page).locator('.git-refs .git-ref[data-ref$="/' + name + '"]').first();
  const headName = (page: Page) => page.evaluate(() => (window as any).app.gitPanel.headName());

  test('H26 (V165 / FR-GIT-248): 떠나온 브랜치의 배지를 더블클릭하면 되돌아온다', async ({ page }) => {
    const repo = copyFx('with-remote', 'h248a');
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 1);
    expect(await headName(page), '픽스처의 시작 브랜치가 main 이 아니다').toBe('main');

    // 간다 — 낡은 decoration 에서도 `isHead` 가 false 라 지금도 통과하는 방향이다.
    await badge(page, 'no-upstream').dblclick();
    await expect.poll(() => headName(page), { timeout: 20000 }).toBe('no-upstream');

    // 돌아온다 — 커밋 목록을 다시 받지 않은 상태이므로 decoration 은 여전히
    // `HEAD -> main` 이다. 판정이 관측에서 오지 않으면 여기서 아무 일도 안 일어난다.
    await badge(page, 'main').dblclick();
    await expect.poll(() => headName(page), { timeout: 20000 }).toBe('main');
  });

  test('H27 (V166 / FR-GIT-248): 창 밖 체크아웃 뒤 사이드바의 표식과 판정이 함께 따라온다', async ({ page }) => {
    const repo = copyFx('with-remote', 'h248b');
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 1);
    await expect(refItem(page, 'main')).toHaveClass(/\bhead\b/, { timeout: 20000 });

    // 창 밖에서 옮긴다 — refs 를 다시 받는 계기(afterRefWrite)가 없다.
    execFileSync('git', ['-C', repo, 'checkout', '-q', 'no-upstream']);
    await expect.poll(() => headName(page), { timeout: 20000 }).toBe('no-upstream');

    // 표식이 따라 움직인다 (refs 응답은 그대로인데도).
    await expect(refItem(page, 'no-upstream')).toHaveClass(/\bhead\b/, { timeout: 20000 });
    await expect(refItem(page, 'main')).not.toHaveClass(/\bhead\b/);

    // 떠나온 항목의 더블클릭이 체크아웃한다.
    await refItem(page, 'main').dblclick();
    await expect.poll(() => headName(page), { timeout: 20000 }).toBe('main');
  });

  test('H28 (V167 / FR-GIT-248): detached 에서는 어느 ref 에도 HEAD 표식이 서지 않는다', async ({ page }) => {
    const repo = copyFx('with-remote', 'h248c');
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 1);
    await expect(refItem(page, 'main')).toHaveClass(/\bhead\b/, { timeout: 20000 });

    execFileSync('git', ['-C', repo, 'checkout', '-q', '--detach', 'HEAD']);
    await expect.poll(
      () => page.evaluate(() => !!((window as any).app.gitPanel.statusOf() || {}).detached),
      { timeout: 20000 }).toBe(true);

    await expect(hist(page).locator('.git-refs .git-ref.head')).toHaveCount(0, { timeout: 20000 });
    await expect(hist(page).locator('.git-hist-badge.head')).toHaveCount(0);
  });
});

test.describe('FR-GIT-280 — reflog 언급 커밋 포함', () => {
  // 토글이 겨냥하는 상태는 "어떤 ref 도 가리키지 않게 된 커밋" 이다. reset --hard
  // 로 되돌린 커밋이 정확히 그것이며, reflog 로만 닿는다.
  //
  // 표식은 다른 픽스처 제목의 부분 문자열이 아니어야 한다 — 부분 문자열이면
  // hasText 가 남의 행을 집는다.
  const DROPPED = 'ZZDROPPEDBYRESET';

  function repoWithDroppedCommit(tag: string) {
    const repo = copyFx('basic', tag);
    writeFileSync(join(repo, 'dropped.txt'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', DROPPED]);
    execFileSync('git', ['-C', repo, 'reset', '--hard', '-q', 'HEAD~1']);
    return repo;
  }

  test('H-RL1 (V207): 토글을 켜면 버려진 커밋이 목록에 들어오고, 끄면 다시 나간다', async ({ page }) => {
    const repo = repoWithDroppedCommit('reflog');
    await waitForInit(page);
    await openHistory(page, repo);
    await waitLoaded(page, 1);

    const dropped = hist(page).locator('.git-hist-row[data-oid]', { hasText: DROPPED });
    const toggle = hist(page).locator('.git-hist-reflog input');
    const before = await loadedCount(page);
    await expect(dropped).toHaveCount(0);

    await toggle.check();
    await expect.poll(() => loadedCount(page), { timeout: 20000 }).toBe(before + 1);
    await expect(dropped).toHaveCount(1);

    // 끈 것이 화면에 반영되지 않으면 사용자는 껐다고 믿는 목록에서 그 커밋을
    // 계속 본다.
    await toggle.uncheck();
    await expect.poll(() => loadedCount(page), { timeout: 20000 }).toBe(before);
    await expect(dropped).toHaveCount(0);
  });
});
