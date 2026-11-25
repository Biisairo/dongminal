import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, openExplorerSide } from './fixtures';
import { tmpPath, realPath } from './osenv';

// PERF 3.4.7 — 편집기·탐색기 묶음 (D-30·D-31, perf/M3_DESIGN.md §3.4).
//
// 부팅은 editor 묶음(`b/<묶음>.js`)을 받지 않는다. Editor 창을 열거나 파일을 열면 그때 실리고 편집기·탐색기가 선다.
// 부팅 때 복원된 편집기 탭이 있으면 그 묶음만 바로 싣는다(D-31).

const ROOT = tmpPath('otter-edb-' + process.pid);
const fx = () => realPath(ROOT);
const BUNDLE = /\/b\/editor\.js\?/;

test.beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'one.txt'), 'ONE-0\n');
});

function countBundle(page: Page) {
  const seen = { n: 0 };
  page.on('request', (r) => { if (BUNDLE.test(r.url())) seen.n++ });
  return seen;
}

async function openWindow(page: Page) {
  await page.evaluate(async (p) => {
    await fetch('/api/editors/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
  }, fx());
  await expect.poll(async () => page.evaluate(async (p) => {
    const app = (window as any).app;
    await app.testing.edReconcile?.();
    await app.testing.edOpenWindow(p);
    return app.testing.edSearchRoot();
  }, fx()), { timeout: 15000 }).not.toBe('');
}

const openFile = (page: Page) =>
  page.evaluate((f) => (window as any).app.testing.edOpenFile(f), join(fx(), 'one.txt'));

const editorUp = (page: Page) => expect.poll(() => page.evaluate(() => {
  const app = (window as any).app;
  return [...app.fileEditors.values()].some((v: any) => String(v.filePath).endsWith('one.txt') && edT.has(v));
}), { timeout: 30000 }).toBe(true);

test('TC-EDB-1: 부팅은 editor 묶음을 받지 않고, 탐색기·파일을 열면 한 번 실려 선다', async ({ page }) => {
  const seen = countBundle(page);
  await waitForInit(page);
  expect(seen.n).toBe(0);
  expect(await page.evaluate(() => Screens.ready('editor'))).toBe(false);
  await openWindow(page);
  // 탐색기 사이드는 자리표시 뒤 묶음이 실리면 트리가 선다.
  await openExplorerSide(page);
  expect(seen.n).toBe(1);
  await openFile(page);
  await editorUp(page);
  await expect(page.locator('#area .cm-editor').first()).toBeVisible();
  expect(seen.n).toBe(1);
});

test('TC-EDB-2: 복원된 편집기 탭은 부팅 때 묶음을 싣고 선다', async ({ page }) => {
  await waitForInit(page);
  await openWindow(page);
  await openFile(page);
  await editorUp(page);
  await page.evaluate(() => (window as any).app.testing.save());
  const seen = countBundle(page);
  await page.reload();
  await editorUp(page);
  await expect(page.locator('#area .cm-editor').first()).toBeVisible();
  expect(seen.n).toBe(1);
});
