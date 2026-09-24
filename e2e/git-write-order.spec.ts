import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot } from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

// REPO_FIX 05 §3A-5 (F-4) — 쓰기와 관측의 순서.
//
// ① 쓰기 이전에 출발한 status 응답은 쓰기 결과를 덮지 않는다(쓰기 세대).
// ② stage/unstage/discard 연타는 버리지 않고 저장소 단위 큐로 직렬 전송한다.
// ③ 파일 단위 쓰기 뒤 열린 Diff 는 즉시 다시 받는다.

let BASE = '';

const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

function makeRepo(name: string) {
  const d = j(BASE, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  for (const n of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(j(d, n), 'one\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  for (const n of ['a.txt', 'b.txt', 'c.txt']) fs.appendFileSync(j(d, n), 'two\n');
  return realPath(d);
}

test.beforeAll(() => { BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-gwo-'))) });
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
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const row = (page: Page, group: string, p: string) =>
  page.locator(`#area .ed-side .git-group[data-group="${group}"] .git-file[data-path="${cssPath(p)}"]`);
const staged = (page: Page) => page.evaluate(() =>
  (((window as any).app.gitPanel.statusOf() || {}).staged || []).map((e: any) => e.path).sort());
const stageRow = (page: Page, p: string) => page.evaluate((f: string) =>
  (window as any).app.gitPanel._run('stage', [{ group: 'working', path: f, origPath: '', untracked: false }]), p);
// 연타 — 한 틱 안에서 차례로 누른다(첫 쓰기가 진행 중인 채로 나머지가 들어온다).
const stageBurst = (page: Page, ps: string[]) => page.evaluate((fs: string[]) => {
  const p = (window as any).app.gitPanel;
  (window as any).__burst = Promise.all(fs.map((f) =>
    p._run('stage', [{ group: 'working', path: f, origPath: '', untracked: false }])));
}, ps);
const burstDone = (page: Page) => page.evaluate(() => (window as any).__burst);

test('Q1 (F-4.2): 쓰기 진행 중의 stage 연타는 버려지지 않고 차례로 나간다', async ({ page, request }) => {
  const repo = makeRepo('q1');
  await enter(page, request, repo);
  await expect(row(page, 'working', 'c.txt')).toBeVisible({ timeout: 15000 });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r });
  let first = true;
  const sent: string[] = [];
  await page.route('**/api/git/stage', async (route) => {
    sent.push(JSON.parse(route.request().postData() || '{}').paths.join(','));
    if (first) { first = false; await gate }
    await route.continue();
  });
  await stageBurst(page, ['a.txt', 'b.txt', 'c.txt']);
  await expect.poll(() => sent.length).toBe(1);
  release();
  await burstDone(page);
  expect(sent).toEqual(['a.txt', 'b.txt', 'c.txt']);
  await expect.poll(() => staged(page), { timeout: 10000 }).toEqual(['a.txt', 'b.txt', 'c.txt']);
});

test('Q2 (F-4.2): 409 repo_busy 면 큐를 멈추고 사유를 보이며 남은 것은 보내지 않는다', async ({ page, request }) => {
  const repo = makeRepo('q2');
  await enter(page, request, repo);
  await expect(row(page, 'working', 'c.txt')).toBeVisible({ timeout: 15000 });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r });
  const sent: string[] = [];
  await page.route('**/api/git/stage', async (route) => {
    sent.push(JSON.parse(route.request().postData() || '{}').paths.join(','));
    await gate;
    await route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'repo_busy', message: '' }) });
  });
  await stageBurst(page, ['a.txt', 'b.txt']);
  await expect.poll(() => sent.length).toBe(1);
  release();
  await burstDone(page);
  expect(sent).toEqual(['a.txt']);
  await expect(page.locator('#area .ed-side .git-partial-note, #area .ed-side .git-note').first())
    .toContainText('다른 쓰기가 진행 중', { timeout: 5000 });
});

test('W1 (F-4.1): 쓰기 전에 출발한 status 응답은 쓰기 결과를 덮지 않는다', async ({ page, request }) => {
  const repo = makeRepo('w1');
  await enter(page, request, repo);
  await expect(row(page, 'working', 'a.txt')).toBeVisible({ timeout: 15000 });
  // 이 패널의 다음 status 하나를 서버에서 받아 둔 채(쓰기 전 관측) 붙잡는다 — 그 한 번의
  // `apiGet` 만 가로챈다(`collect` 는 동기 구간에서 부른다).
  await page.waitForFunction(() => !(window as any).app.gitPanel._busy, undefined, { timeout: 10000 });
  await page.evaluate(() => {
    const w = window as any;
    const orig = w.apiGet;
    w.__gate = new Promise((r) => { w.__rel = r });
    w.__statusCalls = 0;
    w.apiGet = async (u: string, o: any) => {
      w.apiGet = async (u2: string, o2: any) => {
        if (String(u2).startsWith('/api/git/status?')) w.__statusCalls++;
        return orig(u2, o2);
      };
      const r = await orig(u, o);
      w.__held = true;
      await w.__gate;
      return r;
    };
    w.__col = w.app.gitPanel.collect();
  });
  await page.waitForFunction(() => (window as any).__held === true, undefined, { timeout: 10000 });
  await stageRow(page, 'a.txt');
  expect(await staged(page)).toEqual(['a.txt']);
  await page.evaluate(() => { (window as any).__rel(); return (window as any).__col });
  // 붙잡힌(쓰기 전) 응답은 적용되지 않고, 관측을 한 번 더 한다.
  expect(await staged(page)).toEqual(['a.txt']);
  await expect.poll(() => page.evaluate(() => (window as any).__statusCalls), { timeout: 5000 }).toBeGreaterThan(0);
  await expect.poll(() => staged(page), { timeout: 5000 }).toEqual(['a.txt']);
});

test('D1 (F-4.3): 파일 단위 쓰기 뒤 열린 Diff 는 다음 관측을 기다리지 않고 다시 받는다', async ({ page, request }) => {
  const repo = makeRepo('d1');
  // index 에도 한 줄 — working 축(index↔worktree)의 원본 쪽이 unstage 로 바뀐다.
  git(repo, 'add', 'a.txt');
  fs.appendFileSync(j(repo, 'a.txt'), 'three\n');
  await enter(page, request, repo);
  await row(page, 'working', 'a.txt').click();
  await page.waitForFunction(() => !!(window as any).app.gitPanel._diffView?._orig, undefined, { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).app.gitPanel._diffView._orig.getValue())).toBe('one\ntwo\n');
  const order: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/git/diff-content')) order.push('diff');
    else if (u.includes('/api/git/status?')) order.push('status');
    else if (u.includes('/api/git/unstage')) order.push('unstage');
  });
  await page.evaluate(() => (window as any).app.gitPanel._run('unstage',
    [{ group: 'staged', path: 'a.txt', origPath: '', untracked: false }]));
  await expect.poll(() => page.evaluate(() => (window as any).app.gitPanel._diffView._orig?.getValue()),
    { timeout: 10000 }).toBe('one\n');
  const after = order.slice(order.indexOf('unstage') + 1);
  expect(after[0]).toBe('diff');
});
