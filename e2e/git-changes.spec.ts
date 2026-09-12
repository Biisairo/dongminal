import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import {
  test, expect, makeCopyFx, waitForInit, GIT_VIEW_TABS, openRowMenu, openGit, gitFixture, cleanGitFixture, clickRowAct,
} from './fixtures';
import { tmpPath, realPath, cssPath } from './osenv';

// GIT_M1_STEP56_CONTRACT §4 — Changes 탭. 검증 V22·V23·V24 + FR-GIT-36·39.
//
// 테스트 저장소는 e2e/git_fixture.sh 가 만든다 (design/README.md) — 테스트
// 안에서 git init 을 되풀이하지 않는다.

const FIXTURES = tmpPath('dm-git-fx-changes-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

// 서버는 rev-parse 로 정규화한 루트를 준다 (macOS 의 /tmp → /private/tmp).
// 활성 리포도 그 값이어야 헤더의 title 비교가 성립한다.
const fx = (name: string) => realPath(join(FIXTURES, name));

// 상태를 바꾸는 테스트는 픽스처를 복사해 쓴다 — 원본을 오염시키면 뒤 테스트가
// 앞 테스트의 순서에 묶인다.
const copyFx = makeCopyFx(FIXTURES);
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
    await expect(rows(page, 'working').first()).toBeVisible({ timeout: 10000 });

    mkdirSync(join(repo, 'newdir', 'nested'), { recursive: true });
    writeFileSync(join(repo, 'newdir', 'nested', 'doc.md'), '# hi\n');

    // 디렉터리가 아니라 **파일**이 목록에 온다.
    const doc = group(page, 'working').locator('.git-file[data-path="newdir/nested/doc.md"]');
    await expect(doc).toBeVisible({ timeout: 10000 });
    // 접힌 디렉터리 항목은 없다.
    const paths = await rows(page, 'working').evaluateAll(
      (els) => els.map((e) => (e as HTMLElement).dataset.path || ''));
    expect(paths.filter((p) => p.endsWith('/')), '디렉터리가 항목으로 왔다').toEqual([]);
    // 이름이 비어 있는 행이 없다.
    const names = await rows(page, 'working').locator('.git-file-path').allTextContents();
    expect(names.filter((n) => !n.trim()), '이름이 빈 행이 있다').toEqual([]);

    // 클릭하면 본문이 그 파일을 연다 (REPO_TAB_UNIFY_SRS FR-RTU-40 — 사이드의
    // 인라인 미리보기는 폐기됐다, §7 D-RTU-22). 새 파일은 **비교의 왼쪽이 없어**
    // 편집기 탭이다 (FR-RTU-51 — index 에 그 경로가 없다).
    await doc.click();
    const tab = page.locator('#area .ed-area .pn-tab', { hasText: 'doc.md' });
    await expect(tab).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('#area .file-editor.vis')).toContainText('hi', { timeout: 20000 });
  });

  // PANEL_SURFACE_SRS FR-CMG-1·2·3 (V-8): 워킹 그룹 하나에 수정과 새 파일이 함께
  // 있고, 갈리는 것은 앞단의 상태 문자다. `basic` 은 수정 2 + 새 파일 1 이다.
  test('C4 (V23 / V-8): 파일을 만들면 워킹 그룹 개수가 늘고 행이 `?` 로 보인다', async ({ page }) => {
    const repo = copyFx('basic', 'c4');
    await waitForInit(page);
    await openGit(page, repo);

    const g = group(page, 'working');
    await expect(g.locator('.git-group-count')).toHaveText('(3)', { timeout: 10000 });
    writeFileSync(join(repo, 'c4-new.txt'), 'x');
    await expect(g.locator('.git-group-count')).toHaveText('(4)', { timeout: 10000 });
    await expect(g.locator('.git-file[data-path="c4-new.txt"]')).toBeVisible();
    // FR-CMG-3: 출신은 상태 문자가 말한다 — 그룹이 아니다.
    await expect(g.locator('.git-file[data-path="c4-new.txt"] .git-file-st')).toHaveText('?');
    await expect(g.locator('.git-file[data-path="tracked.txt"] .git-file-st')).toHaveText('M');
    // FR-CMG-11: 합계 옆의 내역이 지울 것이 있는지 말한다.
    await expect(g.locator('.git-group-count')).toHaveAttribute('title', '추적 2 · 새 파일 2');
  });

  test('C5 (V23): git add 한 파일이 staged 그룹에 있다', async ({ page }) => {
    const repo = copyFx('basic', 'c5');
    await waitForInit(page);
    await openGit(page, repo);

    await expect(rows(page, 'working').first()).toBeVisible({ timeout: 10000 });
    execFileSync('git', ['-C', repo, 'add', 'untracked.txt']);
    await expect(group(page, 'staged').locator('.git-file[data-path="untracked.txt"]'))
      .toBeVisible({ timeout: 10000 });
    // 새 파일이 staged 로 옮겨 갔으므로 워킹 그룹은 수정 2 만 남는다.
    await expect(group(page, 'working').locator('.git-group-count')).toHaveText('(2)');
  });

  test('C6 (V23): 트리/플랫 토글이 동작한다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    const files = changes(page).locator('.git-files');
    await expect(rows(page, 'working').first()).toBeVisible({ timeout: 10000 });
    // 기본은 플랫 — 디렉터리 노드가 없고 경로가 통째로 보인다.
    await expect(files.locator('.git-dir')).toHaveCount(0);
    await expect(rows(page, 'working').filter({ hasText: '디렉터리 한글/파일 이름.txt' })).toHaveCount(1);

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

    const row = rows(page, 'working').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    // 17단계가 이 메뉴를 GitMenu 프레임워크로 흡수했다 (FR-GIT-146).
    const menu = page.locator('.git-menu');
    // 메뉴가 뜬 뒤 항목을 세는 사이에 목록이 다시 그려지면 우클릭한 행이 사라지고
    // 메뉴도 닫힌다 — 그러면 항목이 0개다 (실측). 여는 것과 세는 것을 한 재시도
    // 안에 둔다.
    await expect(async () => {
      await openRowMenu(page, row);
      await expect(menu.locator('.git-menu-item')).toHaveCount(7, { timeout: 3000 });
    }).toPass({ timeout: 20000 });
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
    await expect(rows(page, 'working').first()).toBeVisible({ timeout: 20000 });
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
    await expect(rows(page, 'working').first()).toBeVisible({ timeout: 20000 });

    // 개수 배지는 전부를 세지만 DOM 은 첫 덩어리만 갖는다 — 수천 행을 한 번에
    // 만들면 렌더가 화면을 멈춘다.
    // constants.js 의 const 는 window 프로퍼티가 아니다 — 전역 식별자로 읽는다.
    const chunk = await page.evaluate(() => GIT_FILE_ROW_CHUNK);
    expect(chunk, '청크 상수를 읽지 못했다').toBeGreaterThan(0);
    await expect(group(page, 'working').locator('.git-group-head'))
      .toContainText('2000');
    const first = await rows(page, 'working').count();
    expect(first, `첫 렌더가 ${first}행이다 — 청크(${chunk})를 넘으면 이어 그리는 것이 아니다`)
      .toBeLessThanOrEqual(chunk);

    // 끝까지 스크롤하면 다음 덩어리가 이어진다.
    const more = group(page, 'working').locator('.git-file-more');
    await expect(more).toHaveCount(1);
    await more.scrollIntoViewIfNeeded();
    await expect
      .poll(() => rows(page, 'working').count(), { timeout: 20000 })
      .toBeGreaterThan(first);

    // 그래도 전부를 그리지는 않는다 — 이어 그리기가 무한 확장이면 뜻이 없다.
    expect(await rows(page, 'working').count()).toBeLessThan(2000);
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

    await clickRowAct(page, r, 'ours');

    // 파괴적이다 — 확인을 거친다 (FR-GIT-89·95). 걸음은 하나다 (FR-COS-1).
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await expect(box).toHaveAttribute('data-stage', '1');
    await page.locator('#git-confirm .gc-go').click();

    // 충돌 그룹에서 빠진다 — `checkout --ours` 만으로는 unmerged 가 남으므로
    // (실측) 여기서 빠졌다는 것이 곧 `add` 까지 갔다는 뜻이다.
    await expect(group(page, 'conflicts').locator(`.git-file[data-path="${cssPath(path)}"]`))
      .toHaveCount(0, { timeout: 20000 });
    // ours 쪽이 HEAD 와 같으면 add 뒤 index == HEAD 라 **어느 그룹에도 없다** —
    // staged 를 단정하면 git 이 옳은데 테스트가 틀린다.
    await expect(changes(page).locator(`.git-file[data-path="${cssPath(path)}"]`))
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
    await clickRowAct(page, r, 'theirs');
    const box = page.locator('#git-confirm .gc-box');
    await expect(box).toBeVisible({ timeout: 10000 });
    await page.locator('#git-confirm .gc-go').click();
    await expect(group(page, 'staged').locator(`.git-file[data-path="${cssPath(path)}"]`))
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
    await clickRowAct(page, r, 'ours');
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
    await page.locator('#git-confirm .gc-cancel').click();

    // **예외 (`TEST-16`)**: 취소한 해결이 **일어나지 않음**을 잰다.
    await page.waitForTimeout(1200);
    await expect(group(page, 'conflicts').locator(`.git-file[data-path="${cssPath(path)}"]`))
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
    // 3초 폴링 목록(`gitRepos`)이 아니라 워크스페이스 자체에서 한다.
    await expect
      .poll(() => page.evaluate(() => ((window as any).app.ws?.git?.pinned || []).length),
        { timeout: 20000 })
      .toBe(2);
    // 목록 자체는 별도 폴링으로 온다 — 도착 전에 열면 현재 리포 하나만 보인다.
    await expect
      .poll(() => page.evaluate(() => ((window as any).app.testing.gitRepos?.pinned || []).length),
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

    // 경로를 CSS 속성 선택자에 넣는 자리다 — 이스케이프를 거른다 (FR-CEM-16).
    await menu.locator(`.git-menu-item[data-id="${cssPath(other)}"]`).click();
    await expect(head.locator('.git-head-repo')).toHaveText('with-remote', { timeout: 10000 });
    await expect(head.locator('.git-head-repo')).toHaveAttribute('title', other);
    // 헤더만 바뀌고 목록이 앞 리포의 것이면 사용자는 남의 변경을 자기 것으로 읽는다.
    await expect(page.evaluate(() => (window as any).app.gitPanel.repo)).resolves.toBe(other);
  });
});

