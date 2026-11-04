/**
 * EDITOR_LIVE_RELOAD_SRS 묶음 W·C·G — 서버 파일 감시 (V-ELR-27~32·34).
 *
 * 폴링을 30초로 늦춘 채 잰다. 그래야 반영이 감시에서 온 것인지 가릴 수 있다 —
 * 폴링이 3초면 감시가 없어도 대부분의 상한 안에 들어온다.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import {
  test, expect, waitForInit, addEditorRoot, switchToEditorRoot, rmTree, openExplorerSide,
} from './fixtures';
import { ED_SEL } from './editor';
import { TMP, realPath, cssPath } from './osenv';

// EDITOR_LIVE_RELOAD_SRS FR-ELR-55 (D-8): Windows 는 감시하지 않는다 — 감시 핸들이 디렉터리 이름 변경을 막는다.
test.skip(process.platform === 'win32', 'Windows 는 파일 감시를 하지 않는다 (FR-ELR-55, D-8)');

let BASE = '';
/** 앱의 `pathJoin` 과 같은 규칙 — 서버가 준 경로의 구분자를 따른다. `/` 로 이으면 Windows 에서 섞인 경로가 된다. */
const pj = (d: string, r: string) => d + (d.includes('\\') && !d.includes('/') ? '\\' : '/') + r;
test.beforeAll(() => { BASE = realPath(mkdtempSync(join(TMP, 'dm-fsw-'))) });
test.afterAll(() => { rmTree(BASE) });

const SLOW = { gitReposInterval: 30000, gitStatusInterval: 0, gitWorktreeInterval: 30000 };
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

let saved: Record<string, unknown> | null = null;

async function slowPolling(request: APIRequestContext, extra: Record<string, unknown> = {}) {
  saved = await (await request.get('/api/settings')).json();
  const r = await request.put('/api/settings', { data: { ...saved, ...SLOW, ...extra } });
  expect(r.ok()).toBeTruthy();
}

test.afterEach(async ({ request }) => {
  if (saved) await request.put('/api/settings', { data: saved });
  saved = null;
});

type WatchLog = { bodies: string[][]; watching: string[][]; statuses: number[] };

// 등록 요청·응답을 **처음부터** 모은다. 등록은 화면이 서는 즉시 나가므로 나중에 기다리면 놓친다.
function watchLog(page: Page): WatchLog {
  const box: WatchLog = { bodies: [], watching: [], statuses: [] };
  page.on('request', (req) => {
    if (!req.url().includes('/api/fs/watch') || req.method() !== 'PUT') return;
    box.bodies.push((JSON.parse(req.postData() || '{}').dirs || []) as string[]);
  });
  page.on('response', async (res) => {
    if (!res.url().includes('/api/fs/watch')) return;
    box.statuses.push(res.status());
    const body = await res.json().catch(() => ({}));
    if (Array.isArray(body.watching)) box.watching.push(body.watching as string[]);
  });
  return box;
}

async function watching(log: WatchLog, dir: string) {
  await expect.poll(() => log.watching.some((w) => w.includes(dir)),
    { timeout: 15000, message: `등록되지 않았다: ${JSON.stringify(log)}` }).toBe(true);
}

async function mkroot(request: APIRequestContext, _page: Page, name: string, files: Record<string, string>, repo = false) {
  const root = join(BASE, name);
  mkdirSync(root, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c);
  if (repo) {
    git(root, 'init', '-q', '-b', 'main', '.');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'config', 'commit.gpgsign', 'false');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
  }
  const savedRoot = await addEditorRoot(request, root);
  return { root, savedRoot };
}

async function enter(page: Page, savedRoot: string) {
  await waitForInit(page);
  await switchToEditorRoot(page, savedRoot);
}

async function openFile(page: Page, savedRoot: string, rel: string) {
  await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }), pj(savedRoot, rel));
  await page.waitForFunction((n: string) => {
    const eds = [...(window as any).app.fileEditors.values()];
    return eds.some((e: any) => edT.has(e) && e.name === n);
  }, rel, { timeout: 30000 });
}

