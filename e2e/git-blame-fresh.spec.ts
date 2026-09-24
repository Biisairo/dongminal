import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot } from './fixtures';
import { TMP, realPath } from './osenv';

// REPO_FIX 05 §3A-6 (F-5.2) — 작업 트리 파일의 Blame 은 저장·git_changed·새로고침 때
// 다시 받는다. 조회 실패는 사유와 재시도 버튼이다.

let BASE = '';
let REPO = '';

const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-gbf-')));
  const d = j(BASE, 'repo');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(j(d, 'a.txt'), 'one\n');
  fs.writeFileSync(j(d, 'b.txt'), 'one\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  fs.appendFileSync(j(d, 'a.txt'), 'two\n');
  fs.appendFileSync(j(d, 'b.txt'), 'two\n');
  REPO = realPath(d);
});
test.afterAll(() => { rmTree(BASE) });

async function enter(page: Page, request: APIRequestContext) {
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
  await page.locator('.ed-side-tab[data-side="changes"]').click();
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const blameRows = (page: Page) => page.locator('#area .ed-area .git-blame .git-blame-row');
const openBlame = (page: Page, p: string) => page.evaluate((f: string) =>
  (window as any).app.gitPanel.openBlame({ group: 'working', path: f, origPath: '' }), p);

test('F-5.2: 작업 트리 Blame 은 새로고침 때 다시 받는다', async ({ page, request }) => {
  await enter(page, request);
  await openBlame(page, 'a.txt');
  await expect(blameRows(page)).toHaveCount(2, { timeout: 15000 });
  fs.appendFileSync(j(REPO, 'a.txt'), 'three\n');
  await page.evaluate(() => (window as any).app.gitPanel.refresh());
  await expect(blameRows(page)).toHaveCount(3, { timeout: 10000 });
});

test('F-5.2: Blame 조회 실패는 사유와 재시도다', async ({ page, request }) => {
  await enter(page, request);
  let fail = true;
  await page.route('**/api/git/blame?**', async (route) => {
    if (fail) {
      await route.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'git_failed', message: 'boom' }) });
      return;
    }
    await route.continue();
  });
  await openBlame(page, 'b.txt');
  const retry = page.locator('#area .ed-area .git-blame .git-blame-retry');
  await expect(retry).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#area .ed-area .git-blame .git-blame-note')).toContainText('boom');
  fail = false;
  await retry.click();
  await expect(blameRows(page)).toHaveCount(2, { timeout: 10000 });
});
