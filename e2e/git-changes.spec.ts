import { execFileSync } from 'child_process';
import { readFileSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, GIT_VIEW_TABS } from './fixtures';

// GIT_M1_STEP56_CONTRACT §4 — Changes 탭. 검증 V22·V23·V24 + FR-GIT-36·39.
//
// 테스트 저장소는 e2e/git_fixture.sh 가 만든다 (design/README.md) — 테스트
// 안에서 git init 을 되풀이하지 않는다.

const FIXTURES = '/tmp/dm-git-fx-changes-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

// 서버는 rev-parse 로 정규화한 루트를 준다 (macOS 의 /tmp → /private/tmp).
// 활성 리포도 그 값이어야 헤더의 title 비교가 성립한다.
const fx = (name: string) => realpathSync(join(FIXTURES, name));

// 상태를 바꾸는 테스트는 픽스처를 복사해 쓴다 — 원본을 오염시키면 뒤 테스트가
// 앞 테스트의 순서에 묶인다.
const copyFx = makeCopyFx(FIXTURES);
async function openGit(page: Page, repo: string) {
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
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const group = (page: Page, key: string) => changes(page).locator(`.git-group[data-group="${key}"]`);
const rows = (page: Page, key: string) => group(page, key).locator('.git-file');

// constants.js 의 전역 상수 — <script> 로 로드되므로 import 대상이 아니다.
declare const GIT_FILE_ROW_CHUNK: number;

test.describe('묶음 E — Changes 탭', () => {
  test('C1 (V22): 헤더에 리포명·브랜치와 살아 있는 원격 버튼이 나온다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    const head = changes(page).locator('.git-head');
    await expect(head.locator('.git-head-repo')).toHaveText('basic', { timeout: 10000 });
    await expect(head.locator('.git-head-repo')).toHaveAttribute('title', repo);
    await expect(head.locator('.git-head-branch')).toHaveText('main', { timeout: 10000 });

    // 원격은 M3 가 살렸다 (FR-GIT-98). 버튼 3개와 변형을 여는 `▾` 3개다
    // (FR-GIT-99) — status 를 읽었으므로 전부 눌릴 수 있다.
    const remote = head.locator('.git-head-remote button');
    await expect(remote).toHaveCount(6);
    await expect(head.locator('.git-remote-btn')).toHaveCount(3);
    await expect(head.locator('.git-remote-more')).toHaveCount(3);
    await expect(head.locator('.git-remote-btn[data-remote="push"]')).toBeEnabled({ timeout: 10000 });
    expect(await remote.evaluateAll((els) => els.every((e) => !(e as HTMLButtonElement).disabled)),
      '원격 버튼이 꺼져 있다').toBe(true);
    // 진행 중 작업의 화면은 접혀 있다 (FR-GIT-102).
    await expect(changes(page).locator('.git-job')).not.toHaveClass(/vis/);
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

  // FR-GIT-215: git 의 기본값(-u normal)은 추적되지 않는 **디렉터리**를 `newdir/`
  // 한 줄로 접는다. 접힌 행은 트리 보기에서 이름이 빈 문자열이 되고, 클릭해도
  // 디렉터리 경로로 diff 를 걸어 아무것도 열리지 않는다.
  test('C4b (V92·FR-GIT-215): 새 디렉터리 안의 파일이 자기 이름으로 뜨고 열린다', async ({ page }) => {
    const repo = copyFx('basic', 'c4b');
    await waitForInit(page);
    await openGit(page, repo);
    await expect(rows(page, 'untracked').first()).toBeVisible({ timeout: 10000 });

    execFileSync('mkdir', ['-p', join(repo, 'newdir', 'nested')]);
    writeFileSync(join(repo, 'newdir', 'nested', 'doc.md'), '# hi\n');

    // 디렉터리가 아니라 **파일**이 목록에 온다.
    const doc = group(page, 'untracked').locator('.git-file[data-path="newdir/nested/doc.md"]');
    await expect(doc).toBeVisible({ timeout: 10000 });
    // 접힌 디렉터리 항목은 없다.
    const paths = await rows(page, 'untracked').evaluateAll(
      (els) => els.map((e) => (e as HTMLElement).dataset.path || ''));
    expect(paths.filter((p) => p.endsWith('/')), '디렉터리가 항목으로 왔다').toEqual([]);
    // 이름이 비어 있는 행이 없다.
    const names = await rows(page, 'untracked').locator('.git-file-path').allTextContents();
    expect(names.filter((n) => !n.trim()), '이름이 빈 행이 있다').toEqual([]);

    // 클릭하면 본문이 그 파일을 연다 (REPO_TAB_UNIFY_SRS FR-RTU-40 — 사이드의
    // 인라인 미리보기는 폐기됐다, §7 D-RTU-22). untracked 이므로 diff 가 아니라
    // **편집기 탭**이다 (FR-RTU-51 / D-RTU-8): 비교할 왼쪽이 없다.
    await doc.click();
    const tab = page.locator('#area .ed-area .pn-tab', { hasText: 'doc.md' });
    await expect(tab).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('#area .file-editor.vis')).toContainText('hi', { timeout: 20000 });
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
    // FR-GIT-273·274·275 로 항목이 늘었고 FR-GIT-276(Blame)이 하나 더 늘렸다
    // (GIT_ACTIONS_SRS §3.6·§3.8). **저장소를 바꾸는 항목이 하나도 없다**는 것이
    // 이 시험의 본체이고(FR-GIT-41), 그 단정은 아래에 그대로 있다 — 개수는 그
    // 사실의 대리 지표였을 뿐이다.
    await expect(menu.locator('.git-menu-item')).toHaveText([
      'Open Changes', 'Open File', 'Open File (HEAD)', 'Copy Path',
      'File history', 'Blame', 'Add to .gitignore',
    ]);

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

  test('C10 (V25 / FR-GIT-42): 파일이 많아도 한 번에 다 그리지 않고 이어 그린다', async ({ page }) => {
    const repo = fx('many-files'); // 변경 파일 2000개
    await waitForInit(page);
    await openGit(page, repo);
    await expect(rows(page, 'changes').first()).toBeVisible({ timeout: 20000 });

    // 개수 배지는 전부를 세지만 DOM 은 첫 덩어리만 갖는다 — 수천 행을 한 번에
    // 만들면 렌더가 화면을 멈춘다.
    // constants.js 의 const 는 window 프로퍼티가 아니다 — 전역 식별자로 읽는다.
    const chunk = await page.evaluate(() => GIT_FILE_ROW_CHUNK);
    expect(chunk, '청크 상수를 읽지 못했다').toBeGreaterThan(0);
    await expect(group(page, 'changes').locator('.git-group-head'))
      .toContainText('2000');
    const first = await rows(page, 'changes').count();
    expect(first, `첫 렌더가 ${first}행이다 — 청크(${chunk})를 넘으면 이어 그리는 것이 아니다`)
      .toBeLessThanOrEqual(chunk);

    // 끝까지 스크롤하면 다음 덩어리가 이어진다.
    const more = group(page, 'changes').locator('.git-file-more');
    await expect(more).toHaveCount(1);
    await more.scrollIntoViewIfNeeded();
    await expect
      .poll(() => rows(page, 'changes').count(), { timeout: 20000 })
      .toBeGreaterThan(first);

    // 그래도 전부를 그리지는 않는다 — 이어 그리기가 무한 확장이면 뜻이 없다.
    expect(await rows(page, 'changes').count()).toBeLessThan(2000);
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

  // ── FR-GIT-224 (V101): 충돌 파일마다 한쪽을 골라 해결한다 ──
  //
  // 3-way merge editor 는 여전히 비목표다. 이것은 파일 단위로 한쪽을 통째로 받는
  // 것뿐이고, **checkout --ours 만으로는 해결되지 않는다** — index 의 unmerged
  // stage 가 남아 파일이 Conflicts 에서 빠지지 않는다 (실측). add 가 뒤따른다.
  test('C12 (V101·FR-GIT-224): Ours 를 고르면 그 쪽 내용으로 해결된다', async ({ page }) => {
    const repo = copyFx('conflict', 'c12');
    await waitForInit(page);
    await openGit(page, repo);

    const r = rows(page, 'conflicts').first();
    await expect(r).toBeVisible({ timeout: 15000 });
    const path = await r.getAttribute('data-path');
    expect(path).toBeTruthy();

    await r.hover();
    await r.locator('.git-file-act[data-act="ours"]').click();

    // 파괴적이다 — 확인을 거친다 (FR-GIT-89·95). 걸음은 하나다 (FR-COS-1).
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await expect(box).toHaveAttribute('data-stage', '1');
    await page.locator('#git-confirm .gc-go').click();

    // 충돌 그룹에서 빠진다 — `checkout --ours` 만으로는 unmerged 가 남으므로
    // (실측) 여기서 빠졌다는 것이 곧 `add` 까지 갔다는 뜻이다.
    await expect(group(page, 'conflicts').locator(`.git-file[data-path="${path}"]`))
      .toHaveCount(0, { timeout: 20000 });
    // ours 쪽이 HEAD 와 같으면 add 뒤 index == HEAD 라 **어느 그룹에도 없다** —
    // staged 를 단정하면 git 이 옳은데 테스트가 틀린다.
    await expect(changes(page).locator(`.git-file[data-path="${path}"]`))
      .toHaveCount(0, { timeout: 10000 });

    // 워킹 트리가 ours 쪽 내용이다 — 충돌 표식이 남아 있으면 해결이 아니다.
    const body = readFileSync(join(repo, path!), 'utf8');
    expect(body).not.toContain('<<<<<<<');
    expect(body.trim()).toBe('main');
  });

  test('C13 (V101·FR-GIT-224): Theirs 도 같은 경로로 간다', async ({ page }) => {
    const repo = copyFx('conflict', 'c13');
    await waitForInit(page);
    await openGit(page, repo);

    const r = rows(page, 'conflicts').first();
    await expect(r).toBeVisible({ timeout: 15000 });
    const path = await r.getAttribute('data-path');
    await r.hover();
    await r.locator('.git-file-act[data-act="theirs"]').click();
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await page.locator('#git-confirm .gc-go').click();
    await expect(group(page, 'staged').locator(`.git-file[data-path="${path}"]`))
      .toBeVisible({ timeout: 20000 });
    expect(readFileSync(join(repo, path!), 'utf8')).not.toContain('<<<<<<<');
  });

  test('C14 (V101·FR-GIT-224): 취소하면 충돌이 그대로 남는다', async ({ page }) => {
    const repo = copyFx('conflict', 'c14');
    await waitForInit(page);
    await openGit(page, repo);

    const r = rows(page, 'conflicts').first();
    await expect(r).toBeVisible({ timeout: 15000 });
    const path = await r.getAttribute('data-path');
    const before = readFileSync(join(repo, path!), 'utf8');
    await r.hover();
    await r.locator('.git-file-act[data-act="ours"]').click();
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
    await page.locator('#git-confirm .gc-cancel').click();

    await page.waitForTimeout(1200);
    await expect(group(page, 'conflicts').locator(`.git-file[data-path="${path}"]`))
      .toBeVisible();
    expect(readFileSync(join(repo, path!), 'utf8')).toBe(before);
  });

  // 충돌 전부를 한쪽으로 미는 일괄은 두지 않는다 — 한 번의 실수로 되돌릴 수 없는
  // 양을 잃는다 (FR-GIT-72 와 같은 판단).
  test('C15 (V101·FR-GIT-224): 충돌 그룹에는 일괄이 없다', async ({ page }) => {
    const repo = copyFx('conflict', 'c15');
    await waitForInit(page);
    await openGit(page, repo);
    await expect(rows(page, 'conflicts').first()).toBeVisible({ timeout: 15000 });
    await expect(group(page, 'conflicts').locator('.git-group-bulk')).toHaveCount(0);
  });
});

test.describe('FR-GIT-282 — 헤더의 리포 전환 드롭다운', () => {
  // 핀은 서버가 rev-parse 로 재확인한 root 를 저장한다 (macOS 의 /tmp → /private/tmp).
  async function pin(request: APIRequestContext, path: string) {
    const r = await request.post('/api/git/repos/pin', { data: { path } });
    expect(r.ok(), `pin 실패: ${await r.text()}`).toBeTruthy();
    return (await r.json()).root as string;
  }

  test('C-RD1 (V207): 리포명을 누르면 목록이 열리고 고른 리포로 창이 바뀐다', async ({ page, request }) => {
    // 핀은 waitForInit **뒤**다 — 브라우저의 첫 워크스페이스 저장이 앞선 핀을
    // 덮는다 (git-sidebar.spec.ts 의 선례).
    await waitForInit(page);
    const basic = await pin(request, fx('basic'));
    const other = await pin(request, fx('with-remote'));
    // 핀은 **워크스페이스**를 바꾼다. 브라우저가 그 개정을 받기 전에 창을 열면
    // 뒤늦게 도착한 워크스페이스가 방금 만든 창을 지운다. 그래서 도착 판정을
    // 3초 폴링 목록(`_gitRepos`)이 아니라 워크스페이스 자체에서 한다.
    await expect
      .poll(() => page.evaluate(() => ((window as any).app.ws?.git?.pinned || []).length),
        { timeout: 20000 })
      .toBe(2);
    // 목록 자체는 별도 폴링으로 온다 — 도착 전에 열면 현재 리포 하나만 보인다.
    await expect
      .poll(() => page.evaluate(() => ((window as any).app._gitRepos?.pinned || []).length),
        { timeout: 20000 })
      .toBe(2);

    await openGit(page, basic);
    const head = changes(page).locator('.git-head');
    await expect(head.locator('.git-head-repo')).toHaveText('basic', { timeout: 10000 });

    await head.locator('.git-head-repo').click();
    const menu = page.locator('.git-menu[data-kind="repo"]');
    await expect(menu).toBeVisible();
    // 핀 둘이 다 있고, 지금 보고 있는 것이 표시된다 — 표시가 없으면 사용자는
    // 목록에서 자기 자리를 잃는다.
    await expect(menu.locator('.git-menu-item')).toHaveCount(2);
    await expect(menu.locator('.git-menu-item.cur')).toHaveCount(1);

    await menu.locator(`.git-menu-item[data-id="${other}"]`).click();
    await expect(head.locator('.git-head-repo')).toHaveText('with-remote', { timeout: 10000 });
    await expect(head.locator('.git-head-repo')).toHaveAttribute('title', other);
    // 헤더만 바뀌고 목록이 앞 리포의 것이면 사용자는 남의 변경을 자기 것으로 읽는다.
    await expect(page.evaluate(() => (window as any).app.gitPanel.repo)).resolves.toBe(other);
  });
});
