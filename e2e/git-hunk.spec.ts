import { execFileSync } from 'child_process';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_ACTIONS_SRS §3.7 묶음 G — 부분 스테이징 (FR-GIT-278·279).
// 검증 V205(hunk 하나만 · 관측이 바뀌면 거부) · V206(줄 범위 · revert 2단계 확인).
//
// **패치는 서버가 만든다** (D6). 그러므로 이 테스트는 화면이 보내는 것이 좌표뿐임을
// 전제하고, 결과를 **실제 저장소의 index·워킹 트리**에서 확인한다 — 화면의 글자만
// 보면 서버가 무엇을 했는지 알 수 없다.
//
// 상태를 **바꾸는** 테스트이므로 픽스처를 복사해 쓴다 (git-staging.spec.ts 의 선례).

const FIXTURES = '/tmp/dm-git-fx-hunk-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

function copyFx(name: string, tag: string) {
  const dst = join(FIXTURES, 'copy-' + tag);
  rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-R', join(FIXTURES, name), dst]);
  return realpathSync(dst);
}

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

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
}

const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const diff = (page: Page) => page.locator('#area .pn-body .git-view.git-diff');
const row = (page: Page, group: string, path: string) =>
  changes(page).locator(`.git-group[data-group="${group}"] .git-file[data-path="${path}"]`);
const tab = (page: Page, view: string) => page.locator(`#area .pn-tab[data-git-view="${view}"]`);

const hunks = (page: Page) => diff(page).locator('.git-hunks');
const hunk = (page: Page, i: number) => hunks(page).locator(`.git-hunk[data-hunk="${i}"]`);
const act = (page: Page, i: number, a: string) =>
  hunk(page, i).locator(`.git-hunk-act[data-act="${a}"]`);
const line = (page: Page, i: number, n: number) =>
  hunk(page, i).locator(`.git-hunk-line[data-i="${n}"]`);

const confirmBox = (page: Page) => page.locator('#git-confirm .gc-box');
const confirmGo = (page: Page) => page.locator('#git-confirm .gc-go');

// openDiff 는 Changes 의 행을 골라 Diff 탭을 연다. 조각 목록은 그 탭 안에 산다.
async function openDiff(page: Page, group: string, path: string) {
  await expect(row(page, group, path)).toBeVisible({ timeout: 10000 });
  await row(page, group, path).click();
  await tab(page, 'diff').click();
  await expect(diff(page)).toHaveClass(/vis/);
  await expect(hunks(page)).toHaveClass(/vis/);
}

// hunkLineIndex 는 조각 본문에서 그 줄의 1-기반 번호다. 번호를 테스트가 세면 서버의
// 경계와 두 벌이 되므로 화면에 그려진 것에서 읽는다.
async function hunkLineIndex(page: Page, i: number, text: string) {
  const lines = hunk(page, i)
    .locator('.git-hunk-line');
  // **기다린다.** 조각 목록은 `/api/git/hunks` 가 도착한 뒤에 그려지므로, 열자마자
  // 읽으면 아직 없을 수 있다 — 대기 없는 조회는 순서에 따라 되다 말다 한다.
  await expect.poll(async () =>
    lines.evaluateAll((els, want) => els.findIndex((e) => e.textContent === want) + 1, text),
  { timeout: 15000 }).toBeGreaterThan(0);
  return lines.evaluateAll((els, want) =>
    els.findIndex((e) => e.textContent === want) + 1, text);
}

