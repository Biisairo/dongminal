import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit } from './fixtures';

// WORKBENCH_REVIEW_SRS 묶음 F — git Changes 의 폴더 단위 스테이징
// (FR-WBR-80~84, 검증 V-WBR-80~84).
//
// 폭 시험(V-WBR-85 / NFR-WBR-11)은 여기 없다 — 규칙이 사는 `repo-tab` 묶음 N 의
// N4 다.

const FIXTURES = '/tmp/dm-git-fx-folderstage-' + process.pid;
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
  return fs.realpathSync(d);
}

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-gfs-')));
  TREE = mkTree('tree');
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

const copyFx = makeCopyFx(FIXTURES);
const copyTree = (tag: string) => mkTree(tag);

async function openGit(page: Page, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
  });
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const group = (page: Page, key: string) => changes(page).locator(`.git-group[data-group="${key}"]`);
const count = (page: Page, key: string) => group(page, key).locator('.git-group-count');
const dir = (page: Page, key: string, p: string) =>
  group(page, key).locator(`.git-dir[data-dir="${p}"]`);
const row = (page: Page, key: string, p: string) =>
  group(page, key).locator(`.git-file[data-path="${p}"]`);

async function setView(page: Page, mode: 'tree' | 'flat') {
  await changes(page).locator(`.git-files-mode[data-mode="${mode}"]`).click();
}

// 폴더 행의 동작도 hover 에서 드러난다 — 파일 행과 같은 클래스이므로 규약이 같다.
async function dirAct(page: Page, key: string, p: string, act: string) {
  const d = dir(page, key, p);
  await expect(d).toBeVisible({ timeout: 10000 });
  await d.hover();
  await d.locator(`.git-file-act[data-act="${act}"]`).click();
}

test.describe('묶음 F — 폴더 단위 스테이징', () => {
  test('F1 (V-WBR-80 / FR-WBR-80·84): 폴더 행이 그 그룹의 동작만 갖는다 — 폐기는 없다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, copyTree('f1'));
      await setView(page, 'tree');
      await expect(count(page, 'changes')).toHaveText('(2)', { timeout: 10000 });

      // 그룹이 할 수 있는 것만이다 (`GIT_ROW_ACTS` 와 같은 근거).
      await expect(dir(page, 'changes', 'src').locator('.git-file-act')).toHaveText(['+']);
      await expect(dir(page, 'untracked', 'src').locator('.git-file-act')).toHaveText(['+']);
      await expect(dir(page, 'staged', 'lib').locator('.git-file-act')).toHaveText(['−']);
      // FR-WBR-84: 접수한 말은 staging/unstaging 이다 — 폐기를 두지 않는다.
      await expect(
        dir(page, 'changes', 'src').locator('.git-file-act[data-act="discard"]')).toHaveCount(0);
    });

  test('F2 (V-WBR-81 / FR-WBR-81): 접힌 폴더를 스테이지해도 그 아래 전부가 간다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, copyTree('f2'));
      await setView(page, 'tree');
      await expect(row(page, 'changes', 'src/a.txt')).toBeVisible({ timeout: 10000 });

      // 접는다 — 그려진 행이 하나도 없게 만든다.
      await dir(page, 'changes', 'src').click();
      await expect(row(page, 'changes', 'src/a.txt')).toHaveCount(0);

      await dirAct(page, 'changes', 'src', 'stage');
      // 그려진 행이 아니라 그 폴더 아래 **전부**가 대상이다.
      await expect(count(page, 'changes')).toHaveText('(0)', { timeout: 5000 });
      await expect(row(page, 'staged', 'src/a.txt')).toBeVisible();
      await expect(row(page, 'staged', 'src/b.txt')).toBeVisible();
    });

  test('F3 (V-WBR-82 / FR-WBR-81): 목록이 잘려 있어도 대상은 폴더 아래 전부다',
    async ({ page }) => {
      // `many-files` 는 src/ 아래 2000개다 — 한 덩어리(200)를 훌쩍 넘는다.
      const repo = copyFx('many-files', 'f3');
      await waitForInit(page);
      await openGit(page, repo);
      await setView(page, 'tree');
      await expect(count(page, 'changes')).toHaveText('(2000)', { timeout: 30000 });
      // 그려진 것은 한 덩어리뿐이다 (FR-GIT-42).
      const drawn = await group(page, 'changes').locator('.git-file').count();
      expect(drawn, '목록이 잘리지 않아 이 시험이 뜻을 잃는다').toBeLessThan(2000);

      await dirAct(page, 'changes', 'src', 'stage');
      await expect(count(page, 'changes')).toHaveText('(0)', { timeout: 60000 });
      await expect(count(page, 'staged')).toHaveText('(2000)');
    });

  test('F4 (V-WBR-83 / FR-WBR-82): 같은 이름 폴더가 두 그룹에 있어도 서로를 건드리지 않는다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, copyTree('f4'));
      await setView(page, 'tree');
      await expect(count(page, 'changes')).toHaveText('(2)', { timeout: 10000 });
      await expect(count(page, 'untracked')).toHaveText('(2)');

      // untracked 쪽 `src` 만 스테이지한다.
      await dirAct(page, 'untracked', 'src', 'stage');
      await expect(count(page, 'untracked')).toHaveText('(0)', { timeout: 5000 });
      // changes 쪽 `src` 는 그대로다 — 트리가 그룹마다 따로 선다.
      await expect(count(page, 'changes')).toHaveText('(2)');
      await expect(row(page, 'changes', 'src/a.txt')).toBeVisible();
    });

  test('F5 (V-WBR-84 / FR-WBR-83): 플랫 보기에는 폴더 행도 폴더 동작도 없다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, copyTree('f5'));
      await setView(page, 'tree');
      await expect(dir(page, 'changes', 'src')).toBeVisible({ timeout: 10000 });

      await setView(page, 'flat');
      // 플랫은 "경로를 펼쳐 다 보여준다" 가 뜻이다 — 폴더라는 단위가 없다.
      await expect(changes(page).locator('.git-dir')).toHaveCount(0);
      await expect(row(page, 'changes', 'src/a.txt')).toBeVisible();
    });
});