const valueOf = (page: Page, name: string) => page.evaluate((n: string) => {
  const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
  return v && edT.has(v) ? edT.text(edT.of(v)) : '';
}, name);

const dirtyOf = (page: Page, name: string) => page.evaluate((n: string) => {
  const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
  return !!(v && v._dirty);
}, name);

test('V-ELR-27: 폴링이 30초여도 열린 문서는 1.5초 안에 바뀐다 — 일반 쓰기와 원자적 쓰기', async ({ page, request }) => {
  await slowPolling(request);
  const { root, savedRoot } = await mkroot(request, page, 'doc', { 'a.txt': 'before\n' });
  const log = watchLog(page);
  await enter(page, savedRoot);
  await openFile(page, savedRoot, 'a.txt');
  await watching(log, savedRoot);

  writeFileSync(join(root, 'a.txt'), 'after\n');
  await expect.poll(() => valueOf(page, 'a.txt'), { timeout: 1500, intervals: [50] }).toBe('after\n');

  writeFileSync(join(root, '.a.txt.tmp'), 'atomic\n');
  renameSync(join(root, '.a.txt.tmp'), join(root, 'a.txt'));
  await expect.poll(() => valueOf(page, 'a.txt'), { timeout: 1500, intervals: [50] }).toBe('atomic\n');
  expect(await dirtyOf(page, 'a.txt')).toBe(false);
});

test('V-ELR-29: dirty 인 문서는 밖에서 바뀌어도 편집본 그대로다', async ({ page, request }) => {
  await slowPolling(request);
  const { root, savedRoot } = await mkroot(request, page, 'dirty', { 'b.txt': 'disk\n' });
  const log = watchLog(page);
  await enter(page, savedRoot);
  await openFile(page, savedRoot, 'b.txt');
  await watching(log, savedRoot);
  await page.evaluate(() => {
    const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === 'b.txt');
    edT.replaceAll(edT.of(v), 'mine\n');
  });
  await expect.poll(() => dirtyOf(page, 'b.txt')).toBe(true);
  const reads: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/file/read')) reads.push(r.url()) });

  writeFileSync(join(root, 'b.txt'), 'theirs\n');
  // 감시 이벤트(75ms 모으기 + 왕복)가 충분히 지날 때까지 다른 파일의 반영으로 시간을 잰다.
  writeFileSync(join(root, 'probe.txt'), 'x');
  await openFile(page, savedRoot, 'probe.txt');
  writeFileSync(join(root, 'probe.txt'), 'y');
  await expect.poll(() => valueOf(page, 'probe.txt'), { timeout: 3000 }).toBe('y');
  expect(await valueOf(page, 'b.txt')).toBe('mine\n');
  expect(reads.some((u) => decodeURIComponent(u).includes('b.txt'))).toBe(false);
});

test('V-ELR-30: 폴링이 30초여도 탐색기의 추가·삭제가 2초 안에 보인다', async ({ page, request }) => {
  await slowPolling(request);
  const { root, savedRoot } = await mkroot(request, page, 'tree', { 'keep.txt': 'k' });
  const log = watchLog(page);
  await enter(page, savedRoot);
  await openExplorerSide(page);
  await watching(log, savedRoot);
  const row = (p: string) => page.locator(`.ed-tree .ed-row[data-path="${cssPath(p)}"]`);
  await expect(row(pj(savedRoot, 'keep.txt'))).toBeVisible();

  writeFileSync(join(root, 'new.txt'), 'n');
  await expect(row(pj(savedRoot, 'new.txt'))).toBeVisible({ timeout: 2000 });
  unlinkSync(join(root, 'new.txt'));
  await expect(row(pj(savedRoot, 'new.txt'))).toHaveCount(0, { timeout: 2000 });
});

