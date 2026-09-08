import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot, openExplorerSide } from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

// REPO_TAB_UNIFY_SRS §4 — 통합 창의 검증 V-RTU-10~35.
//
// 저장소 하나가 창 하나다. 좌측 사이드는 `Explorer` 와 `Changes` 를 갈아 끼우고,
// diff·history 는 **오른쪽에 편집기 탭과 같은 자격으로** 뜬다.

let BASE = '';
let REPO = '';
let CONFLICT = '';

const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);
const git = (d: string, ...a: string[]) =>
  execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

function makeRepo(base: string) {
  const d = j(base, 'repo');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(j(d, 'src'));
  w(j(d, 'src', 'a.ts'), 'export const a = 1\n');
  w(j(d, 'README.md'), '# fixture\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  // 변경 하나 — Changes 사이드가 보일 것이 있어야 한다.
  fs.appendFileSync(j(d, 'src', 'a.ts'), 'export const b = 2\n');
  return realPath(d);
}

// 묶음 N — `conflicts` 그룹은 행 버튼이 **넷**(`↗`·`Ours`·`Theirs`·`+`)이라
// 기본 220px 에서도 이름 60px 을 남기지 못한다. 그 폭이 규칙의 시험대다.
function makeConflict(base: string) {
  const d = j(base, 'conflict');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  w(j(d, 'c.txt'), 'base\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'base');
  git(d, 'checkout', '-q', '-b', 'other');
  w(j(d, 'c.txt'), 'other\n');
  git(d, 'commit', '-qam', 'other');
  git(d, 'checkout', '-q', 'main');
  w(j(d, 'c.txt'), 'main\n');
  git(d, 'commit', '-qam', 'main');
  // 충돌이므로 실패로 끝난다 — 그것이 이 픽스처의 목적이다.
  try { git(d, 'merge', 'other') } catch { /* 충돌 */ }
  return realPath(d);
}

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-rtu-')));
  REPO = makeRepo(BASE);
  CONFLICT = makeConflict(BASE);
});
test.afterAll(() => {
  rmTree(BASE);
});

async function addEditor(request: APIRequestContext, p: string) {
  const r = await request.post('/api/editors/add', { data: { path: p } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
}

async function goto(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
}

async function openRepo(page: Page, root: string) {
  await switchToEditorRoot(page, root);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
}

async function enter(page: Page, request: APIRequestContext, root: string) {
  await addEditor(request, root);
  await goto(page);
  await openRepo(page, root);
}

// constants.js 의 전역 상수 — `<script>` 로 로드되므로 import 대상이 아니다.
declare const gitStatusInterval: number;

const side = (page: Page) => page.locator('#area .ed-win .ed-side');
const sideTab = (page: Page, id: string) => side(page).locator(`.ed-side-tab[data-side="${id}"]`);
const mainTabs = (page: Page) => page.locator('#area .ed-area .pn-tab');

test.describe('묶음 W — 사이드는 Explorer 와 Changes 를 갈아 끼운다', () => {
  /**
   * W1 — **개정** (UX_BATCH6_SRS FR-DSP-1).
   *
   *   이전 계약: 기본은 Explorer
   *   새   계약: 기본은 **Changes**
   *   이유:      탭 순서를 Changes 로 옮긴 근거(FR-GCC-13)가 기본값에도 그대로
   *              적용된다 — Repo 창을 여는 이유가 대개 변경을 보는 것이다.
   *              두 물음을 갈라 둔 동안 첫 화면과 탭 순서가 서로 다른 말을 했다
   *
   * 탭이 둘이라는 것과 **한 번에 하나만 보인다**(FR-RTU-12)는 그대로다.
   */
  test('W1 (V-RTU-10·11 / V-DSP-1): 사이드에 탭 둘이 서고 기본은 Changes 다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await expect(sideTab(page, 'explorer')).toHaveText('Explorer');
      await expect(sideTab(page, 'changes')).toHaveText('Changes');
      await expect(sideTab(page, 'changes')).toHaveClass(/active/);
      // 한 번에 하나만 보인다 (FR-RTU-12).
      await expect(side(page).locator('.git-view.git-changes')).toHaveCount(1);
      await expect(side(page).locator('.ed-explorer')).toHaveCount(0);
    });

  test('W2 (V-RTU-11): Changes 로 바꾸면 변경 목록이 사이드에 뜬다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await sideTab(page, 'changes').click();
      await expect(side(page).locator('.git-view.git-changes')).toBeVisible({ timeout: 10000 });
      // 탐색기는 물러난다 — 세로로 쌓지 않는 것이 이 설계의 요점이다 (D-RTU-3).
      await expect(side(page).locator('.ed-explorer')).toHaveCount(0);
      // 관측이 닿으면 그 저장소의 변경이 보인다.
      await expect(side(page).locator('.git-file[data-path="src/a.ts"]'))
        .toBeVisible({ timeout: 10000 });
    });

  test('W3 (V-RTU-12): 사이드 탭이 창마다 저장되고 새로고침을 넘는다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await sideTab(page, 'changes').click();
      await expect(sideTab(page, 'changes')).toHaveClass(/active/);
      // 워크스페이스에 적힌다 — 폭과 같은 규약이다 (FR-RTU-13).
      expect(await page.evaluate(() => (window as any).app._aw().editor.side)).toBe('changes');

      await page.evaluate(() => (window as any).app._save());
      await page.reload();
      await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
      await expect(sideTab(page, 'changes')).toHaveClass(/active/);
    });

  test('W4 (V-RTU-23): 진입점 아이콘 줄은 Changes 탭에서만 보인다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      // 기본이 Changes 이므로(UX_BATCH6_SRS FR-DSP-1) **Explorer 로 가서** 없음을
      // 먼저 확인한다 — 재려는 것은 "Changes 탭에서만" 이라는 배타성이다.
      await sideTab(page, 'explorer').click();
      await expect(side(page).locator('.ed-side-acts')).toHaveCount(0);
      await sideTab(page, 'changes').click();
      await expect(side(page).locator('.ed-side-acts')).toBeVisible();
      // Changes 는 여기 없다 — 그것은 사이드 자신이다 (FR-RTU-32).
      await expect(side(page).locator('.ed-side-act[data-view="changes"]')).toHaveCount(0);
      // UX_BATCH5_SRS FR-SUB-6 으로 Submodules 가 더해져 일곱이 됐다가, Diff 가
      // 빠져 **여섯이 됐다** (FR-RTU-21 개정). 숫자는 `GIT_SIDE_ACTIONS` 의
      // 길이이며, e2e 는 그것을 독립적으로 적는다.
      //
      // `[data-view]` 로 세는 이유가 있다: 같은 줄의 오른쪽 끝에 **새로고침**이
      // 함께 서지만(GIT_CHANGES_CONTROLS_SRS FR-GCC-10) 그것은 진입점이 아니다.
      await expect(side(page).locator('.ed-side-act[data-view]')).toHaveCount(6);
      // Diff 는 이 줄에 없다 — 파일을 누르면 열린다 (FR-RTU-21 개정).
      await expect(side(page).locator('.ed-side-act[data-view="diff"]')).toHaveCount(0);
      // FR-GCC-10: 새로고침은 창의 최상단(탭 줄 오른쪽 끝)이다 — 브랜치 줄에는 없다.
      await expect(side(page).locator('.ed-side-tabs .git-head-refresh')).toHaveCount(1);
      await expect(side(page).locator('.git-head .git-head-refresh')).toHaveCount(0);
      // FR-GCC-13: 사이드 탭의 첫 번째는 Changes 다.
      await expect(side(page).locator('.ed-side-tab').first()).toHaveAttribute('data-side', 'changes');
    });
});