test.describe('묶음 G — 부분 스테이징 (hunk · 줄 범위)', () => {
  // G1 (V205): 세 조각 중 하나만 스테이지된다. 나머지는 남는다.
  test('G1 (V205): hunk 하나만 스테이지되고 나머지는 남는다', async ({ page }) => {
    const repo = hunkRepo('g1');
    hunkFile(repo, 'f.txt', { 5: 'ALPHA', 15: 'BRAVO', 25: 'CHARLIE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');

    await expect(hunks(page).locator('.git-hunk')).toHaveCount(3);
    await act(page, 1, 'stage').click();

    // index 에는 고른 조각만, 워킹 트리에는 셋 다 있다.
    await expect
      .poll(() => indexOf(repo), { timeout: 10000 })
      .toContain('BRAVO');
    expect(indexOf(repo)).not.toContain('ALPHA');
    expect(indexOf(repo)).not.toContain('CHARLIE');
    expect(worktreeOf(repo)).toContain('ALPHA');
    expect(worktreeOf(repo)).toContain('CHARLIE');

    // 남은 조각은 둘이다 — 화면이 새 관측을 다시 받는다.
    await expect(hunks(page).locator('.git-hunk')).toHaveCount(2);
  });

  // G2 (V205): staged 행의 조각은 index↔HEAD 축이고, 붙는 동작은 unstage 뿐이다.
  test('G2 (V205): hunk 하나만 unstage 되고 나머지 staged 는 남는다', async ({ page }) => {
    const repo = hunkRepo('g2');
    hunkFile(repo, 'f.txt', { 5: 'ALPHA', 25: 'CHARLIE' });
    git(repo, 'add', 'f.txt');
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'staged', 'f.txt');

    await expect(hunks(page).locator('.git-hunk')).toHaveCount(2);
    // 방향은 축이 정한다 — staged 축에 stage·revert 는 붙지 않는다 (FR-GIT-278).
    await expect(act(page, 0, 'stage')).toHaveCount(0);
    await expect(act(page, 0, 'revert')).toHaveCount(0);
    await act(page, 0, 'unstage').click();

    await expect
      .poll(() => indexOf(repo), { timeout: 10000 })
      .not.toContain('ALPHA');
    expect(indexOf(repo)).toContain('CHARLIE');
    // unstage 는 워킹 트리를 건드리지 않는다.
    expect(worktreeOf(repo)).toContain('ALPHA');
  });

  // G3 (V205): 관측이 그 사이 바뀌었으면 거부된다 — 낡은 번호로 다른 곳을 고치지
  // 않는다. 화면 뒤에서 파일을 바꿔 그 상황을 만든다.
  test('G3 (V205): 관측이 바뀌었으면 거부되고 아무것도 스테이지되지 않는다', async ({ page }) => {
    const repo = hunkRepo('g3');
    hunkFile(repo, 'f.txt', { 5: 'ALPHA', 25: 'CHARLIE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');
    await expect(hunks(page).locator('.git-hunk')).toHaveCount(2);

    // 사용자가 조각을 보던 사이에 파일이 바뀌었다 — 같은 번호가 다른 곳을 가리킨다.
    hunkFile(repo, 'f.txt', { 5: 'ALPHA', 15: 'BRAVO', 25: 'CHARLIE' });
    await act(page, 1, 'stage').click();

    // 사유가 화면에 남고, index 는 그대로다.
    // 거부 사유는 **누른 자리**에 남는다 — Changes 탭의 안내 줄은 Diff 탭에서 보이지
    // 않는다 (FR-GIT-278).
    await expect(hunks(page).locator('.git-hunk-note.fail')).toContainText('다시 받아', {
      timeout: 10000,
    });
    for (const t of ['ALPHA', 'BRAVO', 'CHARLIE']) {
      expect(indexOf(repo)).not.toContain(t);
    }
  });

  // G4 (V206): 줄 범위를 고르면 그 범위에만 적용된다. 고르지 않은 변경은 index 에
  // 들어가지 않고 원래 내용 그대로 남는다.
  test('G4 (V206): 줄 범위 stage 가 그 범위에만 적용된다', async ({ page }) => {
    const repo = hunkRepo('g4');
    // 한 줄 건너 두 곳을 고친다 — 한 조각 안에 변경 짝이 둘이다.
    hunkFile(repo, 'f.txt', { 10: 'TEN', 12: 'TWELVE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');
    await expect(hunks(page).locator('.git-hunk')).toHaveCount(1);

    const from = await hunkLineIndex(page, 0, '-line10');
    const to = await hunkLineIndex(page, 0, '+TEN');
    await line(page, 0, from).click();
    await line(page, 0, to).click({ modifiers: ['Shift'] });
    // 범위를 잡으면 라벨이 바뀐다 — 무엇에 걸리는 동작인지 누르기 전에 보인다.
    await expect(act(page, 0, 'stage')).toHaveText('Stage lines');
    await expect(hunk(page, 0).locator('.git-hunk-line.sel')).toHaveCount(to - from + 1);

    await act(page, 0, 'stage').click();

    await expect.poll(() => indexOf(repo), { timeout: 10000 }).toContain('TEN');
    expect(indexOf(repo)).not.toContain('TWELVE');
    expect(indexOf(repo)).toContain('line12');
    // 워킹 트리는 그대로다.
    expect(worktreeOf(repo)).toContain('TEN');
    expect(worktreeOf(repo)).toContain('TWELVE');
  });

  // G5 (V206): 줄 범위 unstage 도 그 범위에만 걸린다.
  test('G5 (V206): 줄 범위 unstage 가 그 범위에만 적용된다', async ({ page }) => {
    const repo = hunkRepo('g5');
    hunkFile(repo, 'f.txt', { 10: 'TEN', 12: 'TWELVE' });
    git(repo, 'add', 'f.txt');
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'staged', 'f.txt');

    const from = await hunkLineIndex(page, 0, '-line10');
    const to = await hunkLineIndex(page, 0, '+TEN');
    await line(page, 0, from).click();
    await line(page, 0, to).click({ modifiers: ['Shift'] });
    await expect(act(page, 0, 'unstage')).toHaveText('Unstage lines');
    await act(page, 0, 'unstage').click();

    await expect.poll(() => indexOf(repo), { timeout: 10000 }).toContain('line10');
    expect(indexOf(repo)).not.toContain('TEN');
    // 고르지 않은 변경은 여전히 staged 다.
    expect(indexOf(repo)).toContain('TWELVE');
  });

  // G6 (V206): revert 는 **파괴적이다** — 2단계 확인을 거치고 recovery hint 를
  // 보인다. 확인을 끝까지 진행해야 워킹 트리가 바뀐다.
  test('G6 (V206): 줄 범위 revert 는 2단계 확인을 거친다', async ({ page }) => {
    const repo = hunkRepo('g6');
    hunkFile(repo, 'f.txt', { 10: 'TEN', 12: 'TWELVE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');

    const from = await hunkLineIndex(page, 0, '-line10');
    const to = await hunkLineIndex(page, 0, '+TEN');
    await line(page, 0, from).click();
    await line(page, 0, to).click({ modifiers: ['Shift'] });
    await expect(act(page, 0, 'revert')).toHaveText('Revert lines');
    await act(page, 0, 'revert').click();

    // 1단계는 영향 범위, 2단계는 recovery hint 다 (FR-GIT-91·92).
    await expect(confirmBox(page)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#git-confirm .gc-targets')).toContainText('f.txt');
    await confirmGo(page).click();
    await expect(confirmBox(page)).toHaveAttribute('data-stage', '2');
    // hint 는 되살릴 수 있는 명령이다 — 안내문만 남기지 않는다 (FR-GIT-92).
    await expect(page.locator('#git-confirm .gc-hint')).toContainText('git stash push');
    await confirmGo(page).click();

    await expect(page.locator('#git-confirm')).toHaveCount(0, { timeout: 10000 });
    await expect.poll(() => worktreeOf(repo), { timeout: 10000 }).toContain('line10');
    expect(worktreeOf(repo)).not.toContain('TEN');
    // 고르지 않은 범위는 그대로 남는다.
    expect(worktreeOf(repo)).toContain('TWELVE');
  });

  // G7 (V206): 취소하면 아무 일도 없다. 기본 선택지는 언제나 안전한 쪽이다
  // (FR-GIT-97).
  test('G7 (V206): revert 를 취소하면 워킹 트리가 그대로다', async ({ page }) => {
    const repo = hunkRepo('g7');
    hunkFile(repo, 'f.txt', { 10: 'TEN' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');

    await act(page, 0, 'revert').click();
    await expect(confirmBox(page)).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(worktreeOf(repo)).toContain('TEN');
  });

  // G8 (V204·V206): 줄 선택은 한 조각 안에서만 잡힌다 — 조각을 넘는 범위는 패치가
  // 되지 않으므로 다른 조각을 누르면 선택이 그쪽으로 옮겨간다.
  test('G8 (V206): 줄 선택이 조각을 넘지 않는다', async ({ page }) => {
    const repo = hunkRepo('g8');
    hunkFile(repo, 'f.txt', { 5: 'ALPHA', 25: 'CHARLIE' });
    await waitForInit(page);
    await openGit(page, repo);
    await openDiff(page, 'changes', 'f.txt');
    await expect(hunks(page).locator('.git-hunk')).toHaveCount(2);

    await line(page, 0, 1).click();
    await expect(hunk(page, 0).locator('.git-hunk-line.sel')).toHaveCount(1);
    // 다른 조각을 Shift 로 눌러도 앞 조각의 선택은 끌려오지 않는다.
    await line(page, 1, 2).click({ modifiers: ['Shift'] });
    await expect(hunk(page, 0).locator('.git-hunk-line.sel')).toHaveCount(0);
    await expect(hunk(page, 1).locator('.git-hunk-line.sel')).toHaveCount(1);
    // 같은 줄을 다시 누르면 놓는다 — 잘못 고른 선택에 갇히지 않는다.
    await line(page, 1, 2).click();
    await expect(hunks(page).locator('.git-hunk-line.sel')).toHaveCount(0);
    await expect(act(page, 1, 'stage')).toHaveText('Stage hunk');
  });
});