/**
 * UI 개정 — **파일 선택과 목록의 구조** (FR-GIT-187~191·211·212·220).
 *
 * 변경 목록이 이 파일의 주제다 — 체크박스를 걷고 행 클릭 + 보조키로 옮긴 자리,
 * 트리·플랫 보기의 들여쓰기, 그룹 머리글의 높이.
 *
 * `TEST-7` 로 `git-ui-revision` 에서 옮겨 왔다 — 납품 묶음(“UI 개정”)이 아니라
 * **이 기능**이 주제인 자리다. 단정은 옮기면서 바꾸지 않았다.
 */
const GURFX = tmpPath('dm-gur-git-changes-' + process.pid);
test.beforeAll(() => { gitFixture(GURFX) });
test.afterAll(() => { cleanGitFixture(GURFX) });
const gurFx = (n: string) => realPath(join(GURFX, n));
const gurCopy = makeCopyFx(GURFX);

async function gurOpenChanges(page: Page, repo: string) {
  await openGit(page, repo);
  await page.evaluate(() => (window as any).app.gitPanel.openView('changes'));
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const gurFiles = (page: Page) => page.locator('#area .ed-side .git-file');

// 파일 목록이 채워질 때까지 기다린다 — status 조회는 비동기다.
async function gurWaitFiles(page: Page, min = 1) {
  await expect.poll(() => gurFiles(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(min);
}

test.describe('UI 개정 — 파일 선택 (FR-GIT-187~191)', () => {
  test('V76 (FR-GIT-187·188): 체크박스가 없고 클릭·Cmd·Shift 가 선택을 만든다', async ({ page }) => {
    await waitForInit(page);
    await gurOpenChanges(page, gurFx('basic'));
    await gurWaitFiles(page, 5);

    // 체크박스는 사라졌다.
    await expect(page.locator('#area .ed-side .git-file-check')).toHaveCount(0);
    await expect(page.locator('#area .ed-side .git-file input[type=checkbox]')).toHaveCount(0);

    const sel = () => page.evaluate(() =>
      [...document.querySelectorAll('#area .ed-side .git-file.sel')].map(e => (e as HTMLElement).dataset.path));
    const cur = () => page.evaluate(() =>
      [...document.querySelectorAll('#area .ed-side .git-file.cur')].map(e => (e as HTMLElement).dataset.path));
    const preview = () => page.evaluate(() => ((window as any).app.gitPanel.previewFile || {}).path || null);

    // 클릭: 선택을 그 행 하나로 바꾸고 미리보기를 채운다.
    await gurFiles(page).nth(0).click();
    const p0 = await gurFiles(page).nth(0).getAttribute('data-path');
    await expect.poll(sel).toEqual([p0]);
    expect(await cur()).toEqual([p0]);
    await expect.poll(preview).toBe(p0);

    // Cmd/Ctrl + 클릭: 토글해 더한다. 미리보기는 그 행이다.
    await gurFiles(page).nth(2).click({ modifiers: ['ControlOrMeta'] });
    const p2 = await gurFiles(page).nth(2).getAttribute('data-path');
    expect((await sel()).sort()).toEqual([p0, p2].sort());
    expect(await cur()).toEqual([p2]);
    await expect.poll(preview).toBe(p2);

    // 같은 행을 다시 Cmd 클릭하면 빠진다.
    await gurFiles(page).nth(2).click({ modifiers: ['ControlOrMeta'] });
    await expect.poll(sel).toEqual([p0]);

    // Shift + 클릭: 앵커부터 그 행까지를 **범위로 바꾼다**. 앵커는 방금 누른
    // 행(2번)이므로 2~3 두 개다 — 더하지 않고 갈아치우므로 0번은 빠진다.
    await gurFiles(page).nth(3).click({ modifiers: ['Shift'] });
    expect((await sel()).length).toBe(2);
    expect(await cur()).toEqual([await gurFiles(page).nth(3).getAttribute('data-path')]);

    // 평클릭으로 앵커를 옮기면 범위의 기준도 함께 옮겨진다.
    await gurFiles(page).nth(1).click();
    await gurFiles(page).nth(4).click({ modifiers: ['Shift'] });
    expect((await sel()).length).toBe(4);
  });

  test('V77 (FR-GIT-189): 선택 표식과 포커스 표식이 서로 다르다', async ({ page }) => {
    await waitForInit(page);
    await gurOpenChanges(page, gurFx('basic'));
    await gurWaitFiles(page, 3);

    await gurFiles(page).nth(0).click();
    await gurFiles(page).nth(1).click({ modifiers: ['ControlOrMeta'] });

    // 두 행 모두 선택이지만 포커스는 하나다 — 둘을 같게 그리면 미리보기가 어느
    // 행을 보이는지 알 수 없다.
    const marks = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#area .ed-side .git-file')] as HTMLElement[];
      const selOnly = rows.find(r => r.classList.contains('sel') && !r.classList.contains('cur'))!;
      const focused = rows.find(r => r.classList.contains('cur'))!;
      const cs = (e: HTMLElement) => {
        const s = getComputedStyle(e);
        return { bg: s.backgroundColor, shadow: s.boxShadow, border: s.borderLeftWidth + ' ' + s.borderLeftColor };
      };
      return { selOnly: cs(selOnly), focused: cs(focused), plain: cs(rows.find(r => !r.classList.contains('sel'))!) };
    });
    // 선택은 배경으로 구분되고, 포커스는 배경 말고 다른 것으로 한 번 더 구분된다.
    expect(marks.selOnly.bg).not.toBe(marks.plain.bg);
    expect(marks.focused.shadow + '|' + marks.focused.border)
      .not.toBe(marks.selOnly.shadow + '|' + marks.selOnly.border);
  });

  test('V78 (FR-GIT-190): 일부만 스테이지된 파일은 상태 문자 색으로 구분된다', async ({ page }) => {
    await waitForInit(page);
    await gurOpenChanges(page, gurFx('basic'));
    await gurWaitFiles(page, 5);

    // basic 픽스처의 `디렉터리 한글/파일 이름.txt` 는 staged + unstaged 다.
    const colors = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#area .ed-side .git-file')] as HTMLElement[];
      const partial = rows.find(r => r.classList.contains('partial'));
      const plain = rows.find(r => !r.classList.contains('partial'));
      const st = (r?: HTMLElement) => r ? getComputedStyle(r.querySelector('.git-file-st')!).color : null;
      return { partial: st(partial), plain: st(plain), hasPartial: !!partial };
    });
    expect(colors.hasPartial).toBe(true);
    expect(colors.partial).not.toBe(colors.plain);
  });
});

