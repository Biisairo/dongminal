import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, openGit as fxOpenGit, gitFixture, cleanGitFixture, rmTree, clickRowAct } from './fixtures';
import { TMP, tmpPath, realPath, cssPath } from './osenv';

// WORKBENCH_REVIEW_SRS 묶음 F — git Changes 의 폴더 단위 스테이징
// (FR-WBR-80~84, 검증 V-WBR-80~84).
//
// UX_BATCH5_SRS 묶음 A 가 여기를 넓힌다 (FR-DBA-1~6): 폴더 행이 폐기를 갖고,
// 파일 행과 **열이 맞는다**. F1 은 그래서 뒤집혔다 — 아래 그 자리에 적는다.
//
// 폭 시험(V-WBR-85 / NFR-WBR-11)은 여기 없다 — 규칙이 사는 `repo-tab` 묶음 N 의
// N4 다.

const FIXTURES = tmpPath('dm-git-fx-folderstage-' + process.pid);
let BASE = '';
let TREE = '';

const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);
const git = (d: string, ...a: string[]) =>
  execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

/**
 * 같은 이름 폴더(`src`)가 **두 그룹**에 서는 저장소. 트리가 그룹마다 따로
 * 서므로(FR-WBR-82) 그 둘은 다른 행이며 서로를 건드리지 않아야 한다.
 *
 *   staged    : lib/x.txt
 *   changes   : src/a.txt · src/b.txt
 *   untracked : src/n1.txt · src/n2.txt
 */
function mkTree(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'src'), { recursive: true });
  fs.mkdirSync(j(d, 'lib'));
  w(j(d, 'src', 'a.txt'), 'A\n');
  w(j(d, 'src', 'b.txt'), 'B\n');
  w(j(d, 'lib', 'x.txt'), 'X\n');
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');

  fs.appendFileSync(j(d, 'src', 'a.txt'), 'a2\n');
  fs.appendFileSync(j(d, 'src', 'b.txt'), 'b2\n');
  w(j(d, 'src', 'n1.txt'), 'N1\n');
  w(j(d, 'src', 'n2.txt'), 'N2\n');
  fs.appendFileSync(j(d, 'lib', 'x.txt'), 'x2\n');
  git(d, 'add', 'lib/x.txt');
  return realPath(d);
}

/**
 * FR-DBA-1: 충돌 파일이 **폴더 안**에 있는 저장소. 루트에 두면 폴더 행이 서지
 * 않아 "conflicts 폴더 행에는 동작이 없다" 를 시험할 대상 자체가 없다.
 */
function mkConflictTree(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'deep'), { recursive: true });
  w(j(d, 'deep', 'c.txt'), 'base\n');
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'base');
  git(d, 'checkout', '-q', '-b', 'side');
  w(j(d, 'deep', 'c.txt'), 'side\n');
  git(d, 'commit', '-qam', 'side');
  git(d, 'checkout', '-q', 'main');
  w(j(d, 'deep', 'c.txt'), 'main\n');
  git(d, 'commit', '-qam', 'main');
  // 충돌로 실패하는 것이 목적이다 — 성공하면 이 픽스처가 뜻을 잃는다.
  try {
    git(d, 'merge', 'side', '-q');
  } catch {
    /* 기대한 실패 */
  }
  return realPath(d);
}

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-gfs-')));
  TREE = mkTree('tree');
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
  rmTree(BASE);
});

const copyFx = makeCopyFx(FIXTURES);
const copyTree = (tag: string) => mkTree(tag);

async function openGit(page: Page, repo: string) {
  await fxOpenGit(page, repo);
}

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const group = (page: Page, key: string) => changes(page).locator(`.git-group[data-group="${key}"]`);
const count = (page: Page, key: string) => group(page, key).locator('.git-group-count');
const dir = (page: Page, key: string, p: string) =>
  group(page, key).locator(`.git-dir[data-dir="${cssPath(p)}"]`);
const row = (page: Page, key: string, p: string) =>
  group(page, key).locator(`.git-file[data-path="${cssPath(p)}"]`);
// 파괴적 확인은 한 자리를 지난다 (CONFIRM_ONE_STAGE_SRS) — 폴더 폐기도 같은 창이다.
const box = (page: Page) => page.locator('#git-confirm .gc-box');

