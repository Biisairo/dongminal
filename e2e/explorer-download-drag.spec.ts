import * as fs from 'fs';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, rmTree, enterExplorer } from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

// UX_BATCH12_SRS §3.2b — 행을 끌 때 `DownloadURL` 을 싣고(TC-EXD-1·2), 메뉴의 다운로드도
// 여러 항목이면 zip 하나다(TC-EXD-2). 바깥(Finder) 놓기는 OS 몫이라 실을 값만 잰다.

let BASE = '';
const j = (...p: string[]) => path.join(...p);

/** `<root>/sub/inner.txt`, `<root>/a.txt`, `<root>/b.txt`, `<root>/ln -> a.txt` */
function mkRoot(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'sub'), { recursive: true });
  fs.writeFileSync(j(d, 'sub', 'inner.txt'), 'I\n');
  fs.writeFileSync(j(d, 'a.txt'), 'A\n');
  fs.writeFileSync(j(d, 'b.txt'), 'B\n');
  fs.symlinkSync('a.txt', j(d, 'ln'));
  return realPath(d);
}

test.beforeAll(() => { BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-exd-'))) });
test.afterAll(() => { rmTree(BASE) });

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const row = (page: Page, p: string) => page.locator(`.ed-tree .ed-row[data-path="${cssPath(p)}"]`);

/**
 * 그 행에서 `dragstart` 를 일으키고 실린 `DownloadURL` 을 읽는다. 합성 `DataTransfer` 는
 * `effectAllowed` 를 바꾸지 못하므로(언제나 `none`) 그 값은 재지 않는다 — 트리 안 옮기기는
 * 실제 끌기(TC-EXD-1c)가 잰다.
 */
function dragOut(page: Page, p: string) {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement;
    const dt = new DataTransfer();
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const out = { url: dt.getData('DownloadURL') };
    el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return out;
  }, `.ed-tree .ed-row[data-path="${cssPath(p)}"]`);
}

/** `<mime>:<이름>:<절대 URL>` 을 셋으로 가른다 (URL 안의 `:` 는 그대로 둔다). */
function parse(v: string) {
  const a = v.indexOf(':');
  const b = v.indexOf(':', a + 1);
  return { mime: v.slice(0, a), name: v.slice(a + 1, b), url: new URL(v.slice(b + 1)) };
}

test.describe('UX_BATCH12 — Finder 로 끌어 내려받기 (FR-EXD-1~7)', () => {
  test('TC-EXD-1a (FR-EXD-1·2): 파일 행은 파일 URL, 폴더 행은 zip URL 을 싣는다', async ({ page, request }) => {
    const R = mkRoot('d1a');
    await enterExplorer(page, request, R);

    const f = await dragOut(page, j(R, 'a.txt'));
    const fp = parse(f.url);
    expect(fp.name).toBe('a.txt');
    expect(fp.url.origin).toBe(new URL(page.url()).origin);
    expect(fp.url.pathname).toBe('/api/fs/download');
    expect(fp.url.searchParams.get('path')).toBe(j(R, 'a.txt'));

    const d = parse((await dragOut(page, j(R, 'sub'))).url);
    expect(d.mime).toBe('application/zip');
    expect(d.name).toBe('sub.zip');
    expect(d.url.pathname).toBe('/api/fs/download-dir');
    expect(d.url.searchParams.get('path')).toBe(j(R, 'sub'));
  });

  test('TC-EXD-1b (FR-EXD-5): 링크 행은 DownloadURL 을 싣지 않는다', async ({ page, request }) => {
    const R = mkRoot('d1b');
    await enterExplorer(page, request, R);
    await expect(row(page, j(R, 'ln'))).toHaveAttribute('data-kind', 'link');
    expect((await dragOut(page, j(R, 'ln'))).url).toBe('');
  });

  test('TC-EXD-1c (FR-EXD-1·R-6): 트리 안 폴더에 놓으면 그대로 옮겨진다', async ({ page, request }) => {
    const R = mkRoot('d1c');
    await enterExplorer(page, request, R);
    await row(page, j(R, 'b.txt')).dragTo(row(page, j(R, 'sub')));
    await expect.poll(() => fs.existsSync(j(R, 'sub', 'b.txt')), { timeout: 10000 }).toBe(true);
    expect(fs.existsSync(j(R, 'b.txt')), '옮기기가 아니라 복사가 됐다').toBe(false);
  });

  test('TC-EXD-2a (FR-EXD-3): 두 행을 고른 뒤 끌면 download-many URL 이 두 경로를 싣는다', async ({ page, request }) => {
    const R = mkRoot('d2a');
    await enterExplorer(page, request, R);
    await row(page, j(R, 'a.txt')).click();
    await row(page, j(R, 'b.txt')).click({ modifiers: [mod] });
    const m = parse((await dragOut(page, j(R, 'b.txt'))).url);
    expect(m.mime).toBe('application/zip');
    expect(m.name).toBe(`${path.basename(R)}-2-items.zip`);
    expect(m.url.pathname).toBe('/api/fs/download-many');
    expect(m.url.searchParams.get('root')).toBe(R);
    expect(m.url.searchParams.getAll('path')).toEqual([j(R, 'a.txt'), j(R, 'b.txt')]);
  });

  test('TC-EXD-2b (FR-EXD-7): 두 행을 고른 뒤 메뉴의 다운로드는 zip 하나다', async ({ page, request }) => {
    const R = mkRoot('d2b');
    await enterExplorer(page, request, R);
    await row(page, j(R, 'a.txt')).click();
    await row(page, j(R, 'b.txt')).click({ modifiers: [mod] });
    await row(page, j(R, 'b.txt')).click({ button: 'right' });
    const wait = page.waitForEvent('download');
    await page.locator('.git-menu .git-menu-item[data-id="download"]').click();
    const dl = await wait;
    expect(dl.suggestedFilename()).toBe(`${path.basename(R)}-2-items.zip`);
    const u = new URL(dl.url());
    expect(u.pathname).toBe('/api/fs/download-many');
    expect(u.searchParams.getAll('path')).toEqual([j(R, 'a.txt'), j(R, 'b.txt')]);
  });
});