// FR-GIT-195~198 의 하한 (FR-GIT-226 으로 개정). 기준은 VSCode 가 아니라 이 앱의
// WINDOWS 목록 행(`.si` 30px)이다. 여기 한 곳에만 둔다 — 흩어지면 한쪽만 고쳐진다.
const MIN_HIT = 30;      // 아이콘 버튼의 히트 영역
const MIN_LABELED = 30;  // 라벨을 가진 버튼의 높이
const MIN_ROW = 30;      // 목록 행
const MIN_FONT = 11;     // 컨트롤 라벨
const MIN_LIST_FONT = 12;

// Git 표면의 컨트롤 치수를 한 번에 잰다. 보이지 않는 것은 재지 않는다.
async function measure(page: Page, scope: string) {
  return page.evaluate((sc) => {
    const root = document.querySelector(sc);
    if (!root) return null;
    const vis = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const grab = (sel: string) => [...root.querySelectorAll(sel)].filter(vis).map((e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return {
        cls: String((e as HTMLElement).className).slice(0, 48),
        text: (e.textContent || '').trim().slice(0, 16),
        w: Math.round(r.width), h: Math.round(r.height),
        font: parseFloat(s.fontSize),
      };
    });
    return { buttons: grab('button'), rows: grab('.git-file, .git-br-row, .git-stash-row') };
  }, scope);
}


