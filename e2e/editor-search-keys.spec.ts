import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// EDITOR_GIT_UX_SRS §4 — V-EKB-3~6 (FR-EKB-5·6).
//
// 두 가지를 잰다. 하나는 편집기 검색 셋의 키가 **설정에서 온다**는 것 — 종전에는
// 코드에 박혀 있어 바꿀 수 없었다. 다른 하나는 검색으로 연 파일이 탐색기에서
// **보인다**는 것 — 파일만 열고 트리를 접어 둔 채면 사용자가 방금 검색이 알려
// 준 경로를 손으로 다시 펼쳐야 한다.

const j = (...p: string[]) => path.join(...p);
let BASE = '';
let ROOT = '';

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-edk-')));
  ROOT = j(BASE, 'root');
  // 조상이 셋인 파일 — 재귀 전개가 한 겹만 여는지 전부 여는지 가른다.
  fs.mkdirSync(j(ROOT, 'aa', 'bb', 'cc'), { recursive: true });
  fs.writeFileSync(j(ROOT, 'aa', 'bb', 'cc', 'deep.txt'), 'needle_marker_zz\n');
  fs.writeFileSync(j(ROOT, 'top.txt'), 'top\n');
  ROOT = fs.realpathSync(ROOT);
});
test.afterAll(() => {
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: ROOT } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
  await page.evaluate((root) => {
    const a = (window as any).app;
    const win = a._edWindows().find((x: any) => x.editor && x.editor.root === root);
    if (!win) throw new Error('Editor 창이 없다: ' + root);
    a.switchWindow(win.id);
  }, ROOT);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

const panel = (page: Page) => page.locator('.ed-find.vis');

// FR-EKB-5 · V-EKB-3: `Mod` 는 Ctrl 과 Cmd 중 그 호스트가 쓰는 쪽이다. 기본값
// 하나로 두 OS 를 다 덮지 못하면 그 키는 결국 코드에 박히게 된다.
test('Mod 기본값은 Ctrl 과 Meta 를 모두 받는다', async ({ page, request }) => {
  await enter(page, request);

  await page.keyboard.press('Control+p');
  await expect(panel(page)).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();

  await page.keyboard.press('Meta+p');
  await expect(panel(page)).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('Escape');
});

// FR-EKB-5 · V-EKB-4: 설정에서 바꾼 키가 실제로 듣는다. 이것이 이 변경의 전부다.
test('설정에서 바꾼 키로 파일 검색이 열린다', async ({ page, request }) => {
  await enter(page, request);
  await page.evaluate(() => { (window as any).shortcuts.edQuickOpen = 'Ctrl+Shift+KeyJ' });

  // 옛 기본값은 더 이상 듣지 않는다 — 바꾼 값이 덮어썼기 때문이다.
  await page.keyboard.press('Control+p');
  await expect(panel(page)).toBeHidden();

  await page.keyboard.press('Control+Shift+KeyJ');
  await expect(panel(page)).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('Escape');
});

// FR-EKB-4 · V-EKB-5: 파일 내 검색의 기본값 `Mod+F` 는 터미널 검색과 같은
// 조합이다. Editor 창이 아니면 **삼키지 않고 넘겨야** 터미널 검색이 산다.
test('터미널 창의 Mod+F 는 종전대로 터미널 검색이다', async ({ page, request }) => {
  await enter(page, request);
  await page.evaluate(() => {
    const a = (window as any).app;
    const term = a.ws.windows.find((w: any) => !a._isEditorWin(w));
    if (!term) throw new Error('터미널 창이 없다');
    a.switchWindow(term.id);
  });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 10000 });

  await page.keyboard.press('Control+f');
  await expect(page.locator('#search-input')).toBeVisible({ timeout: 5000 });
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press('Escape');
});

// FR-EKB-6 · V-EKB-6: 전체 검색으로 연 파일이 탐색기에서 보인다. 조상이 셋이므로
// 한 겹만 여는 구현은 여기서 걸린다.
test('전체 검색으로 연 파일의 조상 폴더가 모두 펼쳐진다', async ({ page, request }) => {
  await enter(page, request);
  // 깊은 겹은 아직 접혀 있다 — 이것이 출발점이다.
  await expect(page.locator(`.ed-tree .ed-row[data-path="${ROOT}/aa/bb/cc/deep.txt"]`)).toHaveCount(0);

  await page.keyboard.press('Control+Shift+f');
  await expect(panel(page)).toBeVisible({ timeout: 5000 });
  await page.locator('.ed-find-q').fill('needle_marker_zz');
  await expect(page.locator('.ed-find-row').first()).toBeVisible({ timeout: 10000 });
  await page.locator('.ed-find-row').first().click();

  for (const p of [`${ROOT}/aa`, `${ROOT}/aa/bb`, `${ROOT}/aa/bb/cc`, `${ROOT}/aa/bb/cc/deep.txt`]) {
    await expect(page.locator(`.ed-tree .ed-row[data-path="${p}"]`)).toBeVisible({ timeout: 10000 });
  }
  // 연 파일은 선택으로 표시된다 — 어느 것을 열었는지가 보여야 한다.
  await expect(page.locator(`.ed-tree .ed-row[data-path="${ROOT}/aa/bb/cc/deep.txt"]`))
    .toHaveClass(/\bsel\b/);
});

// FR-EKB-6: 파일 검색(quick open)으로 열어도 같다 — 두 검색이 갈리면 한쪽만 고쳐진다.
test('파일 검색으로 연 파일도 탐색기에서 보인다', async ({ page, request }) => {
  await enter(page, request);
  await expect(page.locator(`.ed-tree .ed-row[data-path="${ROOT}/aa/bb/cc/deep.txt"]`)).toHaveCount(0);

  await page.keyboard.press('Control+p');
  await expect(panel(page)).toBeVisible({ timeout: 5000 });
  await page.locator('.ed-find-q').fill('deep.txt');
  await expect(page.locator('.ed-find-row').first()).toBeVisible({ timeout: 10000 });
  await page.locator('.ed-find-row').first().click();

  await expect(page.locator(`.ed-tree .ed-row[data-path="${ROOT}/aa/bb/cc/deep.txt"]`))
    .toBeVisible({ timeout: 10000 });
});