test.describe('묶음 V — git 뷰는 본문 탭이 된다', () => {
  test('V1 (V-RTU-22): 진입점이 본문에 그 뷰의 탭을 연다', async ({ page, request }) => {
    await enter(page, request, REPO);
    await sideTab(page, 'changes').click();
    await side(page).locator('.ed-side-act[data-view="history"]').click();

    const tab = mainTabs(page).filter({ hasText: 'History' });
    await expect(tab).toHaveCount(1, { timeout: 10000 });
    // 편집기 탭과 같은 자격이다 — 같은 탭 바에 선다 (FR-RTU-33).
    await expect(tab).toHaveAttribute('data-git-view', 'history');
  });

  test('V2 (V-RTU-22·31): 두 번 눌러도 탭이 하나다', async ({ page, request }) => {
    await enter(page, request, REPO);
    await sideTab(page, 'changes').click();
    const act = side(page).locator('.ed-side-act[data-view="branches"]');
    await act.click();
    await expect(mainTabs(page).filter({ hasText: 'Branches' })).toHaveCount(1, { timeout: 10000 });
    await act.click();
    await expect(mainTabs(page).filter({ hasText: 'Branches' })).toHaveCount(1);
  });

  test('V3 (V-RTU-14): 본문에 터미널 탭은 여전히 만들 수 없다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      const before = await mainTabs(page).count();
      await page.evaluate(() => {
        const a = (window as any).app;
        const w = a._aw();
        a.addTab(a._edEnsurePane(w), 'terminal', { windowId: w.id });
      });
      await page.waitForTimeout(300);
      expect(await mainTabs(page).count()).toBe(before);
    });

  test('V4 (V-RTU-31): 저장소가 다르면 History 탭도 따로 선다',
    async ({ page, request }) => {
      const other = makeRepo(fs.mkdtempSync(j(BASE, 'other-')));
      await addEditor(request, REPO);
      await addEditor(request, other);
      await goto(page);

      await openRepo(page, REPO);
      await sideTab(page, 'changes').click();
      await side(page).locator('.ed-side-act[data-view="history"]').click();
      await expect(mainTabs(page).filter({ hasText: 'History' })).toHaveCount(1, { timeout: 10000 });

      // 다른 저장소의 창으로 간다 — 그쪽에는 아직 History 가 없다.
      await openRepo(page, other);
      await expect(mainTabs(page).filter({ hasText: 'History' })).toHaveCount(0);
      await sideTab(page, 'changes').click();
      await side(page).locator('.ed-side-act[data-view="history"]').click();
      await expect(mainTabs(page).filter({ hasText: 'History' })).toHaveCount(1, { timeout: 10000 });
    });
});

// ── 묶음 C — 저장소가 아닌 자리 (FR-RTU-20·25~28) ────