test.describe('UI 개정 — 목록의 구조 (FR-GIT-211~212)', () => {
  test('V88 (FR-GIT-211): 트리 보기의 행이 깊이만큼 세로선을 갖는다', async ({ page }) => {
    await waitForInit(page);
    await gurOpenChanges(page, gurFx('basic'));
    await gurWaitFiles(page, 3);
    await page.locator('#area .ed-side .git-files-mode[data-mode="tree"]').click();
    await expect(page.locator('#area .ed-side .git-dir').first()).toBeVisible({ timeout: 10000 });

    const rows = () => page.evaluate(() =>
      [...document.querySelectorAll('#area .ed-side .git-file, #area .ed-side .git-dir')]
        .map((e) => {
          const s = getComputedStyle(e);
          return {
            depth: Number(s.getPropertyValue('--git-depth').trim() || 0),
            image: s.backgroundImage,
            width: s.backgroundSize.split(' ')[0],
          };
        }));

    const tree = await rows();
    // basic 픽스처는 `디렉터리 한글/` 아래에 파일이 있어 깊이 1 이상인 행이 있다.
    const deep = tree.filter((r) => r.depth > 0);
    expect(deep.length, '들여쓴 행이 없다').toBeGreaterThan(0);
    for (const r of deep) {
      expect(r.image, '세로선이 없다: ' + JSON.stringify(r)).toContain('gradient');
      // 선이 깊이만큼 그려진다 — 깊이 1 이면 한 칸(12px) 폭이다.
      expect(r.width).toBe(r.depth * 12 + 'px');
    }
    // 깊이 0 인 행에는 선이 없다 (폭 0).
    const flatRows = tree.filter((r) => r.depth === 0);
    expect(flatRows.length).toBeGreaterThan(0);
    for (const r of flatRows) expect(r.width).toBe('0px');

    // 플랫 보기에는 들여쓴 행 자체가 없다.
    await page.locator('#area .ed-side .git-files-mode[data-mode="flat"]').click();
    await expect.poll(async () => (await rows()).every((r) => r.depth === 0), { timeout: 10000 })
      .toBe(true);
    expect((await rows()).every((r) => r.depth === 0)).toBe(true);
  });

  test('V89 (FR-GIT-212): 그룹이 선으로 나뉘고 첫 그룹 위에는 선이 없다', async ({ page }) => {
    await waitForInit(page);
    await gurOpenChanges(page, gurFx('basic'));
    await gurWaitFiles(page, 3);

    const borders = await page.evaluate(() =>
      [...document.querySelectorAll('#area .ed-side .git-group')]
        // 제품은 `.gone` 을 `[hidden]` 으로 옮겼다 (FR-LAY-3·30) — 숨김의 어휘는 하나다.
        .filter((e) => !(e as HTMLElement).hidden)
        .map((e) => ({
          group: (e as HTMLElement).dataset.group,
          top: getComputedStyle(e).borderTopWidth,
        })));
    // FR-CMG-1: 그룹은 셋이고, 충돌이 없는 `basic` 에서는 그중 둘만 선다
    // (사용자 지시 2026-09-08: 충돌 그룹은 충돌이 있을 때만 나타난다).
    expect(borders.map((b) => b.group)).toEqual(['staged', 'working']);
    expect(borders[0].top, '첫 그룹 위에 선이 있다').toBe('0px');
    for (const b of borders.slice(1)) {
      expect(b.top, '구분선이 없다: ' + b.group).not.toBe('0px');
    }
  });
});


