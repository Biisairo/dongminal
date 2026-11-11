import * as fs from 'fs';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, rmTree, enterExplorer } from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

// UX_BATCH12_SRS §3.2a — Explorer 단축키가 선택 전체에 적용된다 (TC-EXK-1~3).
// 파괴적 조작이므로 테스트마다 `mkdtemp` 아래에 자기 루트를 짓는다.

let BASE = '';
const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);

/** `<root>/sub/inner.txt`, `<root>/a.txt`, `<root>/b.txt` */
function mkRoot(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'sub'), { recursive: true });
  w(j(d, 'sub', 'inner.txt'), 'I\n');
  w(j(d, 'a.txt'), 'A\n');
  w(j(d, 'b.txt'), 'B\n');
  return realPath(d);
}

test.beforeAll(() => { BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-exk-'))) });
test.afterAll(() => { rmTree(BASE) });

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const row = (page: Page, p: string) => page.locator(`.ed-tree .ed-row[data-path="${cssPath(p)}"]`);
const selRows = (page: Page) => page.locator('.ed-tree .ed-row.sel');
const tree = (page: Page) => page.evaluate(() => {
  const a = (window as any).app;
  const t = a.testing.edTree(a.testing.aw());
  return { sel: t._sel as string, set: [...t._selSet].sort() as string[] };
});
const onDisk = (fn: () => boolean) => expect.poll(fn, { timeout: 10000 });

/** a.txt·b.txt 를 고르고 포커스를 트리에 둔다. */
async function pickAB(page: Page, root: string) {
  await row(page, j(root, 'a.txt')).click();
  await row(page, j(root, 'b.txt')).click({ modifiers: [mod] });
  await expect(selRows(page)).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.ed-explorer'))).toBe(true);
}

test.describe('UX_BATCH12 — Explorer 단축키 (FR-EXK-1~6)', () => {
  test('TC-EXK-1a (FR-EXK-2·3): 두 파일 ⌘C → 폴더 ⌘V 로 둘 다 복사된다', async ({ page, request }) => {
    const R = mkRoot('k1a');
    await enterExplorer(page, request, R);
    await pickAB(page, R);
    await page.keyboard.press('ControlOrMeta+KeyC');
    const clip = await page.evaluate(() => (window as any).app.edClipGet());
    expect([...clip.paths].sort()).toEqual([j(R, 'a.txt'), j(R, 'b.txt')]);

    await row(page, j(R, 'sub')).click();
    await page.keyboard.press('ControlOrMeta+KeyV');
    await onDisk(() => fs.existsSync(j(R, 'sub', 'a.txt')) && fs.existsSync(j(R, 'sub', 'b.txt'))).toBe(true);
    expect(fs.existsSync(j(R, 'a.txt')) && fs.existsSync(j(R, 'b.txt')), '복사인데 원본이 사라졌다').toBe(true);
  });

  test('TC-EXK-1b (FR-EXK-2·3): 두 파일 ⌘X → 폴더 ⌘V 로 둘 다 옮겨지고 클립보드가 빈다', async ({ page, request }) => {
    const R = mkRoot('k1b');
    await enterExplorer(page, request, R);
    await pickAB(page, R);
    await page.keyboard.press('ControlOrMeta+KeyX');
    const clip = await page.evaluate(() => (window as any).app.edClipGet());
    expect(clip && clip.move).toBe(true);
    expect(clip.paths.length).toBe(2);

    await row(page, j(R, 'sub')).click();
    await page.keyboard.press('ControlOrMeta+KeyV');
    await onDisk(() => fs.existsSync(j(R, 'sub', 'a.txt')) && fs.existsSync(j(R, 'sub', 'b.txt'))).toBe(true);
    await onDisk(() => fs.existsSync(j(R, 'a.txt')) || fs.existsSync(j(R, 'b.txt'))).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any).app.edClipGet())).toBe(null);
  });

  test('TC-EXK-2a (FR-EXK-4): 두 파일 Delete → 확인 뒤 둘 다 지워진다', async ({ page, request }) => {
    const R = mkRoot('k2a');
    await enterExplorer(page, request, R);
    await pickAB(page, R);
    await page.keyboard.press('Delete');
    await expect(page.locator('.ed-confirm .confirm-msg')).toContainText('2', { timeout: 10000 });
    await page.locator('.ed-confirm .confirm-ok').click();
    await onDisk(() => fs.existsSync(j(R, 'a.txt')) || fs.existsSync(j(R, 'b.txt'))).toBe(false);
  });

  test('TC-EXK-2b (FR-EXK-4): ⌘+Backspace 도 선택 전체를 지운다 (macOS)', async ({ page, request }) => {
    test.skip(process.platform !== 'darwin', 'macOS 관용 키');
    const R = mkRoot('k2b');
    await enterExplorer(page, request, R);
    await pickAB(page, R);
    await page.keyboard.press('Meta+Backspace');
    await expect(page.locator('.ed-confirm .confirm-msg')).toContainText('2', { timeout: 10000 });
    await page.locator('.ed-confirm .confirm-cancel').click();
    expect(fs.existsSync(j(R, 'a.txt')), '취소인데 지워졌다').toBe(true);
  });

  test('TC-EXK-2c (FR-EXK-6): 루트만 고르면 Delete·⌘X·⌘C 가 아무 일도 하지 않는다', async ({ page, request }) => {
    const R = mkRoot('k2c');
    await enterExplorer(page, request, R);
    await page.locator('.ed-explorer .ed-head-name').click();
    await expect.poll(async () => (await tree(page)).sel).toBe(R);
    await page.keyboard.press('Delete');
    await page.keyboard.press('ControlOrMeta+KeyX');
    await page.keyboard.press('ControlOrMeta+KeyC');
    await expect(page.locator('.ed-confirm')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).app.edClipGet())).toBe(null);
  });

  test('TC-EXK-3 (FR-EXK-5): ⌘A 는 보이는 행 전부, Escape 는 앵커 하나', async ({ page, request }) => {
    const R = mkRoot('k3');
    await enterExplorer(page, request, R);
    await row(page, j(R, 'sub')).click();
    await expect(row(page, j(R, 'sub', 'inner.txt'))).toBeVisible({ timeout: 10000 });
    await row(page, j(R, 'a.txt')).click();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.ed-explorer'))).toBe(true);

    await page.keyboard.press('ControlOrMeta+KeyA');
    await expect(selRows(page)).toHaveCount(4);
    expect((await tree(page)).set).toEqual([j(R, 'a.txt'), j(R, 'b.txt'), j(R, 'sub'), j(R, 'sub', 'inner.txt')].sort());

    await page.keyboard.press('Escape');
    await expect(selRows(page)).toHaveCount(1);
    expect(await tree(page)).toEqual({ sel: j(R, 'a.txt'), set: [j(R, 'a.txt')] });
  });
});

