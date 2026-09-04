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

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-rtu-')));
  REPO = makeRepo(BASE);
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
