import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// WORKBENCH_REVIEW_SRS 묶음 P — 탐색기의 복사·복제 (FR-WBR-70~74,
// 검증 V-WBR-69~74).
//
// **서버 쪽은 여기서 재지 않는다.** 개명 규칙·루트 교차·자기 하위 금지·상한·
// 모드 보존은 `handlers_fs_copy_test.go` 가 잰다 (V-WBR-60~68). 여기서 재는 것은
// 그 위의 클라이언트 규약이다 — 메뉴, 클립보드의 **수명과 범위**, 실패의 자리,
// 그리고 다시 읽는 폴더의 수.

let BASE = '';

const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);

/**
 * 테스트 하나가 쓰는 루트. 복사는 파일을 만드므로 공유하지 않는다.
 *
 *   <root>/src/a.txt · b.txt
 *   <root>/docs/d.txt
 *   <root>/top.txt
 */
function mkRoot(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'src'), { recursive: true });
  fs.mkdirSync(j(d, 'docs'));
  w(j(d, 'src', 'a.txt'), 'A\n');
  w(j(d, 'src', 'b.txt'), 'B\n');
  w(j(d, 'docs', 'd.txt'), 'D\n');
  w(j(d, 'top.txt'), 'T\n');
  return fs.realpathSync(d);
}

test.beforeAll(() => { BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-edcp-'))) });
test.afterAll(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }) });

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

async function openEditor(page: Page, root: string) {
  await page.evaluate((r) => {
    const a = (window as any).app;
    const win = a._edWindows().find((x: any) => x.editor && x.editor.root === r);
    if (!win) throw new Error('Editor 창이 없다: ' + r);
    a.switchWindow(win.id);
  }, root);
  await page.waitForSelector('.ed-win .ed-explorer .ed-tree', { timeout: 10000 });
}

