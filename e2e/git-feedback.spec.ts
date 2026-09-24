import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot } from './fixtures';
import { TMP, realPath } from './osenv';

// REPO_FIX 05 §3A-7 (F-9.1·9.3·9.4) — 브랜치·원격·stash 피드백.

let BASE = '';

const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
const out = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });

function makeRepo(name: string) {
  const d = j(BASE, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(j(d, 'a.txt'), 'one\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  git(d, 'branch', 'other');
  fs.appendFileSync(j(d, 'a.txt'), 'dirty\n');
  return realPath(d);
}

test.beforeAll(() => { BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-gfb-'))) });
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
  await page.waitForFunction(() => !!(window as any).app.gitPanel?.statusOf(), undefined, { timeout: 15000 });
}

test('F-9.1: Stash 후 checkout 이 거부되면 변경이 stash 에 남았다고 알린다', async ({ page, request }) => {
  const repo = makeRepo('fb1');
  await enter(page, request, repo);
  await expect.poll(() => page.evaluate(() => (window as any).app.gitPanel.isDirty()), { timeout: 10000 }).toBe(true);
  await page.route('**/api/git/checkout', async (route) => {
    await route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'git_failed', message: 'checkout-refused' }) });
  });
  await page.evaluate(() => {
    const w = window as any;
    const orig = w.GitDialog.open;
    w.GitDialog.open = (o: any) => (o && o.id === 'git-choice' ? Promise.resolve('stash') : orig.call(w.GitDialog, o));
  });
  await page.evaluate(() => (window as any).app.gitPanel.checkoutRef('other', {}));
  await expect(page.locator('.toast, #toast').filter({ hasText: 'stash' }).first()).toBeVisible({ timeout: 10000 });
  expect(out(repo, 'stash', 'list')).not.toBe('');
});

test('F-9.3: 확인창이 열리는 중·열린 뒤의 두 번째 요청은 창을 더 띄우지 않고 실행하지 않는다', async ({ page, request }) => {
  const repo = makeRepo('fb3');
  await enter(page, request, repo);
  const res = await page.evaluate(async () => {
    const w = window as any;
    w.GitConfirm._policy = null;
    let ran = 0;
    const o = () => ({ action: 'discard', title: 't', targets: ['x'], run: async () => { ran++; return { ok: true } } });
    const a = w.GitConfirm.open(o());
    const b = await w.GitConfirm.open(o());
    await new Promise((r) => setTimeout(r, 50));
    const count = document.querySelectorAll('#git-confirm').length;
    const c = await w.GitConfirm.open(o());
    const focused = !!(document.activeElement && document.activeElement.closest('#git-confirm'));
    (document.querySelector('#git-confirm .gc-cancel') as HTMLElement | null)?.click();
    await a;
    return { b, c, count, focused, ran };
  });
  expect(res.b).toBe(false);
  expect(res.c).toBe(false);
  expect(res.count).toBe(1);
  expect(res.focused).toBe(true);
  expect(res.ran).toBe(0);
});

test('F-9.4: 결과를 모르는 done 은 성공으로 보이지 않는다', async ({ page, request }) => {
  const repo = makeRepo('fb4');
  await enter(page, request, repo);
  await page.route('**/api/git/job/events**', async () => { /* 답하지 않는다 — 스트림이 열린 채 선다 */ });
  await page.evaluate((r: string) => {
    const jobs = (window as any).app.gitPanel._remote();
    const v = jobs.views.index;
    v._attach({ id: 'gone-job', kind: 'commit', repo: r, argv: ['commit'] });
    v._finish({ id: 'gone-job', done: true });
  }, repo);
  const state = page.locator('#area .ed-side .git-job[data-slot="index"] .git-job-state');
  await expect(state).toHaveText('결과 알 수 없음', { timeout: 5000 });
  await expect(page.locator('#area .ed-side .git-job[data-slot="index"] .git-job-note')).toContainText('결과를 알 수 없습니다');
});