test.describe('묶음 C — Changes 사이드', () => {
  test('C1 (V-RTU-20): 커밋 입력이 브랜치 줄보다 위다', async ({ page, request }) => {
    await enter(page, request, REPO);
    await sideTab(page, 'changes').click();
    await expect(side(page).locator('.git-commit')).toBeVisible({ timeout: 10000 });
    // 세로 순서는 DOM 순서다 — 커밋이 머리(브랜치 줄)보다 앞에 온다 (D-RTU-4).
    const order = await page.evaluate(() => {
      const v = document.querySelector('#area .ed-side .git-view.git-changes')!;
      return [...v.children].map((e) => e.className.split(' ')[0]);
    });
    expect(order.indexOf('git-commit')).toBeLessThan(order.indexOf('git-head'));
  });

  test('C2 (V-RTU-24·25): 저장소가 아니면 사유와 git init 버튼이 나온다',
    async ({ page, request }) => {
      const plain = realPath(fs.mkdtempSync(j(BASE, 'plain-')));
      w(j(plain, 'note.md'), 'x\n');
      await enter(page, request, plain);
      await sideTab(page, 'changes').click();

      const box = side(page).locator('.git-init');
      await expect(box).toBeVisible({ timeout: 10000 });
      await expect(box.locator('.git-init-msg')).toContainText('git 저장소가 아닙니다');
      // 어느 폴더인지 화면이 밝힌다 — 모른 채 누르는 일이 없어야 한다.
      await expect(box.locator('.git-init-path')).toHaveText(plain);
      await expect(box.locator('.git-init-btn')).toHaveText('git init');
    });

  test('C3 (V-RTU-26): git init 이 확인을 거쳐 저장소를 만들고 곧바로 반영된다',
    async ({ page, request }) => {
      const fresh = realPath(fs.mkdtempSync(j(BASE, 'fresh-')));
      w(j(fresh, 'a.txt'), 'x\n');
      await enter(page, request, fresh);
      await sideTab(page, 'changes').click();
      await side(page).locator('.git-init-btn').click();

      // FR-RTU-26: 확인창이 대상 경로를 밝힌다. 확인은 GitConfirm 한 자리를
      // 지나므로(CONFIRM_ONE_STAGE_SRS) 그 골격(`#git-confirm`)을 딛는다.
      const confirm = page.locator('#git-confirm');
      await expect(confirm).toBeVisible({ timeout: 10000 });
      await expect(confirm.locator('.gc-target')).toHaveText(fresh);
      await confirm.locator('.gc-go').click();

      // FR-RTU-28: 서버가 캐시를 지웠으므로 **곧바로** 목록이 선다 — 2초를
      // 기다리지 않는다. 새 파일은 미추적으로 뜬다.
      await expect(side(page).locator('.git-file[data-path="a.txt"]'))
        .toBeVisible({ timeout: 10000 });
      await expect(side(page).locator('.git-init')).toHaveCount(0);

      // FR-RTU-27: 핀에도 더해졌다.
      const state = await (await request.get('/api/state')).json();
      expect(state?.workspace?.git?.pinned || []).toContain(fresh);
    });
});

// ── 묶음 P — 미리보기 탭 (FR-RTU-40~45) ─────────────

test.describe('묶음 P — 미리보기 탭', () => {
  test('P1 (V-RTU-40·41): 한 번 클릭은 탭 하나를 재사용하고 기울임으로 보인다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await openExplorerSide(page);
      const tree = page.locator('#area .ed-side .ed-tree');
      await expect(tree.locator('.ed-row').first()).toBeVisible({ timeout: 10000 });

      await tree.locator(`.ed-row[data-path="${cssPath(j(REPO, 'README.md'))}"]`).click();
      await expect(mainTabs(page)).toHaveCount(1, { timeout: 10000 });
      await expect(mainTabs(page).first()).toHaveClass(/pn-tab-preview/);

      // 다른 파일을 누르면 **같은 탭이 대상을 갈아탄다** — 탭이 쌓이지 않는다.
      await tree.locator(`.ed-row[data-path="${cssPath(j(REPO, 'src'))}"]`).click();
      await tree.locator(`.ed-row[data-path="${cssPath(j(REPO, 'src', 'a.ts'))}"]`).click();
      await expect(mainTabs(page)).toHaveCount(1);
      await expect(mainTabs(page).first()).toContainText('a.ts');
    });

  test('P2 (V-RTU-42·43): 더블클릭이 고정하고 다음 미리보기는 새 탭이 된다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await openExplorerSide(page);
      const tree = page.locator('#area .ed-side .ed-tree');
      await expect(tree.locator('.ed-row').first()).toBeVisible({ timeout: 10000 });

      await tree.locator(`.ed-row[data-path="${cssPath(j(REPO, 'README.md'))}"]`).click();
      await expect(mainTabs(page)).toHaveCount(1, { timeout: 10000 });
      await mainTabs(page).first().dblclick();
      await expect(mainTabs(page).first()).not.toHaveClass(/pn-tab-preview/);

      await tree.locator(`.ed-row[data-path="${cssPath(j(REPO, 'src'))}"]`).click();
      await tree.locator(`.ed-row[data-path="${cssPath(j(REPO, 'src', 'a.ts'))}"]`).click();
      // 고정된 탭은 남고 미리보기가 하나 더 선다 — 창에 미리보기는 하나뿐이다.
      await expect(mainTabs(page)).toHaveCount(2);
      await expect(mainTabs(page).locator('.pn-tab-preview')).toHaveCount(0);
      await expect(page.locator('#area .ed-area .pn-tab.pn-tab-preview')).toHaveCount(1);
    });

  test('P3 (V-RTU-44): 미리보기 상태가 새로고침을 넘는다', async ({ page, request }) => {
    await enter(page, request, REPO);
    await openExplorerSide(page);
    const tree = page.locator('#area .ed-side .ed-tree');
    await expect(tree.locator('.ed-row').first()).toBeVisible({ timeout: 10000 });
    await tree.locator(`.ed-row[data-path="${cssPath(j(REPO, 'README.md'))}"]`).click();
    await expect(mainTabs(page).first()).toHaveClass(/pn-tab-preview/, { timeout: 10000 });

    await page.evaluate(() => (window as any).app._save());
    await page.reload();
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    // 저장하지 않으면 모든 탭이 고정으로 되살아나 사용자가 정리해야 한다.
    await expect(page.locator('#area .ed-area .pn-tab.pn-tab-preview')).toHaveCount(1);
  });
});

