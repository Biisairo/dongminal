import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitShellReady, waitSettled, rmTree, enterDocRoot, openDocFile } from './fixtures';
import { TMP, realPath, echoCmd } from './osenv';

// PERF 3.4.12.2 — mdlib 묶음(markdown-it·DOMPurify, D-43).
//
// 부팅은 mdlib 를 받지 않는다. 터미널 맨 도메인 링크는 첫 hover(provideLinks)에서 묶음을 기다린 뒤 판정하고,
// 편집기는 loadCodeMirror 가 CM 과 나란히, 문서 렌더는 needs 로 먼저 싣는다.

const BUNDLE = /\/b\/mdlib\.js(\?|$)/;
const VENDOR = /\/vendor\/(markdown-it|purify)\.js/;

let BASE = '';
test.beforeAll(() => { BASE = realPath(mkdtempSync(join(TMP, 'otter-mdl-'))) });
test.afterAll(() => { rmTree(BASE) });

function countBundle(page: Page) {
  const seen = { n: 0, vendor: 0 };
  page.on('request', (r) => {
    if (BUNDLE.test(r.url())) seen.n++;
    if (VENDOR.test(r.url())) seen.vendor++;
  });
  return seen;
}

test('TC-MDL-1: 부팅은 mdlib 를 받지 않고, 터미널 첫 hover 가 묶음을 기다린 뒤 맨 도메인을 링크로 낸다', async ({ page }) => {
  const seen = countBundle(page);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r });
  await page.route(BUNDLE, async (route) => { await held; await route.continue() });
  await waitForInit(page);
  await waitShellReady(page);
  expect(seen).toEqual({ n: 0, vendor: 0 });
  expect(await page.evaluate(() => [Screens.ready('mdlib'), typeof (window as any).markdownit, typeof (window as any).DOMPurify]))
    .toEqual([false, 'undefined', 'undefined']);

  await page.click('#area .pn.focused .xterm-screen');
  await page.keyboard.type(echoCmd('see naver.com now'));
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const app = (window as any).app;
    const pane = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis')) as any;
    const b = pane.term.buffer.active;
    for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === 'see naver.com now') return true;
    return false;
  }), { timeout: 15000 }).toBe(true);

  // 묶음을 붙잡은 동안 판정은 기다린다.
  await page.evaluate(() => {
    const w = window as any;
    const app = w.app;
    const pane = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis')) as any;
    const b = pane.term.buffer.active;
    let y = -1;
    for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === 'see naver.com now') y = i + 1;
    w.__mdlLinks = null;
    pane._bareLinks.provideLinks(y, (l: any) => { w.__mdlLinks = (l || []).map((x: any) => x.text) });
    pane._bareLinks.provideLinks(y, () => {});
  });
  await expect.poll(() => seen.n).toBe(1);
  expect(await page.evaluate(() => (window as any).__mdlLinks)).toBe(null);
  release();
  await expect.poll(() => page.evaluate(() => (window as any).__mdlLinks), { timeout: 15000 }).toEqual(['naver.com']);
  expect(await page.evaluate(() => Screens.ready('mdlib'))).toBe(true);
  expect(seen).toEqual({ n: 1, vendor: 0 });
});

test('TC-MDL-2: 편집기를 처음 열면 mdlib 가 함께 실리고, 수정키+클릭이 URL 을 클릭 안에서 연다', async ({ page, request }) => {
  await page.route('**/api/lsp/status', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ servers: [] }),
  }));
  const seen = countBundle(page);
  const root = await enterDocRoot(page, request, BASE, 'url');
  // PERF 3.4.12.7: Repo 창의 사이드(git·editor 묶음)가 needs 로 cm → mdlib 를 먼저 실을 수 있다 — 받아도 한 번이다.
  expect(seen.n).toBeLessThanOrEqual(1);
  await openDocFile(page, root);
  expect(seen.n).toBe(1);
  const url = 'https://example.com/x';
  await page.evaluate((t) => {
    const w = window as any;
    const v = [...w.app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md');
    edT.insert(edT.of(v), 1, 1, t);
    edT.revealLine(edT.of(v), 1);
    w.edLinkOpened = [];
    w.open = (u: string) => { w.edLinkOpened.push(u); return null };
  }, `see ${url} here\n`);
  const at = await page.evaluate(() => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md');
    const p = edT.coords(edT.of(v), 1, 10);
    return { x: p.left + 2, y: p.top + p.height / 2 };
  });
  const mod = (await page.evaluate(() => (0, eval)('IS_MAC'))) ? 'Meta' : 'Control';
  await page.keyboard.down(mod);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up(mod);
  await expect.poll(() => page.evaluate(() => (window as any).edLinkOpened)).toEqual([url]);
  expect(seen).toEqual({ n: 1, vendor: 0 });
});

test('TC-MDL-3: 복원된 렌더 탭은 mdlib 를 먼저 싣고 그려진다', async ({ page, request }) => {
  const root = await enterDocRoot(page, request, BASE, 'render');
  writeFileSync(join(root, 'doc.md'), '# 복원 제목\n\n본문 <script>window.__mdlPwned=1</script>\n');
  await openDocFile(page, root);
  await page.locator('.file-editor.vis .fe-render').click();
  await expect(page.locator('.doc-render.vis .dr-body h1')).toHaveText('복원 제목', { timeout: 15000 });
  await waitSettled(page);
  const seen = countBundle(page);
  await page.reload();
  await expect(page.locator('.doc-render.vis .dr-body h1')).toHaveText('복원 제목', { timeout: 25000 });
  expect(await page.evaluate(() => [Screens.ready('mdlib'), Screens.ready('docrender'), (window as any).__mdlPwned]))
    .toEqual([true, true, undefined]);
  expect(seen).toEqual({ n: 1, vendor: 0 });
});