test('V-ELR-31: 폴링·워크트리 회차를 늦춰도 추적 파일을 고치면 git 색이 3초 안에 바뀐다', async ({ page, request }) => {
  await slowPolling(request);
  const { root, savedRoot } = await mkroot(request, page, 'gitc', { 'tracked.txt': 'one\n' }, true);
  const log = watchLog(page);
  await enter(page, savedRoot);
  await openExplorerSide(page);
  await watching(log, savedRoot);
  const row = page.locator(`.ed-tree .ed-row[data-path="${cssPath(pj(savedRoot, 'tracked.txt'))}"]`);
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute('data-st', /./);

  writeFileSync(join(root, 'tracked.txt'), 'two\n');
  await expect(row).toHaveAttribute('data-st', /./, { timeout: 3000 });
});

test('V-ELR-28: 폴링이 30초여도 Diff 탭 문서가 1.5초 안에 바뀐다', async ({ page, request }) => {
  await slowPolling(request);
  const { root, savedRoot } = await mkroot(request, page, 'diff', { 'd.txt': 'one\n' }, true);
  writeFileSync(join(root, 'd.txt'), 'one\ntwo\n');
  const log = watchLog(page);
  await enter(page, savedRoot);
  await page.locator('.ed-side-tab[data-side="changes"]').click();
  await page.locator(`#area .ed-side .git-group[data-group="working"] .git-file[data-path="d.txt"]`).click();
  await expect(page.locator(`#area .ed-area .git-diff ${ED_SEL.diffModified}`)).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => {
    const v = (window as any).app.gitPanel._diffView;
    return !!v && edT.diffHasMod(v);
  }, undefined, { timeout: 20000 });
  await watching(log, savedRoot);

  writeFileSync(join(root, 'd.txt'), 'one\ntwo\nthree\n');
  await expect.poll(() => page.evaluate(() => edT.diffText((window as any).app.gitPanel._diffView, 'mod')),
    { timeout: 1500, intervals: [50] }).toBe('one\ntwo\nthree\n');
});

test('V-ELR-32: 등록 본문이 탭과 펼침을 따라간다', async ({ page, request }) => {
  const { root, savedRoot } = await mkroot(request, page, 'reg', { 'top.txt': 't' });
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 's.txt'), 's');
  const log = watchLog(page);
  await enter(page, savedRoot);
  await openExplorerSide(page);
  await watching(log, savedRoot);
  const last = () => log.bodies[log.bodies.length - 1] || [];

  await page.locator(`.ed-tree .ed-row[data-path="${cssPath(pj(savedRoot, 'sub'))}"]`).click();
  await expect.poll(() => last().includes(pj(savedRoot, 'sub')), { timeout: 5000 }).toBe(true);
  await page.locator(`.ed-tree .ed-row[data-path="${cssPath(pj(savedRoot, 'sub'))}"]`).click();
  await expect.poll(() => last().includes(pj(savedRoot, 'sub')), { timeout: 5000 }).toBe(false);
});

test('V-ELR-34: /api/fs/watch 가 404 면 등록을 멈추고 폴링 반영은 그대로 된다', async ({ page, request }) => {
  const puts: string[] = [];
  await page.route('**/api/fs/watch', (route) => { puts.push(route.request().url()); return route.fulfill({ status: 404, body: '' }) });
  const { root, savedRoot } = await mkroot(request, page, 'old', { 'c.txt': 'before\n' });
  await enter(page, savedRoot);
  await openFile(page, savedRoot, 'c.txt');
  await expect.poll(() => puts.length, { timeout: 10000 }).toBeGreaterThan(0);
  const n = puts.length;

  writeFileSync(join(root, 'c.txt'), 'after\n');
  await expect.poll(() => valueOf(page, 'c.txt'), { timeout: 12000 }).toBe('after\n');
  await openFile(page, savedRoot, 'c.txt');
  expect(puts.length).toBe(n);
});
