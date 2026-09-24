import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot } from './fixtures';
import { TMP, realPath } from './osenv';

// REPO_FIX 05 §3A-6 (F-7) — 커밋 입력.
//
// draft 와 amend 메시지는 다른 슬롯이다(amend 는 저장하지 않는다). amend 메시지 조회 중의
// 입력은 덮지 않는다. 커밋 잡의 뒷정리는 시작한 저장소 키로 한다. 저장소 전환은 대기 중인
// draft 저장을 즉시 반영한다. preflight 는 커밋 직전·HEAD 변화 때 다시 받는다. Reset
// soft/mixed 는 실패하면 닫지 않는다.

let BASE = '';

const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
const lastMsg = (d: string) => execFileSync('git', ['-C', d, 'log', '-1', '--pretty=%B'], { encoding: 'utf8' }).trim();

function makeRepo(name: string) {
  const d = j(BASE, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(j(d, 'a.txt'), 'one\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'first message');
  fs.appendFileSync(j(d, 'a.txt'), 'two\n');
  git(d, 'add', 'a.txt');
  return realPath(d);
}

test.beforeAll(() => { BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-gcs-'))) });
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
  await expect(msg(page)).toBeEnabled({ timeout: 15000 });
}

const msg = (page: Page) => page.locator('#area .ed-side .git-commit .git-commit-msg');
const amend = (page: Page) => page.locator('#area .ed-side .git-commit .git-commit-amend input');
const draftOf = (page: Page, repo: string) => page.evaluate((r: string) =>
  (((window as any).app.ws.git || {}).drafts || {})[r], repo);

test('C1 (F-7.2): amend 중 편집은 draft 를 덮지 않고, 해제하면 원 draft 가 돌아온다', async ({ page, request }) => {
  const repo = makeRepo('c1');
  await enter(page, request, repo);
  await msg(page).fill('my draft');
  await expect.poll(() => draftOf(page, repo), { timeout: 5000 }).toBe('my draft');
  await amend(page).check();
  await expect(msg(page)).toHaveValue('first message', { timeout: 10000 });
  await msg(page).fill('amended text');
  await expect.poll(() => page.evaluate(() => (window as any).app.ws.git.drafts), { timeout: 3000 })
    .toMatchObject({ [repo]: 'my draft' });
  // **예외 (`TEST-16`)**: 재는 것이 "일어나지 않음" 이다 — draft 저장 디바운스를 넘겨도
  // draft 는 그대로다.
  await page.waitForTimeout(800);
  expect(await draftOf(page, repo)).toBe('my draft');
  await amend(page).uncheck();
  await expect(msg(page)).toHaveValue('my draft');
});

test('C2 (F-7.2): amend 메시지는 일시적이다 — 새로고침하면 amend 가 풀리고 draft 가 보인다', async ({ page, request }) => {
  const repo = makeRepo('c2');
  await enter(page, request, repo);
  await msg(page).fill('keep me');
  await expect.poll(() => draftOf(page, repo), { timeout: 5000 }).toBe('keep me');
  await amend(page).check();
  await expect(msg(page)).toHaveValue('first message', { timeout: 10000 });
  await msg(page).fill('temp amend');
  // **예외 (`TEST-16`)**: 재는 것이 "일어나지 않음" 이다 — 디바운스가 amend 입력을 draft 로
  // 저장하지 않는다.
  await page.waitForTimeout(800);
  await page.evaluate(() => (window as any).app.testing.save());
  await page.reload();
  await expect(msg(page)).toBeEnabled({ timeout: 15000 });
  await expect(msg(page)).toHaveValue('keep me');
  await expect(amend(page)).not.toBeChecked();
});

test('C3 (F-7.3): amend 메시지 조회 중에 친 입력은 도착한 메시지로 덮지 않는다', async ({ page, request }) => {
  const repo = makeRepo('c3');
  await enter(page, request, repo);
  await msg(page).fill('base');
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r });
  let held = false;
  await page.route('**/api/git/commit?**', async (route) => {
    if (route.request().method() === 'GET') { held = true; await gate }
    await route.continue();
  });
  await amend(page).check();
  await expect.poll(() => held).toBe(true);
  await msg(page).press('End');
  await msg(page).pressSequentially(' typed');
  release();
  await page.waitForResponse((r) => r.url().includes('/api/git/commit?') && r.request().method() === 'GET');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await expect(msg(page)).toHaveValue('base typed');
});

test('C4 (F-7.4): 커밋 잡이 끝나기 전에 화면이 다른 저장소로 옮겨도, 이긴 커밋의 draft 는 그 저장소에서 지워진다', async ({ page, request }) => {
  const repo = makeRepo('c4');
  const other = makeRepo('c4-other');
  await enter(page, request, repo);
  await msg(page).fill('commit from c4');
  await expect.poll(() => draftOf(page, repo), { timeout: 5000 }).toBe('commit from c4');
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r });
  let posted = false;
  await page.route('**/api/git/commit', async (route) => {
    if (route.request().method() === 'POST') { posted = true; await gate }
    await route.continue();
  });
  await page.evaluate(() => { (window as any).__c = (window as any).app.gitPanel._commit()._commit() });
  await expect.poll(() => posted, { timeout: 10000 }).toBe(true);
  // 잡이 끝나기 전에 입력 영역이 다른 저장소를 보게 한다(옛 Git 창의 리포 전환과 같은 길).
  await page.evaluate((o: string) => {
    const c = (window as any).app.gitPanel._commit();
    (window as any).app.ws.git.drafts[o] = 'other draft';
    c._reset(o);
  }, other);
  release();
  await page.evaluate(() => (window as any).__c);
  await expect.poll(() => lastMsg(repo), { timeout: 15000 }).toBe('commit from c4');
  await expect.poll(() => draftOf(page, repo), { timeout: 5000 }).toBeUndefined();
  expect(await draftOf(page, other)).toBe('other draft');
});