async function setView(page: Page, mode: 'tree' | 'flat') {
  await changes(page).locator(`.git-files-mode[data-mode="${mode}"]`).click();
}

// 폴더 행의 동작도 hover 에서 드러난다 — 파일 행과 같은 클래스이므로 규약이 같다.
async function dirAct(page: Page, key: string, p: string, act: string) {
  const d = dir(page, key, p);
  await expect(d).toBeVisible({ timeout: 10000 });
  await clickRowAct(page, d, act);
}

test.describe('묶음 F — 폴더 단위 스테이징', () => {
  /**
   * F1 (개정 — UX_BATCH5_SRS FR-DBA-1·2)
   *
   *   이전 동작: 폴더 행은 `stage`/`unstage` 하나만 가졌다 (FR-WBR-84)
   *   새  동작: 그 그룹의 **쓰기 동작 전부**를 갖는다 — 폐기가 붙는다
   *   이유:     접수한 말이 "디스카드, 리버트도 하면 좋겠어" 다. FR-WBR-84 가
   *             폐기를 뺀 근거는 "그때 접수한 말이 staging/unstaging 이었다" 이지
   *             폐기가 위험해서가 아니었다 — 그 근거가 이번 요청으로 사라졌다
   *
   * 목록은 파일 행에서 `openFile` 만 뺀 것이다 (FR-DBA-2) — 폴더는 편집기로 여는
   * 대상이 아니다. 그래서 `data-act` 로 단정한다: 아이콘은 뜻의 출처가 아니다.
   */
  test('F1 (V-DBA-1 / FR-DBA-1·2): 폴더 행이 그 그룹의 쓰기 동작 전부를 갖는다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, copyTree('f1'));
      await setView(page, 'tree');
      // PANEL_SURFACE_SRS FR-CMG-9: `src` 는 이제 **한 폴더 행**이고 그 아래에
      // 수정 둘과 새 파일 둘이 함께 있다.
      await expect(count(page, 'working')).toHaveText('(4)', { timeout: 10000 });

      const acts = (key: string, p: string) =>
        dir(page, key, p).locator('.git-file-act').evaluateAll(
          (els) => els.map((e) => (e as HTMLElement).dataset.act));

      expect(await acts('working', 'src')).toEqual(['stage', 'discard']);
      expect(await acts('staged', 'lib')).toEqual(['unstage']);

      // FR-DBA-2: `openFile` 은 폴더의 동작이 아니다 — 버튼으로 서지 않는다.
      await expect(
        dir(page, 'working', 'src').locator('.git-file-act[data-act="openFile"]')).toHaveCount(0);
    });

  /**
   * FR-DBA-3: 같은 동작이 파일 행과 폴더 행에서 **같은 가로 위치**에 선다.
   *
   * 동작 묶음은 오른쪽 정렬이므로 개수가 다르면 같은 아이콘이 다른 열에 섰다 —
   * 접수한 말의 뒷문장("행과 열을 맞춰줘")이 그것이다. 자리지킴이 그 자리를 메운다.
   */
  test('F1b (V-DBA-3 / FR-DBA-3): 폴더 행과 파일 행의 같은 동작이 같은 열에 선다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, copyTree('f1b'));
      await setView(page, 'tree');
      await expect(row(page, 'working', 'src/a.txt')).toBeVisible({ timeout: 10000 });

      const leftOf = (loc: ReturnType<typeof dir>, act: string) =>
        loc.locator(`.git-file-act[data-act="${act}"]`).evaluate(
          (e) => Math.round(e.getBoundingClientRect().left));

      for (const [key, dirPath, filePath, list] of [
        ['working', 'src', 'src/a.txt', ['stage', 'discard']],
        ['working', 'src', 'src/n1.txt', ['stage', 'discard']],
        ['staged', 'lib', 'lib/x.txt', ['unstage']],
      ] as const) {
        for (const act of list) {
          const d = await leftOf(dir(page, key, dirPath), act);
          const f = await leftOf(row(page, key, filePath), act);
          expect(d, `${key}/${act} 의 열이 어긋난다 (폴더 ${d} · 파일 ${f})`).toBe(f);
        }
      }
    });

  /**
   * FR-DBA-1: conflicts 는 예외다. 폴더 단위로 뜻이 서지 않는 동작(`ours`·`theirs`)
   * 뿐이고, 그룹 일괄이 없는 것과 같은 근거다 (FR-GIT-72) — 충돌 stage 는 "해결됨
   * 표시" 라 한 번에 밀어 넣을 동작이 아니다.
   *
   * 자리지킴도 서지 않는다: 정렬할 버튼이 하나도 없으면 맞출 열도 없다.
   */
  test('F1c (V-DBA-2 / FR-DBA-1): conflicts 폴더 행에는 동작도 자리지킴도 없다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, mkConflictTree('f1c'));
      await setView(page, 'tree');
      await expect(count(page, 'conflicts')).toHaveText('(1)', { timeout: 10000 });

      const d = dir(page, 'conflicts', 'deep');
      await expect(d).toBeVisible();
      await expect(d.locator('.git-file-act')).toHaveCount(0);
      await expect(d.locator('.git-act-gap')).toHaveCount(0);
    });

  test('F2 (V-WBR-81 / FR-WBR-81): 접힌 폴더를 스테이지해도 그 아래 전부가 간다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, copyTree('f2'));
      await setView(page, 'tree');
      await expect(row(page, 'working', 'src/a.txt')).toBeVisible({ timeout: 10000 });

      // 접는다 — 그려진 행이 하나도 없게 만든다.
      await dir(page, 'working', 'src').click();
      await expect(row(page, 'working', 'src/a.txt')).toHaveCount(0);

      await dirAct(page, 'working', 'src', 'stage');
      // 그려진 행이 아니라 그 폴더 아래 **전부**가 대상이다 — 두 출신 모두.
      await expect(count(page, 'working')).toHaveText('(0)', { timeout: 5000 });
      await expect(row(page, 'staged', 'src/a.txt')).toBeVisible();
      await expect(row(page, 'staged', 'src/b.txt')).toBeVisible();
      await expect(row(page, 'staged', 'src/n1.txt')).toBeVisible();
    });

  test('F3 (V-WBR-82 / FR-WBR-81): 목록이 잘려 있어도 대상은 폴더 아래 전부다',
    async ({ page }) => {
      // `many-files` 는 src/ 아래 2000개다 — 한 덩어리(200)를 훌쩍 넘는다.
      const repo = copyFx('many-files', 'f3');
      await waitForInit(page);
      await openGit(page, repo);
      await setView(page, 'tree');
      await expect(count(page, 'working')).toHaveText('(2000)', { timeout: 30000 });
      // 그려진 것은 한 덩어리뿐이다 (FR-GIT-42).
      const drawn = await group(page, 'working').locator('.git-file').count();
      expect(drawn, '목록이 잘리지 않아 이 시험이 뜻을 잃는다').toBeLessThan(2000);

      await dirAct(page, 'working', 'src', 'stage');
      await expect(count(page, 'working')).toHaveText('(0)', { timeout: 60000 });
      await expect(count(page, 'staged')).toHaveText('(2000)');
    });

  test('F4 (V-WBR-83 / FR-CMG-9·10): 한 폴더 행이 두 출신을 함께 담고, staged 트리는 따로 선다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, copyTree('f4'));
      await setView(page, 'tree');
      await expect(count(page, 'working')).toHaveText('(4)', { timeout: 10000 });
      await expect(count(page, 'staged')).toHaveText('(1)');

      // FR-CMG-3: 한 폴더 아래에 수정과 새 파일이 상태 문자로 갈려 함께 있다.
      await expect(row(page, 'working', 'src/a.txt').locator('.git-file-st')).toHaveText('M');
      await expect(row(page, 'working', 'src/n1.txt').locator('.git-file-st')).toHaveText('?');

      // FR-CMG-10: 접기는 워킹 그룹 **하나**를 단위로 한다.
      await dir(page, 'working', 'src').click();
      await expect(row(page, 'working', 'src/a.txt')).toHaveCount(0);
      await expect(row(page, 'working', 'src/n1.txt')).toHaveCount(0);
      await dir(page, 'working', 'src').click();

      // FR-WBR-82: 트리는 그룹마다 따로 선다 — staged 의 `lib` 은 건드리지 않는다.
      await dirAct(page, 'working', 'src', 'stage');
      await expect(count(page, 'working')).toHaveText('(0)', { timeout: 5000 });
      await expect(count(page, 'staged')).toHaveText('(5)');
    });

  /**
   * FR-DBA-4·5 (개정 — PANEL_SURFACE_SRS FR-CMG-9): 폴더 폐기.
   *
   *   이전 동작: `Changes` 의 `src` 와 `Untracked` 의 `src` 가 **다른 행**이었고,
   *              각자의 폐기가 서로를 건드리지 않는 것이 시험의 본체였다
   *   새  동작: `src` 는 한 행이고 그 아래에 두 출신이 있다. 폐기는 한 번이며
   *              확인창이 되돌릴 것과 지울 것을 나눠 보인다
   *   이유:     같은 워킹 트리의 파일이고 차이는 앞단의 기호다 (요구 ⑦)
   */
  test('F6 (V-DBA-4 / FR-CMG-9): 폴더 폐기가 두 무리를 나눠 보이고 둘 다 실행된다',
    async ({ page }) => {
      await waitForInit(page);
      const repo = copyTree('f6');
      await openGit(page, repo);
      await setView(page, 'tree');
      await expect(count(page, 'working')).toHaveText('(4)', { timeout: 10000 });

      await dirAct(page, 'working', 'src', 'discard');
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      // 그려진 행이 아니라 폴더 아래 전부다 (FR-DBA-5, `_bulk` 의 규약을 좁힌 것).
      await expect(box(page).locator('.gc-count')).toContainText('4개');
      // FR-CMG-9: 한 폴더 아래에 두 출신이 섞이면 확인창이 둘을 나눠 보인다.
      await expect(box(page).locator('.gc-target-sect')).toHaveText(['되돌릴 2개', '지울 2개']);
      await expect(box(page)).toContainText('삭제');
      await box(page).locator('.gc-go').click();
      await expect(box(page)).toHaveCount(0, { timeout: 10000 });

      await expect(count(page, 'working')).toHaveText('(0)', { timeout: 10000 });
      // 되돌림과 삭제가 둘 다 일어났다 (FR-CMG-8).
      expect(fs.readFileSync(j(repo, 'src', 'a.txt'), 'utf8')).toBe('A\n');
      expect(fs.readFileSync(j(repo, 'src', 'b.txt'), 'utf8')).toBe('B\n');
      expect(fs.existsSync(j(repo, 'src', 'n1.txt'))).toBeFalsy();
      expect(fs.existsSync(j(repo, 'src', 'n2.txt'))).toBeFalsy();
      // staged 분은 그대로다 — discard 는 index 를 건드리지 않는다.
      await expect(count(page, 'staged')).toHaveText('(1)');
    });

  test('F8 (V-DBA-6 / FR-DBA-4): 폐기 확인을 취소하면 아무것도 바뀌지 않는다',
    async ({ page }) => {
      await waitForInit(page);
      const repo = copyTree('f8');
      await openGit(page, repo);
      await setView(page, 'tree');
      await expect(count(page, 'working')).toHaveText('(4)', { timeout: 10000 });

      await dirAct(page, 'working', 'src', 'discard');
      await expect(box(page)).toBeVisible({ timeout: 10000 });
      await box(page).locator('.gc-cancel').click();
      await expect(box(page)).toHaveCount(0, { timeout: 10000 });

      await expect(count(page, 'working')).toHaveText('(4)');
      expect(fs.readFileSync(j(repo, 'src', 'a.txt'), 'utf8')).toBe('A\na2\n');
      expect(fs.existsSync(j(repo, 'src', 'n1.txt'))).toBeTruthy();
    });

  test('F5 (V-WBR-84 / FR-WBR-83): 플랫 보기에는 폴더 행도 폴더 동작도 없다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, copyTree('f5'));
      await setView(page, 'tree');
      await expect(dir(page, 'working', 'src')).toBeVisible({ timeout: 10000 });

      await setView(page, 'flat');
      // 플랫은 "경로를 펼쳐 다 보여준다" 가 뜻이다 — 폴더라는 단위가 없다.
      await expect(changes(page).locator('.git-dir')).toHaveCount(0);
      await expect(row(page, 'working', 'src/a.txt')).toBeVisible();
    });
});
