import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled, rmTree, switchToEditorRoot } from './fixtures';
import { ED_SEL } from './editor';
import { TMP, realPath, cssPath } from './osenv';

// PERF 3.4.12.7 — cm 묶음(CM 공용 층·lsp-client·lsp-paths, D-44).
//
// 부팅은 cm 묶음을 받지 않는다. `loadCodeMirror()` 가 CM vendor 와 나란히 싣고, `editor`·`git` 은 needs 로 먼저 싣는다.
// 그래서 Diff 를 먼저 열든 편집기를 먼저 열든 cm 은 한 번만 받는다.

const CM_JS = /\/b\/cm\.js(\?|$)/;

let BASE = '';
let REPO = '';
const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'otter-cmb-')));
  const d = j(BASE, 'repo');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(j(d, 'a.txt'), 'one\nfind-me\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  fs.appendFileSync(j(d, 'a.txt'), 'two\n');
  REPO = realPath(d);
});
test.afterAll(() => { rmTree(BASE) });

function countCm(page: Page) {
  const seen = { n: 0 };
  page.on('request', (r) => { if (CM_JS.test(r.url())) seen.n++ });
  return seen;
}

async function enterRepo(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: REPO } });
  expect(r.ok()).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, REPO);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
}

const editorUp = (page: Page) => page.waitForFunction(() => {
  const v = (window as any).app.testing.edActiveEditor();
  return !!v && edT.has(v) && v.el.offsetParent !== null;
}, undefined, { timeout: 30000 });

test('TC-CMB-1: 부팅은 cm 묶음을 받지 않는다', async ({ page }) => {
  const seen = countCm(page);
  await waitForInit(page);
  await waitSettled(page);
  expect(seen.n).toBe(0);
  expect(await page.evaluate(() => {
    const w = window as any;
    return [Screens.ready('cm'), typeof w.EdDirtyDiff, typeof w.LspClient, typeof w.edCmExtensions];
  })).toEqual([false, 'undefined', 'undefined', 'undefined']);
});

test('TC-CMB-2: Diff 를 먼저 열면 cm 을 한 번 받고, 편집기를 열어도 다시 받지 않는다 — 변경 표시·찾기가 선다', async ({ page, request }) => {
  const seen = countCm(page);
  await enterRepo(page, request);
  await page.locator('.ed-side-tab[data-side="changes"]').click();
  const row = page.locator(`#area .ed-side .git-group[data-group="working"] .git-file[data-path="${cssPath('a.txt')}"]`);
  await row.click();
  await expect(page.locator('#area .ed-area .pn-tab[data-git-view="diff"]')).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator(`#area .ed-area .git-diff ${ED_SEL.diffModified}`)).toBeVisible({ timeout: 20000 });
  expect(seen.n).toBe(1);
  expect(await page.evaluate(() => [Screens.ready('cm'), Screens.ready('editor')])).toEqual([true, false]);

  const file = j(REPO, 'a.txt');
  await page.evaluate((f) => (window as any).app.testing.edOpenFile(f, { pin: true }), file);
  await editorUp(page);
  expect(await page.evaluate(() => Screens.ready('editor'))).toBe(true);
  expect(seen.n).toBe(1);

  // 변경 표시(EDITOR_DIRTY_DIFF_SRS): 기준(index) 대비 셋째 줄이 추가다.
  await page.waitForFunction((f) => {
    const dd = (window as any).app.testing.edDirtyDiff(f);
    return !!(dd && dd.settled);
  }, file, { timeout: 20000 });
  await expect.poll(() => page.evaluate(() =>
    edT.lineMarks(edT.of((window as any).app.testing.edActiveEditor()), '^fe-dd-').length), { timeout: 10000 })
    .toBeGreaterThan(0);

  // 찾기 패널(EDITOR_FIND_PANEL_SRS).
  await page.evaluate(() => edT.focus(edT.of((window as any).app.testing.edActiveEditor())));
  await page.keyboard.press('Control+f');
  await expect(page.locator('.fe-find.vis:visible')).toBeVisible({ timeout: 5000 });
  await page.keyboard.type('find-me');
  await expect(page.locator('.fe-find.vis:visible .fe-find-count')).toContainText('1', { timeout: 5000 });
  expect(seen.n).toBe(1);
});

test('TC-CMB-3: 복원된 편집기 탭은 cm 이 실릴 때까지 기다린 뒤 선다', async ({ page, request }) => {
  await enterRepo(page, request);
  await page.evaluate((f) => (window as any).app.testing.edOpenFile(f, { pin: true }), j(REPO, 'a.txt'));
  await editorUp(page);
  await waitSettled(page);
  await page.evaluate(() => (window as any).app.testing.save());

  const seen = countCm(page);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r });
  await page.route(CM_JS, async (route) => { await held; await route.continue() });
  await page.reload();
  await expect.poll(() => seen.n, { timeout: 15000 }).toBe(1);
  expect(await page.evaluate(() => [Screens.ready('cm'), Screens.ready('editor')])).toEqual([false, false]);
  await expect(page.locator(`.file-editor ${ED_SEL.surface}`)).toHaveCount(0);
  release();
  await editorUp(page);
  expect(await page.evaluate(() => [Screens.ready('mdlib'), Screens.ready('cm'), Screens.ready('editor')]))
    .toEqual([true, true, true]);
  expect(seen.n).toBe(1);
});