test('C5 (F-7.5): 저장소 전환은 대기 중인 draft 저장을 버리지 않고 곧바로 반영한다', async ({ page, request }) => {
  const repo = makeRepo('c5');
  const other = makeRepo('c5-other');
  await enter(page, request, repo);
  await page.evaluate((o: string) => {
    const c = (window as any).app.gitPanel._commit();
    c._msg.value = 'typed just now';
    c._input();
    c._reset(o);
  }, other);
  expect(await draftOf(page, repo)).toBe('typed just now');
});

test('C6 (F-7.1): preflight 는 커밋 직전에 다시 받는다', async ({ page, request }) => {
  const repo = makeRepo('c6');
  await enter(page, request, repo);
  await msg(page).fill('c6 commit');
  const order: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/git/preflight')) order.push('preflight');
    else if (r.url().endsWith('/api/git/commit') && r.method() === 'POST') order.push('commit');
  });
  await page.evaluate(() => (window as any).app.gitPanel._commit()._commit());
  await expect.poll(() => order.includes('commit'), { timeout: 10000 }).toBe(true);
  expect(order[0]).toBe('preflight');
});

test('C7 (F-7.1): HEAD 가 바뀐 관측이 오면 preflight 를 다시 받는다 (detached 경고가 현재 HEAD 를 따른다)', async ({ page, request }) => {
  const repo = makeRepo('c7');
  await enter(page, request, repo);
  const pf: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/git/preflight')) pf.push(r.url()) });
  git(repo, 'checkout', '-q', '--detach');
  await page.evaluate(() => (window as any).app.gitPanel.refresh());
  await expect.poll(() => pf.length, { timeout: 10000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => {
    const c = (window as any).app.gitPanel._commit();
    return !!c._warning('detached_head');
  }), { timeout: 10000 }).toBe(true);
});

test('C8 (F-7.6): Reset mixed 가 실패하면 다이얼로그를 닫지 않고 사유를 보인다', async ({ page, request }) => {
  const repo = makeRepo('c8');
  await enter(page, request, repo);
  await page.route('**/api/git/reset', async (route) => {
    await route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'git_failed', message: 'reset-boom' }) });
  });
  const oid = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await page.evaluate((o: string) => {
    (window as any).GitCommitOps.reset((window as any).app.gitPanel, { oid: o, abbrev: o.slice(0, 7), subject: 's' });
  }, oid);
  const dlg = page.locator('#git-reset');
  await expect(dlg).toBeVisible({ timeout: 10000 });
  await dlg.locator('input[value="mixed"]').check();
  await dlg.locator('.git-dialog-go').click();
  await expect(dlg).toContainText('reset-boom', { timeout: 10000 });
  await expect(dlg).toBeVisible();
});
