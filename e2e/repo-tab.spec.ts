import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

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
  return fs.realpathSync(d);
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
  return fs.realpathSync(d);
}

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-rtu-')));
  REPO = makeRepo(BASE);
  CONFLICT = makeConflict(BASE);
});
test.afterAll(() => {
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
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
  await page.evaluate((r) => {
    const a = (window as any).app;
    const win = a._edWindows().find((x: any) => x.editor && x.editor.root === r);
    if (!win) throw new Error('Repo 창이 없다: ' + r);
    a.switchWindow(win.id);
  }, root);
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
  test('W1 (V-RTU-10·11): 사이드에 탭 둘이 서고 기본은 Explorer 다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      await expect(sideTab(page, 'explorer')).toHaveText('Explorer');
      await expect(sideTab(page, 'changes')).toHaveText('Changes');
      await expect(sideTab(page, 'explorer')).toHaveClass(/active/);
      // 한 번에 하나만 보인다 (FR-RTU-12).
      await expect(side(page).locator('.ed-explorer')).toHaveCount(1);
      await expect(side(page).locator('.git-view.git-changes')).toHaveCount(0);
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
      await expect(side(page).locator('.ed-side-acts')).toHaveCount(0);
      await sideTab(page, 'changes').click();
      await expect(side(page).locator('.ed-side-acts')).toBeVisible();
      // Changes 는 여기 없다 — 그것은 사이드 자신이다 (FR-RTU-32).
      await expect(side(page).locator('.ed-side-act[data-view="changes"]')).toHaveCount(0);
      await expect(side(page).locator('.ed-side-act')).toHaveCount(6);
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
      const plain = fs.realpathSync(fs.mkdtempSync(j(BASE, 'plain-')));
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
      const fresh = fs.realpathSync(fs.mkdtempSync(j(BASE, 'fresh-')));
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
      const tree = page.locator('#area .ed-side .ed-tree');
      await expect(tree.locator('.ed-row').first()).toBeVisible({ timeout: 10000 });

      await tree.locator(`.ed-row[data-path="${j(REPO, 'README.md')}"]`).click();
      await expect(mainTabs(page)).toHaveCount(1, { timeout: 10000 });
      await expect(mainTabs(page).first()).toHaveClass(/pn-tab-preview/);

      // 다른 파일을 누르면 **같은 탭이 대상을 갈아탄다** — 탭이 쌓이지 않는다.
      await tree.locator(`.ed-row[data-path="${j(REPO, 'src')}"]`).click();
      await tree.locator(`.ed-row[data-path="${j(REPO, 'src', 'a.ts')}"]`).click();
      await expect(mainTabs(page)).toHaveCount(1);
      await expect(mainTabs(page).first()).toContainText('a.ts');
    });

  test('P2 (V-RTU-42·43): 더블클릭이 고정하고 다음 미리보기는 새 탭이 된다',
    async ({ page, request }) => {
      await enter(page, request, REPO);
      const tree = page.locator('#area .ed-side .ed-tree');
      await expect(tree.locator('.ed-row').first()).toBeVisible({ timeout: 10000 });

      await tree.locator(`.ed-row[data-path="${j(REPO, 'README.md')}"]`).click();
      await expect(mainTabs(page)).toHaveCount(1, { timeout: 10000 });
      await mainTabs(page).first().dblclick();
      await expect(mainTabs(page).first()).not.toHaveClass(/pn-tab-preview/);

      await tree.locator(`.ed-row[data-path="${j(REPO, 'src')}"]`).click();
      await tree.locator(`.ed-row[data-path="${j(REPO, 'src', 'a.ts')}"]`).click();
      // 고정된 탭은 남고 미리보기가 하나 더 선다 — 창에 미리보기는 하나뿐이다.
      await expect(mainTabs(page)).toHaveCount(2);
      await expect(mainTabs(page).locator('.pn-tab-preview')).toHaveCount(0);
      await expect(page.locator('#area .ed-area .pn-tab.pn-tab-preview')).toHaveCount(1);
    });

  test('P3 (V-RTU-44): 미리보기 상태가 새로고침을 넘는다', async ({ page, request }) => {
    await enter(page, request, REPO);
    const tree = page.locator('#area .ed-side .ed-tree');
    await expect(tree.locator('.ed-row').first()).toBeVisible({ timeout: 10000 });
    await tree.locator(`.ed-row[data-path="${j(REPO, 'README.md')}"]`).click();
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
      const tree = page.locator('#area .ed-side .ed-tree');
      const row = (p: string) => tree.locator(`.ed-row[data-path="${p}"]`);
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
        others.push(fs.realpathSync(d));
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
      const poll = await page.evaluate(() => gitStatusInterval);
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
    a._edSetExplorerWidth(a._aw(), v);
    a.render();
  }, w);
  // 폭이 실제로 바뀐 뒤에 잰다 — 렌더가 style.width 를 다시 쓴다.
  await expect(side(page)).toHaveCSS('width', `${w}px`);
}

/** 행(또는 바) 안의 글자 자리 폭과, 버튼들이 그 칸 안에 들어오는지. */
async function measure(page: Page, rowSel: string, textSel: string, actSel: string) {
  return page.evaluate(([rs, ts, as]) => {
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
        expect(m.textW, `${w}px 에서 이름이 눌렸다`).toBeGreaterThanOrEqual(60);
        // 감추지 않는다 — `changes` 그룹은 셋이다 (`↗`·`+`·`↺`).
        expect(m.acts.length, `${w}px 에서 버튼이 사라졌다`).toBe(3);
        for (const b of m.acts) {
          expect(b.inside, `${w}px 에서 ${b.act} 가 사이드를 넘었다`).toBeTruthy();
          // 히트 영역 하한은 그대로다 (FR-GIT-195~198).
          expect(b.w).toBeGreaterThanOrEqual(30);
          expect(b.h).toBeGreaterThanOrEqual(30);
        }
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
