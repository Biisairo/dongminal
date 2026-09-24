import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot } from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

// REPO_FIX 05 §3A-4 (F-3) — 창 루트가 저장소 하위 폴더여도 경로는 저장소 최상위 기준이다.
//
// status 의 경로는 저장소 최상위 기준이다. 창 루트(`src`)에 그대로 이으면
// `…/src/src/a.txt` 가 되어 Diff 저장·파일 열기가 없는 파일을 가리킨다(#6).

let BASE = '';
let REPO = '';
let SUB = '';

const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-gsr-')));
  const d = j(BASE, 'toprepo');
  fs.mkdirSync(j(d, 'src'), { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(j(d, 'src', 'a.txt'), 'one\n');
  fs.writeFileSync(j(d, 'src', 'b.txt'), 'one\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  fs.appendFileSync(j(d, 'src', 'a.txt'), 'two\n');
  fs.appendFileSync(j(d, 'src', 'b.txt'), 'two\n');
  fs.writeFileSync(j(d, 'src', 'new.txt'), 'fresh\n');
  REPO = realPath(d);
  SUB = j(REPO, 'src');
});
test.afterAll(() => { rmTree(BASE) });

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: SUB } });
  expect(r.ok()).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, SUB);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
  await page.locator('.ed-side-tab[data-side="changes"]').click();
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const row = (page: Page, p: string) =>
  page.locator(`#area .ed-side .git-group[data-group="working"] .git-file[data-path="${cssPath(p)}"]`);

test('F-3.1: 하위 폴더 루트에서 Diff 의 저장 대상은 저장소 최상위 기준 경로다', async ({ page, request }) => {
  await enter(page, request);
  await row(page, 'src/a.txt').click();
  await page.waitForFunction((abs: string) => (window as any).app.gitPanel._diffView?._editTarget === abs,
    j(SUB, 'a.txt'), { timeout: 20000 });
  await page.evaluate(() => {
    const m = (window as any).app.gitPanel._diffView._mod;
    const end = m.getFullModelRange().getEndPosition();
    m.applyEdits([{ range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: 'three\n' }]);
  });
  expect(await page.evaluate(() => (window as any).app.gitPanel._diffView.save())).toBe(true);
  expect(fs.readFileSync(j(SUB, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
  expect(fs.existsSync(j(SUB, 'src'))).toBe(false);
});

test('F-3.1: 새 파일 행은 저장소 최상위 기준 경로로 편집기에 열린다', async ({ page, request }) => {
  await enter(page, request);
  await row(page, 'src/new.txt').click();
  await page.waitForFunction((abs: string) => !!(window as any).app.testing.edDocs?.get(abs)?.model,
    j(SUB, 'new.txt'), { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).app.gitPanel.absPath({ path: 'src/b.txt' }))).toBe(j(SUB, 'b.txt'));
});

test('F-3.3: 머리의 저장소 이름은 상위 저장소 이름이다', async ({ page, request }) => {
  await enter(page, request);
  await expect(page.locator('#area .ed-side .git-head-repo')).toHaveText('toprepo', { timeout: 10000 });
});

test('F-3.2: Console 은 하위 폴더 루트에서도 기록을 보인다', async ({ page, request }) => {
  await enter(page, request);
  const r = await request.post('/api/git/stage', { data: { repo: SUB, paths: ['src/b.txt'] } });
  expect(r.ok()).toBeTruthy();
  await page.evaluate(() => (window as any).app.gitPanel.openView('console'));
  await expect(page.locator('#area .git-con-row').first()).toBeVisible({ timeout: 15000 });
});
