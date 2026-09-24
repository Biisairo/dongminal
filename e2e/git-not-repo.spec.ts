import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot } from './fixtures';
import { TMP, realPath } from './osenv';

// REPO_FIX 05 §3A-6 (F-6.2·6.3) — 비저장소 판정은 관측기(공유)의 것이고, 비저장소 루트에서
// 워치독이 폴링을 되살리지 않는다. git init 실패는 서버 사유를 보인다.

let BASE = '';

test.beforeAll(() => { BASE = realPath(fs.mkdtempSync(path.join(TMP, 'dm-gnr-'))) });
test.afterAll(() => { rmTree(BASE) });

async function enter(page: Page, request: APIRequestContext, root: string) {
  const r = await request.post('/api/editors/add', { data: { path: root } });
  expect(r.ok()).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, root);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
  await page.locator('.ed-side-tab[data-side="changes"]').click();
}

test('F-6.2: 비저장소 루트에서는 워치독이 status 폴링을 되살리지 않는다', async ({ page, request }) => {
  const root = path.join(BASE, 'plain1');
  fs.mkdirSync(root, { recursive: true });
  await enter(page, request, root);
  await expect(page.locator('#area .ed-side .git-init')).toBeVisible({ timeout: 15000 });
  const seen: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/git/status?') && r.url().includes('clientId=')) seen.push(r.url()) });
  // **예외 (`TEST-16`)**: 재는 것이 "일어나지 않음" 이다 — 워치독 회차(렌더 1초)와 기본
  // 주기를 여러 번 넘긴다. 되살아나면 이 사이에 나간다.
  await page.waitForTimeout(7000);
  expect(seen.length).toBe(0);
  const shared = await page.evaluate(() => {
    const p = (window as any).app.gitPanel;
    return p.obs._notRepo === true;
  });
  expect(shared).toBe(true);
});

test('F-6.3: git init 실패는 서버 사유를 보인다', async ({ page, request }) => {
  const root = path.join(BASE, 'plain2');
  fs.mkdirSync(root, { recursive: true });
  await enter(page, request, root);
  await expect(page.locator('#area .ed-side .git-init')).toBeVisible({ timeout: 15000 });
  await page.route('**/api/git/init', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'git_failed', message: 'init-boom-reason' }) });
  });
  await page.locator('#area .ed-side .git-init-btn').click();
  await page.locator('#git-confirm .gc-go').click();
  await expect(page.locator('#git-confirm')).toContainText('init-boom-reason', { timeout: 10000 });
  await page.locator('#git-confirm .gc-cancel').click();
  await expect(page.locator('#area .ed-side .git-init-err')).toContainText('init-boom-reason', { timeout: 5000 });
});