test.describe('묶음 V — git 뷰 탭의 자격 (FR-RTU-33·34)', () => {
  const viewTab = (page: Page, v: string) =>
    page.locator(`#area .ed-area .pn-tab[data-git-view="${v}"]`);

  // 여섯 진입점 중 둘을 연다 — 하나로는 "닫아도 남는 탭" 을 구별할 수 없다.
  async function openTwoViews(page: Page) {
    await sideTab(page, 'changes').click();
    await side(page).locator('.ed-side-act[data-view="history"]').click();
    await side(page).locator('.ed-side-act[data-view="branches"]').click();
    await expect(viewTab(page, 'history')).toHaveCount(1, { timeout: 10000 });
    await expect(viewTab(page, 'branches')).toHaveCount(1);
  }

  test('X1 (V-RTU-31 / FR-RTU-33): git 뷰 탭에 닫기가 서고 끌 수 있다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await openTwoViews(page);
      // 편집기 탭과 **같은 자격**이다 — `×` 가 있고 draggable 이다.
      await expect(viewTab(page, 'history').locator('.pn-tab-x')).toHaveCount(1);
      expect(await viewTab(page, 'history').evaluate((t) => (t as HTMLElement).draggable))
        .toBe(true);
    });

  test('X2 (V-RTU-31·34 / FR-RTU-34): 닫으면 사라지고 다시 열면 새로 선다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await openTwoViews(page);
      await viewTab(page, 'history').locator('.pn-tab-x').click();
      await expect(viewTab(page, 'history')).toHaveCount(0, { timeout: 10000 });
      // 다른 뷰 탭은 그대로다 — 닫은 것만 사라진다.
      await expect(viewTab(page, 'branches')).toHaveCount(1);

      // FR-RTU-34: 다시 열면 새로 만들어진다.
      await side(page).locator('.ed-side-act[data-view="history"]').click();
      await expect(viewTab(page, 'history')).toHaveCount(1, { timeout: 10000 });
    });

  test('X3 (V-RTU-31 / FR-RTU-17): git 뷰 탭은 창 밖으로 나가지 않는다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await openTwoViews(page);
      const moved = await page.evaluate(() => {
        const a = (window as any).app;
        const plain = a._plainWindows()[0];
        const pane = a._flattenPanes(a._aw().layout)[0];
        const tab = (pane.tabs || []).find((t: any) => t.type === 'git');
        const before = ((a._flattenPanes(plain.layout)[0] || {}).tabs || []).length;
        a._moveTabToWindow(pane.id, tab.id, plain.id);
        return { before, after: ((a._flattenPanes(plain.layout)[0] || {}).tabs || []).length };
      });
      expect(moved.after, 'git 뷰 탭이 다른 창으로 나갔다').toBe(moved.before);
    });

  /**
   * NFR-RTU-3: Monaco 인스턴스는 **열린 diff/편집기 탭 수 + 창당 미리보기 1** 을
   * 넘지 않는다. 뷰 DOM 을 탭이 있을 때만 만드는 것이 그 근거이므로, 닫으면
   * 인스턴스도 함께 놓아야 한다.
   */
  test('X4 (V-RTU-91 / NFR-RTU-3): Diff 탭을 닫으면 Monaco 인스턴스도 놓는다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      const count = () => page.evaluate(() => {
        const m = (window as any).monaco;
        return m ? m.editor.getDiffEditors().length : -1;
      });
      await sideTab(page, 'changes').click();
      await side(page).locator(`.git-file[data-path="src/a.ts"]`).click();
      await expect(viewTab(page, 'diff')).toHaveCount(1, { timeout: 10000 });
      await expect(page.locator('#area .ed-area .monaco-diff-editor'))
        .toBeVisible({ timeout: 30000 });
      expect(await count(), 'diff 인스턴스가 만들어지지 않았다').toBeGreaterThan(0);

      await viewTab(page, 'diff').locator('.pn-tab-x').click();
      await expect(viewTab(page, 'diff')).toHaveCount(0, { timeout: 10000 });
      // 탭이 없으면 인스턴스도 없다 — DOM 을 떼는 것으로는 풀리지 않는다.
      await expect.poll(count, { timeout: 15000 }).toBe(0);
    });
});

