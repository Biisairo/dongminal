import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import {
  test, expect, openRowMenu, rmTree, switchToEditorRoot, openExplorerSide, addEditor, gotoWithEditors, openExplorerAt, enterExplorer,
} from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

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
  return realPath(d);
}

test.beforeAll(() => { BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-edcp-'))) });
test.afterAll(() => { rmTree(BASE) });

const row = (page: Page, p: string) => page.locator(`.ed-tree .ed-row[data-path="${cssPath(p)}"]`);
const opErr = (page: Page) => page.locator('.ed-tree .ed-op-err');
const menuItem = (page: Page, id: string) =>
  page.locator(`.git-menu .git-menu-item[data-id="${id}"]`);

async function openMenu(page: Page, p: string) {
  await openRowMenu(page, row(page, p));
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
      await enterExplorer(page, request, R);

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
      await enterExplorer(page, request, A);

      await ctx(page, j(A, 'top.txt'), 'copy');

      // 창을 바꾼다 — 클립보드는 앱이 들고 있으므로 따라온다 (FR-WBR-71).
      await openExplorerAt(page, B);
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
      await enterExplorer(page, request, R);

      await ctx(page, j(R, 'top.txt'), 'copy');
      await openMenu(page, j(R, 'docs'));
      await expect(menuItem(page, 'paste')).not.toHaveClass(/disabled/);
      await page.keyboard.press('Escape');

      // 새로고침 뒤에는 포커스가 Editor 창이라 터미널을 기다리면 영영 오지
      // 않는다 — 창 목록이 선 것으로 판정한다.
      await page.reload();
      await page.waitForFunction(
        () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
        undefined, { timeout: 15000 });
      await openExplorerAt(page, R);
      await expect(row(page, j(R, 'top.txt'))).toBeVisible({ timeout: 10000 });

      // 무기한 사는 상태를 두지 않는다 — "언젠가 복사한 것" 이 남지 않는다.
      await openMenu(page, j(R, 'docs'));
      await expect(menuItem(page, 'paste')).toHaveClass(/disabled/);
    });

  test('C4 (V-WBR-72 / FR-WBR-70): 복제가 원본의 형제 자리에 `… copy` 를 만든다',
    async ({ page, request }) => {
      const R = mkRoot('c4');
      await enterExplorer(page, request, R);

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
      await enterExplorer(page, request, R);

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
      await enterExplorer(page, request, R);
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

/**
 * `12-func-ui.md FUI-11` — **잘라내기.**
 *
 * 접수한 결함: *"다른 루트로의 이동이 없다(복사는 있다)."* 붙여넣기는 루트를
 * 건널 수 있는데(FR-WBR-61) 드래그는 트리 안에서만 성립했고, "잘라내기" 항목
 * 자체가 없었다.
 *
 * **복사와 같은 클립보드를 쓴다** — 동사만 다르다. 그래서 여기서 재는 것은
 * 복사와 **갈리는 자리**뿐이다: 원본이 사라지는가, 한 번만 붙는가, 이름이
 * 개명되지 않는가, 그리고 루트를 건너는가.
 */
test.describe('FUI-11 — 탐색기의 잘라내기', () => {
  test('X1: 메뉴에 잘라내기가 있고, 붙여넣으면 원본이 사라진다',
    async ({ page, request }) => {
      const R = mkRoot('x1');
      await enterExplorer(page, request, R);

      await openMenu(page, j(R, 'top.txt'));
      await expect(menuItem(page, 'cut')).toBeVisible();
      await menuItem(page, 'cut').click();

      await ctx(page, j(R, 'docs'), 'paste');
      await expect(row(page, j(R, 'docs', 'top.txt'))).toBeVisible({ timeout: 10000 });
      // **복사와 갈리는 자리다** — 원본이 없다.
      await expect(row(page, j(R, 'top.txt'))).toHaveCount(0);
      expect(fs.existsSync(j(R, 'top.txt'))).toBeFalsy();
      expect(fs.existsSync(j(R, 'docs', 'top.txt'))).toBeTruthy();
    });

  test('X2: 잘라낸 것은 한 번만 붙는다', async ({ page, request }) => {
    const R = mkRoot('x2');
    await enterExplorer(page, request, R);
    await ctx(page, j(R, 'top.txt'), 'cut');
    await ctx(page, j(R, 'docs'), 'paste');
    await expect(row(page, j(R, 'docs', 'top.txt'))).toBeVisible({ timeout: 10000 });

    // 클립보드가 비었다 — 남겨 두면 다음 붙여넣기가 이미 없는 원본을 찾는다.
    await openMenu(page, j(R, 'src'));
    await expect(menuItem(page, 'paste')).toHaveClass(/disabled/);
  });

  test('X3: 같은 이름이 있으면 거절한다 — 개명하지 않는다', async ({ page, request }) => {
    const R = mkRoot('x3');
    w(j(R, 'docs', 'top.txt'), 'OTHER\n');
    await enterExplorer(page, request, R);

    await ctx(page, j(R, 'top.txt'), 'cut');
    await ctx(page, j(R, 'docs'), 'paste');

    // 복사는 `top copy.txt` 로 올라가지만(FR-WBR-63) 이동은 그러지 않는다 —
    // "복제" 는 개명이 본질이고 "옮기기" 는 아니다.
    await expect(opErr(page)).toBeVisible({ timeout: 10000 });
    expect(fs.existsSync(j(R, 'top.txt')), '거절됐는데 원본이 사라졌다').toBeTruthy();
    expect(fs.readFileSync(j(R, 'docs', 'top.txt'), 'utf8')).toBe('OTHER\n');
  });

  test('X4: 루트를 건너 옮긴다 — 양쪽 트리가 따라온다', async ({ page, request }) => {
    const A = mkRoot('x4a'), B = mkRoot('x4b');
    await addEditor(request, A);
    await addEditor(request, B);
    await gotoWithEditors(page);

    await openExplorerAt(page, A);
    await expect(row(page, j(A, 'top.txt'))).toBeVisible({ timeout: 10000 });
    await ctx(page, j(A, 'top.txt'), 'cut');

    await openExplorerAt(page, B);
    await expect(row(page, j(B, 'docs'))).toBeVisible({ timeout: 10000 });
    await ctx(page, j(B, 'docs'), 'paste');
    await expect(row(page, j(B, 'docs', 'top.txt'))).toBeVisible({ timeout: 10000 });

    expect(fs.existsSync(j(A, 'top.txt')), '출발 루트에 남아 있다').toBeFalsy();
    expect(fs.existsSync(j(B, 'docs', 'top.txt'))).toBeTruthy();

    // 출발 트리로 돌아가면 그 행이 없다 — 남의 인스턴스도 다시 읽었다.
    await openExplorerAt(page, A);
    await expect(row(page, j(A, 'docs'))).toBeVisible({ timeout: 10000 });
    await expect(row(page, j(A, 'top.txt'))).toHaveCount(0);
  });

  /**
   * M9_SRS FR-M9-19 / V-M9-19b (사용자 요구 2026-09-14) — **경로 복사 둘.**
   *
   * 단위(`web/js/test/path-relative.test.mjs`)가 `pathRelative` 의 문자열 규칙을
   * 이미 잰다. 여기서 재는 것은 그 위의 것이다 — 메뉴에 있는가, 파일과 폴더
   * 둘 다에서 서는가, 눌렀을 때 **클립보드에 실제로 들어가는가.**
   *
   * 클립보드를 `navigator.clipboard.readText` 로 읽으므로 권한을 먼저 준다
   * (`explorer-transfer-ignore.spec.ts` ET12 와 같은 벌).
   */
  test('C9 (V-M9-19b / FR-M9-19): 파일·폴더의 절대·상대 경로가 클립보드로 간다',
    async ({ page, request, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const R = mkRoot('c9');
      await enterExplorer(page, request, R);

      // 한 겹 아래의 파일을 쓴다 — 루트 바로 밑이면 상대와 이름이 같아져 이 검사가
      // "상대인가" 를 묻지 못한다. 그래서 `src` 를 펼친다 (C6 과 같은 길).
      await row(page, j(R, 'src')).click();
      await expect(row(page, j(R, 'src', 'a.txt'))).toBeVisible({ timeout: 10000 });

      // 두 항목이 자기 구획에 함께 선다.
      await openMenu(page, j(R, 'src', 'a.txt'));
      await expect(menuItem(page, 'copyAbsPath')).toBeVisible();
      await expect(menuItem(page, 'copyRelPath')).toBeVisible();
      await page.keyboard.press('Escape');

      const clip = () => page.evaluate(() => navigator.clipboard.readText());

      // 절대는 서버가 준 경로 그대로다.
      await ctx(page, j(R, 'src', 'a.txt'), 'copyAbsPath');
      await expect.poll(clip, { timeout: 10000 }).toBe(j(R, 'src', 'a.txt'));

      // 상대의 기준은 **이 탐색기 루트**다 (D-M9-10). 구분자는 그 경로의 것이므로
      // 기대값도 `path.join` 으로 만든다 — Windows 에서 `/` 를 박으면 거짓 실패다.
      await ctx(page, j(R, 'src', 'a.txt'), 'copyRelPath');
      await expect.poll(clip, { timeout: 10000 }).toBe(j('src', 'a.txt'));

      // 폴더에서도 선다 — 요구는 "파일/폴더" 였다.
      await ctx(page, j(R, 'docs'), 'copyRelPath');
      await expect.poll(clip, { timeout: 10000 }).toBe('docs');

      await ctx(page, j(R, 'docs'), 'copyAbsPath');
      await expect.poll(clip, { timeout: 10000 }).toBe(j(R, 'docs'));
    });
});
