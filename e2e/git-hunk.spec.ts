import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, openGit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath } from './osenv';

// GIT_ACTIONS_SRS §3.7 묶음 G — 부분 스테이징 (FR-GIT-278·279).
// DIFF_HUNK_BAR_SRS 묶음 R·B·S·W — 검증 V-DHB-1~13.
//
// **패치는 서버가 만든다** (D6). 그러므로 이 테스트는 화면이 보내는 것이 좌표뿐임을
// 전제하고, 결과를 **실제 저장소의 index·워킹 트리**에서 확인한다 — 화면의 글자만
// 보면 서버가 무엇을 했는지 알 수 없다. 이 규약은 옛 판에서 그대로 물려받았다.
//
// **조작이 바뀌었다** (DIFF_HUNK_BAR_SRS I-1·I-2): 하단 조각 목록(`.git-hunks`)과
// 그 안의 줄 클릭이 사라지고, diff 위 hover 툴바와 **Monaco 텍스트 선택**이 그
// 자리를 대신한다. 그래서 이 파일의 조작 헬퍼는 DOM 이 아니라 에디터를 딛는다.
//
// 상태를 **바꾸는** 테스트이므로 픽스처를 복사해 쓴다 (git-staging.spec.ts 의 선례).

const FIXTURES = tmpPath('dm-git-fx-hunk-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

// hunkFile 은 30줄 파일을 쓴다. edit 에 든 줄만 다른 내용이 된다 — U3 문맥이
// 겹치지 않으려면 변경 사이가 최소 7줄이어야 한다.
// 표식은 **서로의 부분 문자열이면 안 된다.** `TWENTYFIVE` 가 `FIVE` 를 품으면
// "그 조각만 들어갔다"를 `not.toContain('FIVE')` 로 물을 수 없다 — 남아 있어야 하는
// 다른 조각 때문에 늘 실패한다(실제로 그렇게 헛짚었다).
function hunkFile(repo: string, name: string, edit: Record<number, string> = {}) {
  const lines: string[] = [];
  for (let i = 1; i <= 30; i++) lines.push(edit[i] ?? 'line' + i);
  writeFileSync(join(repo, name), lines.join('\n') + '\n');
}

// hunkRepo 는 30줄 파일 하나를 커밋해 둔 저장소다. 픽스처의 basic 을 복사해
// 기록·설정을 물려받는다 — 여기서 git init 을 되풀이하지 않는다.
function hunkRepo(tag: string) {
  const repo = copyFx('basic', tag);
  hunkFile(repo, 'f.txt');
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-m', 'f');
  return repo;
}

const indexOf = (repo: string) => git(repo, 'show', ':f.txt');
const worktreeOf = (repo: string) => readFileSync(join(repo, 'f.txt'), 'utf8');

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const diff = (page: Page) => page.locator('#area .pn-body .git-view.git-diff');
const row = (page: Page, group: string, path: string) =>
  changes(page).locator(`.git-group[data-group="${group}"] .git-file[data-path="${path}"]`);
const tab = (page: Page, view: string) => page.locator(`#area .pn-tab[data-git-view="${view}"]`);

// 새 표면 셋. 툴바는 Monaco 의 content widget 이므로 에디터 안(또는 오버플로
// 컨테이너)에 렌더된다 — 문서 전체에서 찾는다.
const bar = (page: Page) => page.locator('.git-hunk-bar');
const act = (page: Page, a: string) => bar(page).locator(`.git-hunk-act[data-act="${a}"]`);
const hunkNote = (page: Page) => diff(page).locator('.git-diff-hunk-note');

const confirmBox = (page: Page) => page.locator('#git-confirm .gc-box');
const confirmGo = (page: Page) => page.locator('#git-confirm .gc-go');

// openDiff 는 Changes 의 행을 골라 Diff 탭을 연다. 조각 관측은 그 탭이 든다.
//
// **관측이 도착할 때까지 기다린다** (FR-DHB-20) — 툴바는 경계를 알기 전에는 뜨지
// 않으므로, 기다리지 않은 hover 는 순서에 따라 되다 말다 한다.
async function openDiff(page: Page, group: string, path: string) {
  await expect(row(page, group, path)).toBeVisible({ timeout: 10000 });
  await row(page, group, path).click();
  await tab(page, 'diff').click();
  await expect(diff(page)).toHaveClass(/vis/);
  await page.waitForFunction(() => {
    const h = (window as any).app?.gitPanel?._hunks;
    return !!(h && h.list && h.list.length);
  }, undefined, { timeout: 20000 });
  // **에디터도 기다린다.** 조각 관측(`/api/git/hunks`)과 diff 본문은 서로 다른
  // 요청이고 도착 순서가 보장되지 않는다 — 관측만 기다리면 에디터가 아직 서지
  // 않은 순간에 hover 가 떠나, 좌표를 물을 대상이 `null` 이다. 툴바는 에디터의
  // content widget 이므로(FR-DHB-21) 그것이 서기 전에는 잴 것이 없다.
  await page.waitForFunction(
    () => !!(window as any).app?.gitPanel?._diffView?._editor,
    undefined, { timeout: 20000 });
}

// 조각의 개수. 화면이 그리지 않으므로 관측에서 읽는다 — 그림이 없는 것이 이번
// 변경의 요점이다 (NFR-DHB-1).
const hunkCount = (page: Page) =>
  page.evaluate(() => ((window as any).app.gitPanel._hunks?.list || []).length);

// 모디파이드 에디터의 그 줄로 마우스를 옮긴다 (FR-DHB-11).
//
// `.view-line` 의 DOM 순서는 줄 번호와 다를 수 있으므로(Monaco 는 그것을 보장하지
// 않는다) 좌표를 에디터에게 묻는다.
async function hoverLine(page: Page, line: number) {
  const at = await page.evaluate((ln) => {
    const ed = (window as any).app.gitPanel._diffView._editor.getModifiedEditor();
    ed.revealLine(ln);
    const p = ed.getScrolledVisiblePosition({ lineNumber: ln, column: 1 });
    const r = ed.getDomNode().getBoundingClientRect();
    return { x: r.left + p.left + 30, y: r.top + p.top + p.height / 2 };
  }, line);
  await page.mouse.move(at.x, at.y);
  await expect(bar(page)).toBeVisible({ timeout: 10000 });
}

// 모디파이드 에디터에서 줄 범위를 선택한다 (FR-DHB-30).
//
// 드래그가 아니라 `setSelection` 인 이유는 재는 것이 **선택의 결과**이기 때문이다 —
// 드래그로 만든 선택과 API 로 만든 선택은 에디터 안에서 같은 값이고, 좌표 계산에
// 흔들리지 않는 쪽이 이 검증을 더 정확하게 만든다.
async function selectLines(page: Page, from: number, to: number) {
  await page.evaluate(([a, b]) => {
    const ed = (window as any).app.gitPanel._diffView._editor.getModifiedEditor();
    ed.setSelection({ startLineNumber: a, startColumn: 1, endLineNumber: b, endColumn: 1 });
  }, [from, to + 1]);
}

test.describe('묶음 R — 하단 패널 폐기', () => {
  // V-DHB-1: 조각 UI 가 세로 공간을 먹지 않는다. 이것이 접수한 말의 요구다.
  test('V-DHB-1: Diff 탭에 하단 조각 목록이 없다', async ({ page }) => {
    const repo = hunkRepo('d1');
    hunkFile(repo, 'f.txt', { 10: 'TEN' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');
    await expect(diff(page).locator('.git-hunks')).toHaveCount(0);
    await expect(diff(page).locator('.git-hunk-line')).toHaveCount(0);
  });
});

test.describe('묶음 B·W — hover 툴바와 조각 단위 쓰기', () => {
  // V-DHB-2 (옛 G1): 세 조각 중 하나만 스테이지된다. 나머지는 남는다.
  test('V-DHB-2: hunk 하나만 스테이지되고 나머지는 남는다', async ({ page }) => {
    const repo = hunkRepo('d2');
    hunkFile(repo, 'f.txt', { 5: 'ALPHA', 15: 'BRAVO', 25: 'CHARLIE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');
    expect(await hunkCount(page)).toBe(3);

    await hoverLine(page, 15);
    await expect(act(page, 'stage')).toHaveText('Stage hunk');
    await act(page, 'stage').click();

    // index 에는 고른 조각만, 워킹 트리에는 셋 다 있다.
    await expect.poll(() => indexOf(repo), { timeout: 10000 }).toContain('BRAVO');
    expect(indexOf(repo)).not.toContain('ALPHA');
    expect(indexOf(repo)).not.toContain('CHARLIE');
    expect(worktreeOf(repo)).toContain('ALPHA');
    expect(worktreeOf(repo)).toContain('CHARLIE');

    // 남은 조각은 둘이다 — 화면이 새 관측을 다시 받는다 (FR-DHB-43).
    await expect.poll(() => hunkCount(page), { timeout: 10000 }).toBe(2);
  });

  // V-DHB-3 (옛 G2): staged 행은 index↔HEAD 축이고 붙는 동작은 unstage 뿐이다.
  test('V-DHB-3: 축이 동작을 정한다 — staged 축에는 unstage 만', async ({ page }) => {
    const repo = hunkRepo('d3');
    hunkFile(repo, 'f.txt', { 5: 'ALPHA', 25: 'CHARLIE' });
    git(repo, 'add', 'f.txt');
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'staged', 'f.txt');
    expect(await hunkCount(page)).toBe(2);

    await hoverLine(page, 5);
    await expect(act(page, 'unstage')).toHaveCount(1);
    await expect(act(page, 'stage')).toHaveCount(0);
    await expect(act(page, 'revert')).toHaveCount(0);
    await act(page, 'unstage').click();

    await expect.poll(() => indexOf(repo), { timeout: 10000 }).not.toContain('ALPHA');
    expect(indexOf(repo)).toContain('CHARLIE');
    // unstage 는 워킹 트리를 건드리지 않는다.
    expect(worktreeOf(repo)).toContain('ALPHA');
  });

  // V-DHB-4 (옛 G3): 관측이 그 사이 바뀌었으면 거부된다 — 낡은 번호로 다른 곳을
  // 고치지 않는다. 사유는 **누른 자리**, 곧 Diff 탭 머리에 남는다 (FR-DHB-6).
  test('V-DHB-4: 관측이 바뀌었으면 거부되고 사유가 머리에 남는다', async ({ page }) => {
    const repo = hunkRepo('d4');
    hunkFile(repo, 'f.txt', { 5: 'ALPHA', 25: 'CHARLIE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');
    expect(await hunkCount(page)).toBe(2);

    await hoverLine(page, 5);
    // 사용자가 조각을 보던 사이에 파일이 바뀌었다 — 같은 번호가 다른 곳을 가리킨다.
    hunkFile(repo, 'f.txt', { 5: 'ALPHA', 15: 'BRAVO', 25: 'CHARLIE' });
    await act(page, 'stage').click();

    await expect(hunkNote(page)).toHaveClass(/fail/, { timeout: 10000 });
    await expect(hunkNote(page)).toContainText('다시 받아');
    for (const t of ['ALPHA', 'BRAVO', 'CHARLIE']) {
      expect(indexOf(repo)).not.toContain(t);
    }
  });

  // V-DHB-10: 툴바는 조각 위에서만 뜨고, 마우스가 에디터를 떠나면 사라진다.
  test('V-DHB-10: 조각 밖에서는 뜨지 않고 떠나면 사라진다', async ({ page }) => {
    const repo = hunkRepo('d10');
    // 한 곳만 고친다 — 파일의 위쪽 절반은 어느 조각에도 들지 않는다.
    hunkFile(repo, 'f.txt', { 25: 'CHARLIE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');

    await hoverLine(page, 25);
    // 조각 밖의 줄로 옮기면 사라진다 (FR-DHB-14).
    const at = await page.evaluate(() => {
      const ed = (window as any).app.gitPanel._diffView._editor.getModifiedEditor();
      const p = ed.getScrolledVisiblePosition({ lineNumber: 1, column: 1 });
      const r = ed.getDomNode().getBoundingClientRect();
      return { x: r.left + p.left + 30, y: r.top + p.top + p.height / 2 };
    });
    await page.mouse.move(at.x, at.y);
    await expect(bar(page)).toBeHidden({ timeout: 10000 });

    // 다시 띄운 뒤 에디터 밖으로 나가도 사라진다 (FR-DHB-13).
    await hoverLine(page, 25);
    await page.mouse.move(2, 2);
    await expect(bar(page)).toBeHidden({ timeout: 10000 });
  });

  // V-DHB-11: blame 모드에서는 부분 스테이징이 없다 (FR-DHB-19).
  test('V-DHB-11: blame 모드에서는 툴바가 서지 않는다', async ({ page }) => {
    const repo = hunkRepo('d11');
    hunkFile(repo, 'f.txt', { 15: 'BRAVO' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');
    await hoverLine(page, 15);

    await diff(page).locator('.git-diff-blame').click();
    await expect(bar(page)).toBeHidden({ timeout: 10000 });
    expect(await hunkCount(page)).toBe(0);
  });
});

test.describe('묶음 S — Monaco 선택으로 고르는 줄 범위', () => {
  // V-DHB-5 (옛 G4): 선택한 범위에만 적용된다. 고르지 않은 변경은 index 에
  // 들어가지 않고 원래 내용 그대로 남는다.
  test('V-DHB-5: 줄 범위 stage 가 그 범위에만 적용된다', async ({ page }) => {
    const repo = hunkRepo('d5');
    // 한 줄 건너 두 곳을 고친다 — 한 조각 안에 변경 짝이 둘이다.
    hunkFile(repo, 'f.txt', { 10: 'TEN', 12: 'TWELVE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');
    expect(await hunkCount(page)).toBe(1);

    await hoverLine(page, 10);
    await expect(act(page, 'stage')).toHaveText('Stage hunk');
    // 10번 줄만 고른다 — 그 변경 짝(-line10/+TEN)이 함께 간다 (FR-DHB-33).
    await selectLines(page, 10, 10);
    await expect(act(page, 'stage')).toHaveText('Stage lines');
    await act(page, 'stage').click();

    await expect.poll(() => indexOf(repo), { timeout: 10000 }).toContain('TEN');
    expect(indexOf(repo)).not.toContain('TWELVE');
    expect(indexOf(repo)).toContain('line12');
    // 워킹 트리는 그대로다.
    expect(worktreeOf(repo)).toContain('TEN');
    expect(worktreeOf(repo)).toContain('TWELVE');
  });

  // V-DHB-6 (옛 G5): 줄 범위 unstage 도 그 범위에만 걸린다.
  test('V-DHB-6: 줄 범위 unstage 가 그 범위에만 적용된다', async ({ page }) => {
    const repo = hunkRepo('d6');
    hunkFile(repo, 'f.txt', { 10: 'TEN', 12: 'TWELVE' });
    git(repo, 'add', 'f.txt');
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'staged', 'f.txt');

    await hoverLine(page, 10);
    await selectLines(page, 10, 10);
    await expect(act(page, 'unstage')).toHaveText('Unstage lines');
    await act(page, 'unstage').click();

    await expect.poll(() => indexOf(repo), { timeout: 10000 }).toContain('line10');
    expect(indexOf(repo)).not.toContain('TEN');
    // 고르지 않은 변경은 여전히 staged 다.
    expect(indexOf(repo)).toContain('TWELVE');
  });

  // V-DHB-7 (옛 G6): revert 는 **파괴적이다** — 확인을 거치고 recovery hint 를
  // 보인다. 확인을 끝까지 진행해야 워킹 트리가 바뀐다 (FR-DHB-42).
  test('V-DHB-7: 줄 범위 revert 는 확인을 거친다', async ({ page }) => {
    const repo = hunkRepo('d7');
    hunkFile(repo, 'f.txt', { 10: 'TEN', 12: 'TWELVE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');

    await hoverLine(page, 10);
    await selectLines(page, 10, 10);
    await expect(act(page, 'revert')).toHaveText('Revert lines');
    await act(page, 'revert').click();

    // 한 화면이 영향 범위와 recovery hint 를 함께 보인다 (FR-GIT-91·92, FR-COS-2).
    await expect(confirmBox(page)).toBeVisible({ timeout: 10000 });
    await expect(confirmBox(page)).toHaveAttribute('data-stage', '1');
    await expect(page.locator('#git-confirm .gc-targets')).toContainText('f.txt');
    // 고른 범위를 밝힌다 — 무엇을 되돌리는지 말하지 않는 확인은 확인이 아니다.
    await expect(page.locator('#git-confirm .gc-targets')).toContainText('선택 ');
    // hint 는 되살릴 수 있는 명령이다 — 안내문만 남기지 않는다 (FR-GIT-92).
    await expect(page.locator('#git-confirm .gc-hint')).toContainText('git stash push');
    await confirmGo(page).click();

    await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 10000 });
    await expect.poll(() => worktreeOf(repo), { timeout: 10000 }).toContain('line10');
    expect(worktreeOf(repo)).not.toContain('TEN');
    // 고르지 않은 범위는 그대로 남는다.
    expect(worktreeOf(repo)).toContain('TWELVE');
  });

  // V-DHB-8 (옛 G7): 취소하면 아무 일도 없다. 기본 선택지는 언제나 안전한 쪽이다
  // (FR-GIT-97).
  test('V-DHB-8: revert 를 취소하면 워킹 트리가 그대로다', async ({ page }) => {
    const repo = hunkRepo('d8');
    hunkFile(repo, 'f.txt', { 10: 'TEN' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');

    await hoverLine(page, 10);
    await act(page, 'revert').click();
    await expect(confirmBox(page)).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(worktreeOf(repo)).toContain('TEN');
  });

  /**
   * V-DHB-9 (옛 G8, 뜻이 바뀌었다): 선택이 두 조각을 걸쳐도 적용되는 것은 툴바가
   * 속한 조각 안의 범위뿐이다 (FR-DHB-32).
   *
   * 옛 규약에서는 다른 조각의 줄을 누르면 선택이 그쪽으로 **옮겨갔다**. 선택이 이제
   * 에디터의 것이므로 막을 수 없고, 대신 적용 범위가 hunk 경계에서 잘린다 — 근거는
   * 서버 `patch` 가 hunk 번호를 하나만 받는다는 것이다 (D-3).
   */
  test('V-DHB-9: 선택이 두 조각을 걸쳐도 한 조각만 적용된다', async ({ page }) => {
    const repo = hunkRepo('d9');
    hunkFile(repo, 'f.txt', { 5: 'ALPHA', 25: 'CHARLIE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');
    expect(await hunkCount(page)).toBe(2);

    // 파일의 거의 전부를 고른다 — 두 조각이 다 들어간다.
    await hoverLine(page, 5);
    await selectLines(page, 1, 30);
    await expect(act(page, 'stage')).toHaveText('Stage lines');
    await act(page, 'stage').click();

    await expect.poll(() => indexOf(repo), { timeout: 10000 }).toContain('ALPHA');
    expect(indexOf(repo)).not.toContain('CHARLIE');
    expect(worktreeOf(repo)).toContain('CHARLIE');
  });

  // V-DHB-12: 선택에 바뀐 줄이 없으면 조각 전체로 물러선다 (FR-DHB-34).
  test('V-DHB-12: 문맥만 고르면 라벨이 조각으로 돌아간다', async ({ page }) => {
    const repo = hunkRepo('d12');
    hunkFile(repo, 'f.txt', { 15: 'BRAVO' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');

    await hoverLine(page, 15);
    await selectLines(page, 15, 15);
    await expect(act(page, 'stage')).toHaveText('Stage lines');
    // 조각 안이지만 바뀌지 않은 줄들만 고른다.
    await selectLines(page, 17, 18);
    await expect(act(page, 'stage')).toHaveText('Stage hunk');
    await act(page, 'stage').click();
    // 조각 전체가 올라간다 — 조용히 아무것도 하지 않는 쪽이 더 나쁘다.
    await expect.poll(() => indexOf(repo), { timeout: 10000 }).toContain('BRAVO');
  });
});

test.describe('묶음 S — 좌표 사상 (단위)', () => {
  // V-DHB-13: 순수 함수이므로 브라우저 안에서 바로 잰다. `core/hunk-coords.js` 가
  // 편집기 쪽과 나눠 쓰는 규약이며(D-2), 서버의 `from`/`to` 뜻이 여기 걸려 있다.
  test.beforeEach(async ({ page }) => { await waitForInit(page) });

  // base one..eight 의 2번·7번 줄을 고친 덩어리. git 은 U3 문맥으로 이것을 하나로
  // 만든다 — 그래서 "한 조각 안의 두 변경" 을 재는 자리가 된다.
  const H = {
    index: 0, header: '@@ -1,8 +1,8 @@', oldStart: 1, oldLines: 8, newStart: 1, newLines: 8,
    lines: [' one', '-two', '+TWO', ' three', ' four', ' five', ' six', '-seven', '+SEVEN', ' eight'],
  };

  test('scan 이 새 쪽·옛 쪽 줄 번호를 함께 센다', async ({ page }) => {
    const rows = await page.evaluate((h) => (window as any).gitHunkScan(h)
      .map((r: any) => [r.i, r.mark, r.newLine, r.oldLine]), H);
    expect(rows).toEqual([
      [1, ' ', 1, 1], [2, '-', 0, 2], [3, '+', 2, 0], [4, ' ', 3, 3], [5, ' ', 4, 4],
      [6, ' ', 5, 5], [7, ' ', 6, 6], [8, '-', 0, 7], [9, '+', 7, 0], [10, ' ', 8, 8],
    ]);
  });

  test('선택한 새 줄의 변경 짝이 함께 간다', async ({ page }) => {
    const r = await page.evaluate((h) => [
      (window as any).gitHunkRangeForLines(h, 2, 2),
      (window as any).gitHunkRangeForLines(h, 7, 7),
      (window as any).gitHunkRangeForLines(h, 2, 7),
      (window as any).gitHunkRangeForLines(h, 4, 6),
    ], H);
    // `+TWO` 만 보내면 짝인 `-two` 가 문맥이 되어 두 줄이 다 남는다 (§2.4).
    expect(r[0]).toEqual([2, 3]);
    expect(r[1]).toEqual([8, 9]);
    expect(r[2]).toEqual([2, 9]);
    // 문맥만 고르면 사상이 서지 않는다 — 호출자가 조각 전체로 물러선다.
    expect(r[3]).toBeNull();
  });

  test('삭제만 있는 변경은 선택으로 닿지 않는다', async ({ page }) => {
    const r = await page.evaluate(() => (window as any).gitHunkRangeForLines({
      index: 0, oldStart: 1, oldLines: 5, newStart: 1, newLines: 3,
      lines: [' a', '-b', '-c', ' d', ' e'],
    }, 1, 3));
    expect(r).toBeNull();
  });

  test('no-newline 표식은 앞 줄과 함께 간다', async ({ page }) => {
    const r = await page.evaluate(() => (window as any).gitHunkRangeForLines({
      index: 0, oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
      lines: [' a', '-b', '\\ No newline at end of file', '+B',
        '\\ No newline at end of file'],
    }, 2, 2));
    expect(r).toEqual([2, 5]);
  });

  test('편집기 경로도 같은 규약을 쓴다 (회귀)', async ({ page }) => {
    const r = await page.evaluate((h) => [
      (window as any).gitHunkCoordsForChange([h],
        { type: 'mod', line: 2, count: 1, baseStart: 2, baseCount: 1 }),
      (window as any).gitHunkCoordsForChange([h],
        { type: 'add', line: 99, count: 1, baseStart: 99, baseCount: 0 }),
    ], H);
    expect(r[0]).toEqual({ hunk: 0, from: 2, to: 3, wide: false });
    // 겹치는 덩어리가 없으면 null — 관측이 낡았다는 뜻이다.
    expect(r[1]).toBeNull();
  });
});