test.describe('묶음 P — 미리보기의 경계 (FR-RTU-45)', () => {
  test('X5 (V-RTU-45): 고정 탭이 있는 대상은 미리보기를 만들지 않는다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await openExplorerSide(page);
      const tree = page.locator('#area .ed-side .ed-tree');
      const row = (p: string) => tree.locator(`.ed-row[data-path="${cssPath(p)}"]`);
      await expect(tree.locator('.ed-row').first()).toBeVisible({ timeout: 10000 });

      // README 를 고정한다 (FR-RTU-42 ④ — 탐색기 행의 더블클릭).
      await row(j(REPO, 'README.md')).dblclick();
      await expect(mainTabs(page)).toHaveCount(1, { timeout: 10000 });
      await expect(mainTabs(page).first()).not.toHaveClass(/pn-tab-preview/);

      // 같은 대상을 다시 한 번 클릭한다 — 새 미리보기를 만들지 않고 그 탭으로 간다.
      await row(j(REPO, 'README.md')).click();
      await expect(mainTabs(page)).toHaveCount(1);
      await expect(page.locator('#area .ed-area .pn-tab.pn-tab-preview')).toHaveCount(0);
    });
});

test.describe('묶음 S — 관측의 경계 (NFR-RTU-1)', () => {
  /**
   * NFR-RTU-1: git 실행 횟수가 저장소 수에 비례해 늘지 않는다.
   *
   * 근거는 FR-RTU-62 다 — 관측은 **그 표면이 화면에 있을 때**만 돈다. 창을 여럿
   * 세우고 그 중 하나에만 서 있으면 status 는 그 하나에만 간다.
   */
  test('X6 (V-RTU-90 / NFR-RTU-1): 창이 여럿이어도 폴링은 보이는 표면 것뿐이다',
    async ({ page, request }) => {
      const others: string[] = [];
      for (let i = 0; i < 3; i++) {
        const d = j(BASE, 'more' + i);
        fs.mkdirSync(d, { recursive: true });
        git(d, 'init', '-q', '-b', 'main', '.');
        w(j(d, 'x.txt'), 'x\n');
        others.push(realPath(d));
      }
      for (const p of others) await addEditor(request, p);
      await enter(page, request, REPO);
      await sideTab(page, 'changes').click();
      await expect(side(page).locator('.git-view.git-changes')).toBeVisible({ timeout: 10000 });

      const hits = new Map<string, number>();
      page.on('request', (r) => {
        const u = decodeURIComponent(r.url());
        if (!u.includes('/api/git/status')) return;
        for (const p of [REPO, ...others]) if (u.includes(p)) hits.set(p, (hits.get(p) || 0) + 1);
      });
      // GIT_PUSH_OBSERVE_SRS: 관측은 서버 푸시 + 안전망 폴링이다. **경계는
      // 그대로** — 보이지 않는 표면은 어느 쪽으로도 관측되지 않는다. 안전망을
      // 검사용으로 줄여 그 경계를 짧은 창에서 확인한다 (재는 것은 경계이지
      // 주기값이 아니다).
      const poll = await page.evaluate(() => {
        (window as any).gitStatusInterval = 600;
        const app = (window as any).app;
        if (app._gitPanels) for (const p of app._gitPanels.values()) p._reschedule();
        return 600;
      });
      await page.waitForTimeout(poll * 3 + 500);

      expect(hits.get(REPO) || 0, '보이는 저장소가 폴링되지 않았다').toBeGreaterThan(0);
      for (const p of others) {
        expect(hits.get(p) || 0, `보이지 않는 저장소 ${p} 가 폴링됐다`).toBe(0);
      }
    });
});