test.describe('UI 개정 — 그룹 머리글 높이 (FR-GIT-220)', () => {
  test('V97 (FR-GIT-220): 일괄 버튼이 없는 그룹도 머리글 높이가 같다', async ({ page }) => {
    await waitForInit(page);
    await gurOpenChanges(page, gurFx('conflict'));
    await expect.poll(async () =>
      (await page.locator('#area .ed-side .git-group').count()), { timeout: 20000 })
      .toBeGreaterThanOrEqual(2);

    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('#area .ed-side .git-group')].map((g) => ({
        group: (g as HTMLElement).dataset.group,
        h: Math.round((g.querySelector('.git-group-head') as HTMLElement).getBoundingClientRect().height),
        bulk: !!g.querySelector('.git-group-bulk'),
      })));
    expect(heads.length).toBeGreaterThanOrEqual(2);
    // 일괄이 없는 그룹이 실제로 있어야 이 테스트가 뜻을 갖는다.
    expect(heads.some((x) => !x.bulk), '일괄 없는 그룹이 목록에 없다').toBe(true);
    const uniq = [...new Set(heads.map((x) => x.h))];
    expect(uniq, '머리글 높이가 그룹마다 다르다: ' + JSON.stringify(heads)).toHaveLength(1);
  });
});

// FR-GIT-216: 섹션 경계의 굵기 하한. 색은 테스트가 정하지 않는다 — 테마에서
// 파생하므로 "행 구분선과 다른가" 로만 판정한다.
const SEC_BORDER_W = 2;

// 경계선을 읽는다. **조회와 계산을 한 번의 evaluate 안에서** 한다 — 1초 폴링이
// 목록을 다시 그리므로 밖에서 잡은 요소는 계산 시점에 떨어져 나갈 수 있고,
// 떨어진 요소의 getComputedStyle 은 빈 값을 준다.
const edges = (page: Page, sel: string, side: 'top' | 'bottom') =>
  page.evaluate(([q, s]) => {
    return [...document.querySelectorAll(q)].map((el) => {
      const c = getComputedStyle(el);
      return {
        w: parseFloat(c.getPropertyValue(`border-${s}-width`)) || 0,
        color: c.getPropertyValue(`border-${s}-color`),
      };
    });
  }, [sel, side] as const);

const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement)
    .getPropertyValue(n).trim(), name);