// UX_BATCH12_SRS FR-EXM-1 (R11): 빈 여백에서 끌어 사각형으로 고른다 (TC-EXM-1).
test.describe('UX_BATCH12 — 사각형 선택 (FR-EXM-1)', () => {
  /** 마지막 행 아래 빈 여백의 한 점과, 행 가운데의 y. */
  async function geo(page: Page, p: string) {
    const list = (await page.locator('.ed-explorer .ed-tree').boundingBox())!;
    const last = (await page.locator('.ed-tree .ed-row').last().boundingBox())!;
    const r = (await row(page, p).boundingBox())!;
    expect(list.y + list.height - (last.y + last.height), '마지막 행 아래 여백이 없다').toBeGreaterThan(20);
    return { x: list.x + 20, blankY: list.y + list.height - 8, rowY: r.y + r.height / 2 };
  }

  test('TC-EXM-1a: 빈 여백에서 위로 끌면 덮인 세 행이 선택되고 상자는 놓으면 사라진다', async ({ page, request }) => {
    const R = mkRoot('m1a');
    await enterExplorer(page, request, R);
    const g = await geo(page, j(R, 'sub'));
    await page.mouse.move(g.x, g.blankY);
    await page.mouse.down();
    await page.mouse.move(g.x + 10, (g.blankY + g.rowY) / 2, { steps: 4 });
    await expect(page.locator('.ed-explorer .ed-marquee')).toBeVisible();
    await page.mouse.move(g.x + 10, g.rowY, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('.ed-explorer .ed-marquee')).toHaveCount(0);
    expect((await tree(page)).set).toEqual([j(R, 'a.txt'), j(R, 'b.txt'), j(R, 'sub')].sort());
    expect((await tree(page)).sel).toBe(j(R, 'sub'));
  });

  test('TC-EXM-1b: Cmd 를 누른 채 끌면 지금 선택에 더한다', async ({ page, request }) => {
    const R = mkRoot('m1b');
    await enterExplorer(page, request, R);
    await row(page, j(R, 'sub')).click();
    await row(page, j(R, 'sub')).click();
    await expect(row(page, j(R, 'sub', 'inner.txt'))).toHaveCount(0);
    await expect.poll(async () => (await tree(page)).set).toEqual([j(R, 'sub')]);
    const g = await geo(page, j(R, 'b.txt'));
    await page.keyboard.down(mod);
    await page.mouse.move(g.x, g.blankY);
    await page.mouse.down();
    await page.mouse.move(g.x + 10, g.rowY, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up(mod);
    expect((await tree(page)).set).toEqual([j(R, 'b.txt'), j(R, 'sub')].sort());
  });

  test('TC-EXM-1c: 4px 미만으로 움직이면 빈 여백 클릭과 같다', async ({ page, request }) => {
    const R = mkRoot('m1c');
    await enterExplorer(page, request, R);
    await pickAB(page, R);
    const g = await geo(page, j(R, 'b.txt'));
    await page.mouse.move(g.x, g.blankY);
    await page.mouse.down();
    await page.mouse.move(g.x + 2, g.blankY - 1);
    await page.mouse.up();
    await expect.poll(async () => (await tree(page)).sel).toBe(R);
    expect((await tree(page)).set).toEqual([]);
  });
});