test.describe('묶음 B — 모바일 영역 순회 (FR-RTU-80~82)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const indicator = (page: Page) => page.locator('#m-pane-indicator');

  async function enterMobile(page: Page, request: APIRequestContext, root: string) {
    await addEditor(request, root);
    await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'mobile') });
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    await page.waitForFunction(
      () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
      undefined, { timeout: 15000 });
    await page.evaluate((r) => {
      const a = (window as any).app;
      const win = a._edWindows().find((x: any) => a._edRootOf(x) === r);
      a.switchWindow(win.id);
    }, root);
    await expect(page.locator('body')).toHaveClass(/mobile/);
  }

  test('M1 (V-RTU-80·82): 순회의 첫 자리가 사이드이고 계수가 그것을 포함한다',
    async ({ page, request }) => {
      await enterMobile(page, request, REPO);
      // 편집기 탭 하나를 만든다 — pane 이 하나 서야 계수가 둘이 된다.
      await page.evaluate((p) => (window as any).app._edOpenFile(p), j(REPO, 'README.md'));
      await expect(page.locator('#area .ed-area .pn-tab')).toHaveCount(1, { timeout: 15000 });
      await expect(indicator(page)).toHaveText('2/2', { timeout: 10000 });

      // 첫 자리로 간다 — 사이드가 화면 전체를 쓰고 본문은 없다.
      await page.click('#m-pane-prev');
      await expect(indicator(page)).toHaveText('1/2');
      await expect(page.locator('#area .ed-win .ed-side')).toBeVisible();
      await expect(page.locator('#area .ed-win .ed-area')).toHaveCount(0);

      // FR-RTU-81: 그 자리에서 사이드 탭이 그대로 동작한다.
      await sideTab(page, 'changes').click();
      await expect(side(page).locator('.git-view.git-changes')).toBeVisible({ timeout: 10000 });

      // 다시 본문으로 — 사이드는 물러난다.
      await page.click('#m-pane-next');
      await expect(indicator(page)).toHaveText('2/2');
      await expect(page.locator('#area .ed-win .ed-area')).toHaveCount(1);
      await expect(page.locator('#area .ed-win .ed-side')).toHaveCount(0);
    });

  test('M2 (V-RTU-80): 사이드 자리에서 Changes 가 경계를 넘지 않는다',
    async ({ page, request }) => {
      await enterMobile(page, request, REPO);
      await expect(indicator(page)).toHaveText('1/1', { timeout: 10000 });
      await sideTab(page, 'changes').click();
      await expect(side(page).locator('.git-view.git-changes')).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(800);

      const over = await page.evaluate(() => {
        const view = document.querySelector('#area .ed-side .git-view.git-changes') as HTMLElement;
        const vr = view.getBoundingClientRect();
        const items: string[] = [];
        for (const el of Array.from(view.querySelectorAll('*')) as HTMLElement[]) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right > vr.right + 1 || r.left < vr.left - 1) items.push(el.className || el.tagName);
        }
        return { items: items.slice(0, 20), clientW: view.clientWidth, scrollW: view.scrollWidth };
      });
      expect(over.items, '사이드 안에서 경계를 넘는 요소가 있다').toEqual([]);
      expect(over.scrollW).toBe(over.clientW);
    });

  /**
   * M3 (V-RTU-83): **본문에 pane 이 이미 있어도 연 것이 보인다.**
   *
   * 회귀의 조건이 까다롭다 — pane 이 **없을 때** 연 첫 파일은 pane 이 새로 생기며
   * 포커스 id 가 바뀌므로 종전 코드로도 열렸다. 두 번째부터가 먹통이었다. 그래서
   * 이 검사는 파일 하나를 먼저 열어 두는 것으로 시작한다.
   */
  test('M3 (V-RTU-83): 사이드에서 연 파일·diff 가 본문 자리를 보인다',
    async ({ page, request }) => {
      await enterMobile(page, request, REPO);

      // ① 첫 파일 — pane 이 여기서 선다. 종전 코드도 통과하던 자리다.
      await page.evaluate((p) => (window as any).app._edOpenFile(p), j(REPO, 'README.md'));
      await expect(indicator(page)).toHaveText('2/2', { timeout: 15000 });

      // 사이드로 돌아간다. 이제 본문의 pane 은 **있고 이미 포커스**다.
      await page.click('#m-pane-prev');
      await expect(indicator(page)).toHaveText('1/2');
      await openExplorerSide(page);
      const tree = page.locator('#area .ed-side .ed-tree');
      await expect(tree.locator('.ed-row').first()).toBeVisible({ timeout: 10000 });

      // ② 두 번째 파일 — 종전에는 탭만 생기고 화면은 Explorer 그대로였다.
      await tree.locator(`.ed-row[data-path="${cssPath(j(REPO, 'src'))}"]`).click();
      await tree.locator(`.ed-row[data-path="${cssPath(j(REPO, 'src', 'a.ts'))}"]`).click();
      await expect(indicator(page)).toHaveText('2/2', { timeout: 10000 });
      await expect(page.locator('#area .ed-win .ed-area')).toHaveCount(1);
      await expect(page.locator('#area .ed-area .pn-tab.active')).toContainText('a.ts');

      // ③ diff — 다른 진입점(`openView`)이고 같은 규약이다.
      await page.click('#m-pane-prev');
      await expect(indicator(page)).toHaveText('1/2');
      await sideTab(page, 'changes').click();
      const changed = side(page).locator('.git-view.git-changes .git-file').first();
      await expect(changed).toBeVisible({ timeout: 15000 });
      await changed.click();
      await expect(page.locator('#area .ed-area .git-view.git-diff')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('#area .ed-win .ed-side')).toHaveCount(0);
    });

  /**
   * M4 (V-RTU-83): 미리보기는 **옆 칸**에 열리고 (FR-DRV-5) 모바일에서 옆 칸은
   * 순회의 다음 자리다. 여기서 서지 못하면 버튼을 눌러도 아무 일이 없어 보인다.
   *
   * V-LSP-21 (FR-LSP-44a) 도 여기서 걸린다. **설치 제안 띠를 세워 두고** 누른다 —
   * 그 띠가 서면 손잡이가 아래로 내려 앉는데, 내려 앉는 값이 `38px` 로 박혀
   * 있어서 390px 폭(안내가 두 줄로 접힌다)에서는 여전히 띠 **안**에 있었다.
   * CI ubuntu 러너가 이것을 잡았다 — 그 러너에는 markdown 서버가 없다.
   * 여기서는 상태를 세워 어느 호스트에서도 같은 조건이 되게 한다.
   */
  test('M4 (V-RTU-83 · V-LSP-23): 설치 제안 띠 아래에서도 미리보기가 그 자리를 보인다',
    async ({ page, request }) => {
      await page.route('**/api/lsp/status', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ servers: [{
          id: 'markdown', langs: ['markdown'], exts: ['.md'],
          found: false, installer: 'npm', canInstall: true,
        }] }),
      }));
      await enterMobile(page, request, REPO);
      await page.evaluate((p) => (window as any).app._edOpenFile(p), j(REPO, 'README.md'));
      await expect(indicator(page)).toHaveText('2/2', { timeout: 15000 });

      // 띠가 실제로 서야 이 검사가 뜻을 갖는다.
      const offer = page.locator('#area .ed-area .fe-offer');
      await expect(offer).toBeVisible({ timeout: 15000 });

      // 손잡이는 띠 **아래**에 있다 — 띠가 두 줄이어도.
      const btn = page.locator('#area .ed-area .fe-render');
      await expect(btn).toBeVisible({ timeout: 15000 });
      const clear = await page.evaluate(() => {
        const o = document.querySelector('#area .ed-area .fe-offer') as HTMLElement;
        const b = document.querySelector('#area .ed-area .fe-render') as HTMLElement;
        return { offerBottom: o.getBoundingClientRect().bottom, btnTop: b.getBoundingClientRect().top };
      });
      expect(clear.btnTop, '미리보기 손잡이가 제안 띠에 덮인다')
        .toBeGreaterThanOrEqual(clear.offerBottom);

      // 그래서 `force` 없이 눌린다 — 덮여 있으면 여기서 띠가 클릭을 먹는다.
      await btn.click();

      // 칸이 하나 늘고 순회가 그 자리에 선다 — 렌더 탭이 활성이다.
      await expect(indicator(page)).toHaveText('3/3', { timeout: 15000 });
      await expect(page.locator('#area .ed-area .pn-tab.active')).toContainText('README.md');
      await expect(page.locator('#area .ed-area .doc-render .dr-body'))
        .toHaveCount(1, { timeout: 15000 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 묶음 N — 좁은 폭의 손짓 (FR-RTU-101 / NFR-RTU-6, D-RTU-34)
//
// 사이드 폭은 사용자가 정한다 — 기본 220px · **하한 100px**. 그 안에서 글자만
// `min-width:0` 이고 버튼이 `flex-shrink:0` 이면, 폭이 줄 때 버튼이 줄을 다 먹고
// **선택하려는 클릭이 `stage` 를 실행한다** (C4b 실측). 규칙은 둘이다 —
// 글자는 60px 아래로 눌리지 않고, 그것을 지키느라 버튼을 감추지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

const SIDE_WIDTHS = [220, 100];

async function setSideWidth(page: Page, w: number) {
  await page.evaluate((v) => {
    const a = (window as any).app;
    a._edSetSideWidth(v);
    a.render();
  }, w);
  // 폭이 실제로 바뀐 뒤에 잰다 — 렌더가 style.width 를 다시 쓴다.
  await expect(side(page)).toHaveCSS('width', `${w}px`);
}

/**
 * 행(또는 바) 안의 글자 자리 폭과, 버튼들이 그 칸 안에 들어오는지.
 *
 * **글자 폭은 호버 전에, 버튼은 호버 뒤에 잰다** (사용자 지시 2026-09-08).
 * 행의 동작은 흐름 밖의 겹이 되어 호버에서만 보이므로, 평소의 이름 폭과 드러난
 * 버튼의 자리는 서로 다른 순간의 사실이다 — 한 번에 재면 둘 중 하나가 거짓이 된다.
 */
async function measure(page: Page, rowSel: string, textSel: string, actSel: string) {
  const textW = await page.evaluate(([rs, ts]) => {
    const row = document.querySelector(rs) as HTMLElement;
    if (!row) throw new Error('행이 없다: ' + rs);
    const t = row.querySelector(ts) as HTMLElement;
    return t ? t.getBoundingClientRect().width : 0;
  }, [rowSel, textSel]);
  await page.locator(rowSel).first().hover();
  const rest = await page.evaluate(([rs, ts, as]) => {
    const row = document.querySelector(rs) as HTMLElement;
    if (!row) throw new Error('행이 없다: ' + rs);
    const host = row.closest('.ed-side') as HTMLElement;
    const hr = host.getBoundingClientRect();
    const text = row.querySelector(ts) as HTMLElement;
    const acts = Array.from(row.querySelectorAll(as)) as HTMLElement[];
    return {
      textW: text ? text.getBoundingClientRect().width : 0,
      acts: acts.map((b) => {
        const r = b.getBoundingClientRect();
        return {
          act: b.dataset.act || b.className,
          w: r.width, h: r.height,
          inside: r.left >= hr.left - 1 && r.right <= hr.right + 1,
        };
      }),
    };
  }, [rowSel, textSel, actSel]);
  return { ...rest, textW };
}

test.describe('묶음 N — 좁은 폭에서도 누를 자리가 남는다', () => {
  test('N1 (V-RTU-95·96): 변경 행의 이름이 60px 아래로 눌리지 않고 버튼이 전부 닿는다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await sideTab(page, 'changes').click();
      const row = '#area .ed-side .git-file[data-path="src/a.ts"]';
      await expect(page.locator(row)).toBeVisible({ timeout: 10000 });

      for (const w of SIDE_WIDTHS) {
        await setSideWidth(page, w);
        const m = await measure(page, row, '.git-file-path', '.git-file-act');
        // 평소(호버 전) 이름은 60px 아래로 눌리지 않는다. 동작이 흐름 밖의 겹이
        // 된 뒤로 이 폭은 오히려 넓어졌다 — 220px 에서 120 → 185px (실측).
        expect(m.textW, `${w}px 에서 이름이 눌렸다`).toBeGreaterThanOrEqual(60);
        // 호버하면 셋이 다 선다 (`openFile`·`stage`·`discard`). 자리지킴은 세지
        // 않는다 (FR-TIP-6).
        expect(m.acts.length, `${w}px 에서 버튼이 사라졌다`).toBe(3);
        for (const b of m.acts) {
          expect(b.inside, `${w}px 에서 ${b.act} 가 사이드를 넘었다`).toBeTruthy();
          // 히트 영역 하한은 그대로다 (FR-GIT-195~198).
          expect(b.w).toBeGreaterThanOrEqual(30);
          expect(b.h).toBeGreaterThanOrEqual(30);
        }
      }
    });

  // WORKBENCH_REVIEW_SRS NFR-WBR-10a / V-WBR-58 — 같은 규칙의 새 시험대다.
  // 묶음 D 가 그룹 머리의 일괄을 **아이콘 둘**(`+`·`↺`)로 늘렸다. 기본 폭에서는
  // 한 줄이고(NFR-WBR-10), 하한에서만 줄이 늘어난다.
  test('N3 (V-WBR-58 / NFR-WBR-10a): 아이콘 둘이 된 그룹 머리도 이름을 60px 남긴다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await sideTab(page, 'changes').click();
      const head = '#area .ed-side .git-group[data-group="working"] .git-group-head';
      await expect(page.locator(head)).toBeVisible({ timeout: 10000 });

      for (const w of SIDE_WIDTHS) {
        await setSideWidth(page, w);
        const m = await measure(page, head, '.git-group-name', '.git-group-bulk');
        // 머리의 일괄은 흐름 안에 있고 **늘 보인다** — 그룹의 손잡이가 그 자리다.
        expect(m.textW, `${w}px 에서 그룹 이름이 눌렸다`).toBeGreaterThanOrEqual(60);
        // 감추지 않는다 — 둘 다 남는다 (FR-WBR-50).
        expect(m.acts.length, `${w}px 에서 일괄 버튼이 사라졌다`).toBe(2);
        for (const b of m.acts)
          expect(b.inside, `${w}px 에서 ${b.act} 가 사이드를 넘었다`).toBeTruthy();
      }
    });

  // WORKBENCH_REVIEW_SRS NFR-WBR-11 / V-WBR-85 — 묶음 F 가 트리 보기의 **폴더
  // 행**에도 동작을 두었다. 행 클릭이 접기라는 뜻을 가지므로 같은 규칙이 온다.
  test('N4 (V-WBR-85 / NFR-WBR-11): 폴더 행도 이름을 60px 남기고 동작이 닿는다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await sideTab(page, 'changes').click();
      // 트리 보기여야 폴더 행이 있다 (FR-WBR-83).
      await page.locator('#area .ed-side .git-files-mode[data-mode="tree"]').click();
      const dir = '#area .ed-side .git-dir[data-dir="src"]';
      await expect(page.locator(dir)).toBeVisible({ timeout: 10000 });

      for (const w of SIDE_WIDTHS) {
        await setSideWidth(page, w);
        const m = await measure(page, dir, '.git-dir-name', '.git-file-act');
        expect(m.textW, `${w}px 에서 폴더 이름이 눌렸다`).toBeGreaterThanOrEqual(60);
        // UX_BATCH5_SRS FR-DBA-1 로 **둘이 됐다** (`stage`·`discard`). 자리지킴
        // (`.git-act-gap`)은 버튼이 아니므로 여기 세지 않는다 (FR-TIP-6).
        expect(m.acts.length, `${w}px 에서 동작이 사라졌다`).toBe(2);
        for (const b of m.acts)
          expect(b.inside, `${w}px 에서 ${b.act} 가 사이드를 넘었다`).toBeTruthy();
      }
    });

  test('N2 (V-RTU-96): 버튼 넷인 conflicts 행도 기본 폭에서 전부 닿는다',
    async ({ page, request }) => {
      await enter(page, request, CONFLICT);
      await sideTab(page, 'changes').click();
      const row = '#area .ed-side .git-file[data-path="c.txt"]';
      await expect(page.locator(row)).toBeVisible({ timeout: 10000 });

      for (const w of SIDE_WIDTHS) {
        await setSideWidth(page, w);
        const m = await measure(page, row, '.git-file-path', '.git-file-act');
        expect(m.textW, `${w}px 에서 이름이 눌렸다`).toBeGreaterThanOrEqual(60);
        expect(m.acts.length, `${w}px 에서 버튼이 사라졌다`).toBe(4);
        for (const b of m.acts)
          expect(b.inside, `${w}px 에서 ${b.act} 가 사이드를 넘었다`).toBeTruthy();
      }
    });
});
