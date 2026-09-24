import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot } from './fixtures';
import { TMP, realPath } from './osenv';

// REPO_FIX 05 §3A-7 (F-8) — History.
//
// 사라진 ref 필터는 풀고 사유를 한 번 보인다. 해시·ref 로 해석된 검색은 grep 을 싣지 않는다.
// Compare 기준 표시는 reload 에도 남는다. 부모 해시는 로드 범위 밖이어도 찾아가고, 펼친
// 상세 높이를 스크롤 계산에 넣는다.

let BASE = '';
let REPO = '';
const N = 320;

const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
const rev = (d: string, r: string) => execFileSync('git', ['-C', d, 'rev-parse', r], { encoding: 'utf8' }).trim();

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-ghf-')));
  const d = j(BASE, 'repo');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  execFileSync('sh', ['-c', `for i in $(seq 1 ${N}); do git commit -q --allow-empty -m "c$i alpha"; done`], { cwd: d });
  REPO = realPath(d);
});
test.afterAll(() => { rmTree(BASE) });

async function enter(page: Page, request: APIRequestContext, before?: (repo: string) => void) {
  const r = await request.post('/api/editors/add', { data: { path: REPO } });
  expect(r.ok()).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  if (before) await page.context().addInitScript(before, REPO);
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, REPO);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
  await page.evaluate(() => (window as any).app.gitPanel.openView('history'));
  await page.waitForFunction(() => {
    const h = (window as any).app.gitPanel._historyView;
    return !!h && h._commits.length > 0 && !h._loading;
  }, undefined, { timeout: 20000 });
}

const hv = (page: Page, f: string) => page.evaluate(`(() => { const h = window.app.gitPanel._historyView; return ${f} })()`);

test('H1 (F-8.1): 저장된 ref 필터가 더 이상 없으면 풀고 사유를 보인다', async ({ page, request }) => {
  await enter(page, request, (repo: string) => { localStorage.setItem('gitHistRef:' + repo, 'refs/heads/gone-branch') });
  await expect.poll(() => hv(page, 'h._ref'), { timeout: 10000 }).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('gitHistRef:' + (window as any).app.gitPanel.repo))).toBeNull();
  await expect(page.locator('#area .ed-area .git-history')).toContainText('gone-branch', { timeout: 5000 });
  expect(await hv(page, 'h._commits.length')).toBeGreaterThan(0);
});

test('H2 (F-8.2): 해시로 해석된 검색은 이전 grep 조건을 비운다', async ({ page, request }) => {
  await enter(page, request);
  await page.evaluate(() => (window as any).app.gitPanel._historyView._search('alpha'));
  await expect.poll(() => hv(page, 'h._grep'), { timeout: 10000 }).toBe('alpha');
  const logs: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/git/log?')) logs.push(r.url()) });
  const h = rev(REPO, 'HEAD~3').slice(0, 10);
  await page.evaluate((q: string) => (window as any).app.gitPanel._historyView._search(q), h);
  await expect.poll(() => hv(page, 'h._grep'), { timeout: 10000 }).toBe('');
  // 다시 받는 목록 요청에 앞 검색의 grep 이 실리지 않는다(빈 값은 아예 싣지 않는다).
  await expect.poll(() => logs.some((u) => !u.includes('limit=1') && !u.includes('grep=alpha')), { timeout: 10000 }).toBe(true);
});

test('H3 (F-8.3): Compare 기준 표시는 reload 에도 남는다', async ({ page, request }) => {
  await enter(page, request);
  const oid = rev(REPO, 'HEAD~2');
  await page.evaluate((o: string) => (window as any).GitCommitOps.mark((window as any).app.gitPanel,
    { oid: o, abbrev: o.slice(0, 7), subject: 'marked-subject' }), oid);
  const bar = page.locator('#area .ed-area .git-history');
  await expect(bar).toContainText('marked-subject', { timeout: 5000 });
  await page.evaluate(() => (window as any).app.gitPanel._historyView.reload());
  await expect.poll(() => hv(page, '!h._loading'), { timeout: 10000 }).toBe(true);
  await expect(bar).toContainText('marked-subject', { timeout: 5000 });
});

test('H4 (F-8.4): 부모 해시는 로드 범위 밖이어도 찾아간다', async ({ page, request }) => {
  await enter(page, request);
  const loaded = await hv(page, 'h._commits.length') as number;
  expect(loaded).toBeLessThan(N);
  const last = await hv(page, 'h._commits[h._commits.length-1].oid') as string;
  const parent = rev(REPO, last + '^');
  await page.evaluate((o: string) => {
    const h = (window as any).app.gitPanel._historyView;
    h._goto(o);
    h._toggle(h._view.find((c: any) => c.oid === o));
  }, last);
  const link = page.locator(`#area .ed-area .git-hist-d-parent[data-oid="${parent}"]`);
  await expect(link).toBeVisible({ timeout: 15000 });
  await link.click();
  await expect.poll(() => hv(page, 'h._jumped'), { timeout: 15000 }).toBe(parent);
  expect(await hv(page, 'h._commits.length')).toBeGreaterThan(loaded);
});

test('H5 (F-8.4): 펼친 상세의 높이를 스크롤 계산에 넣는다', async ({ page, request }) => {
  await enter(page, request);
  await page.evaluate(() => {
    const h = (window as any).app.gitPanel._historyView;
    h._toggle(h._view[2]);
  });
  const got = await page.evaluate(() => {
    const h = (window as any).app.gitPanel._historyView;
    const target = h._view[60].oid;
    h._goto(target);
    const items = h._items();
    const idx = items.findIndex((it: any) => it.i === 60);
    return { top: h._list.scrollTop, idx, rowH: h._rowH(), detail: (window as any).GIT_HIST_DETAIL_H ?? 240,
      max: h._list.scrollHeight - h._list.clientHeight };
  });
  const want = Math.min(got.max, got.idx * got.rowH + got.detail);
  expect(Math.abs(got.top - want)).toBeLessThanOrEqual(1);
});