async function enter(page: Page, request: APIRequestContext, root: string) {
  await addEditor(request, root);
  await goto(page);
  await openEditor(page, root);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

const row = (page: Page, p: string) => page.locator(`.ed-tree .ed-row[data-path="${p}"]`);
const opErr = (page: Page) => page.locator('.ed-tree .ed-op-err');
const menuItem = (page: Page, id: string) =>
  page.locator(`.git-menu .git-menu-item[data-id="${id}"]`);

async function openMenu(page: Page, p: string) {
  await row(page, p).click({ button: 'right' });
  await expect(page.locator('.git-menu')).toBeVisible();
}

async function ctx(page: Page, p: string, id: string) {
  await openMenu(page, p);
  await menuItem(page, id).click();
}

function counter(page: Page, pred: (url: string) => boolean) {
  const box = { n: 0 };
  page.on('request', ((req: { url(): string }) => { if (pred(req.url())) box.n++ }) as never);
  return box;
}
const isList = (u: string) => u.includes('/api/fs/list');

test.describe('묶음 P — 탐색기의 복사·복제', () => {
  test('C1 (V-WBR-69 / FR-WBR-70): 메뉴에 셋이 있고, 복사 전에는 붙여넣기가 비활성이다',
    async ({ page, request }) => {
      const R = mkRoot('c1');
      await enter(page, request, R);

      await openMenu(page, j(R, 'top.txt'));
      await expect(menuItem(page, 'copy')).toBeVisible();
      await expect(menuItem(page, 'paste')).toBeVisible();
      await expect(menuItem(page, 'duplicate')).toBeVisible();
      // 비활성의 사유를 툴팁이 말한다 — 다운로드의 링크 규약과 같다.
      await expect(menuItem(page, 'paste')).toHaveClass(/disabled/);
      await expect(menuItem(page, 'paste')).toHaveAttribute('title', '복사한 것이 없습니다');

      // 복사하면 살아난다.
      await menuItem(page, 'copy').click();
      await openMenu(page, j(R, 'docs'));
      await expect(menuItem(page, 'paste')).not.toHaveClass(/disabled/);
    });

  test('C2 (V-WBR-70 / FR-WBR-71): 복사한 것이 다른 Editor 창의 탐색기에서도 붙여넣어진다',
    async ({ page, request }) => {
      const A = mkRoot('c2a');
      const B = mkRoot('c2b');
      await addEditor(request, B);
      await enter(page, request, A);

      await ctx(page, j(A, 'top.txt'), 'copy');

      // 창을 바꾼다 — 클립보드는 앱이 들고 있으므로 따라온다 (FR-WBR-71).
      await openEditor(page, B);
      await expect(row(page, j(B, 'top.txt'))).toBeVisible({ timeout: 10000 });
      await ctx(page, j(B, 'docs'), 'paste');

      // 루트가 갈려도 된다 (FR-WBR-61) — 서버가 두 루트를 받는다.
      await expect(row(page, j(B, 'docs', 'top.txt'))).toBeVisible({ timeout: 10000 });
      expect(fs.readFileSync(j(B, 'docs', 'top.txt'), 'utf8')).toBe('T\n');
      // 원본은 그대로다 — 이동이 아니다.
      expect(fs.existsSync(j(A, 'top.txt'))).toBeTruthy();
    });

  test('C3 (V-WBR-71 / FR-WBR-71): 새로고침하면 붙여넣기가 다시 비활성이다',
    async ({ page, request }) => {
      const R = mkRoot('c3');
      await enter(page, request, R);

      await ctx(page, j(R, 'top.txt'), 'copy');
      await openMenu(page, j(R, 'docs'));
      await expect(menuItem(page, 'paste')).not.toHaveClass(/disabled/);
      await page.keyboard.press('Escape');

      // 새로고침 뒤에는 포커스가 Editor 창이라 터미널을 기다리면 영영 오지
      // 않는다 — 창 목록이 선 것으로 판정한다.
      await page.reload();
      await page.waitForFunction(
        () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
        undefined, { timeout: 15000 });
      await openEditor(page, R);
      await expect(row(page, j(R, 'top.txt'))).toBeVisible({ timeout: 10000 });

      // 무기한 사는 상태를 두지 않는다 — "언젠가 복사한 것" 이 남지 않는다.
      await openMenu(page, j(R, 'docs'));
      await expect(menuItem(page, 'paste')).toHaveClass(/disabled/);
    });

  test('C4 (V-WBR-72 / FR-WBR-70): 복제가 원본의 형제 자리에 `… copy` 를 만든다',
    async ({ page, request }) => {
      const R = mkRoot('c4');
      await enter(page, request, R);

      await ctx(page, j(R, 'top.txt'), 'duplicate');
      await expect(row(page, j(R, 'top copy.txt'))).toBeVisible({ timeout: 10000 });
      expect(fs.readFileSync(j(R, 'top copy.txt'), 'utf8')).toBe('T\n');

      // 되풀이하면 올라간다 — 개명이 서버의 일이다 (FR-WBR-63).
      await ctx(page, j(R, 'top.txt'), 'duplicate');
      await expect(row(page, j(R, 'top copy 2.txt'))).toBeVisible({ timeout: 10000 });

      // 폴더도 같다.
      await ctx(page, j(R, 'src'), 'duplicate');
      await expect(row(page, j(R, 'src copy'))).toBeVisible({ timeout: 10000 });
      expect(fs.readFileSync(j(R, 'src copy', 'a.txt'), 'utf8')).toBe('A\n');

      // 복제는 클립보드를 덮지 않는다 — 그것은 다른 조작이다.
      await openMenu(page, j(R, 'docs'));
      await expect(menuItem(page, 'paste')).toHaveClass(/disabled/);
    });

  test('C5 (V-WBR-73 / FR-WBR-73): 원본이 사라진 뒤 붙여넣으면 그 자리에 사유가 붙는다',
    async ({ page, request }) => {
      const R = mkRoot('c5');
      await enter(page, request, R);

      await ctx(page, j(R, 'top.txt'), 'copy');
      fs.rmSync(j(R, 'top.txt'));

      await ctx(page, j(R, 'docs'), 'paste');
      await expect(opErr(page)).toBeVisible({ timeout: 10000 });
      expect(fs.existsSync(j(R, 'docs', 'top.txt'))).toBeFalsy();

      // FR-WBR-1: 다음 조작이 시작되면 그 사유가 사라진다.
      await ctx(page, j(R, 'src'), 'duplicate');
      await expect(row(page, j(R, 'src copy'))).toBeVisible({ timeout: 10000 });
      await expect(opErr(page)).toHaveCount(0);
    });

  test('C6 (V-WBR-74 / FR-WBR-74): 복사 뒤 다시 읽는 것은 대상 폴더 하나다',
    async ({ page, request }) => {
      const R = mkRoot('c6');
      await enter(page, request, R);
      // 양쪽을 다 펼쳐 둔다 — 재조회가 넓으면 여기서 드러난다.
      await row(page, j(R, 'src')).click();
      await expect(row(page, j(R, 'src', 'a.txt'))).toBeVisible({ timeout: 10000 });
      await row(page, j(R, 'docs')).click();
      await expect(row(page, j(R, 'docs', 'd.txt'))).toBeVisible({ timeout: 10000 });

      await ctx(page, j(R, 'src', 'a.txt'), 'copy');
      const c = counter(page, isList);
      await ctx(page, j(R, 'docs'), 'paste');
      await expect(row(page, j(R, 'docs', 'a.txt'))).toBeVisible({ timeout: 10000 });
      expect(c.n, '대상 폴더 하나만 다시 읽는다').toBe(1);
    });
});
