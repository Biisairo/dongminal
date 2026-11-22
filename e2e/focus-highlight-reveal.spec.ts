/**
 * UX_BATCH12_SRS FR-FHL-10 — 포커스 탭이 바뀌어 하이라이트가 옮겨 가면, 그 행이 **보이게** 한다.
 *
 * 가리는 것: Explorer 의 접힌 폴더, Changes 의 접힌 그룹(아코디언)·접힌 트리 폴더·"더 보기" 뒤의 행.
 * 사이드가 숨어 있던 쪽은 그 사이드를 열 때 그 행으로 스크롤한다 (TC-FHL-7).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot, gotoWithEditors } from './fixtures';
import { TMP, realPath } from './osenv';

let REPO = '';
const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
// Changes 의 행 상한(GIT_FILE_ROW_CHUNK=200)을 넘겨 마지막 행이 "더 보기" 뒤에 숨게 한다.
const MANY = 230;
const DEEP = 'd059/sub/t.txt';
const LAST = 'zz/last.txt';

test.beforeAll(() => {
  const d = realPath(fs.mkdtempSync(j(TMP, 'dm-fhlr-')));
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  for (let i = 0; i < 60; i++) {
    const dir = j(d, 'd' + String(i).padStart(3, '0'), 'sub');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(j(dir, 't.txt'), 'base\n');
  }
  fs.mkdirSync(j(d, 'm'));
  for (let i = 0; i < MANY; i++) fs.writeFileSync(j(d, 'm', 'f' + String(i).padStart(3, '0') + '.txt'), 'base\n');
  fs.mkdirSync(j(d, 'zz'));
  fs.writeFileSync(j(d, LAST), 'base\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  for (let i = 0; i < MANY; i++) fs.appendFileSync(j(d, 'm', 'f' + String(i).padStart(3, '0') + '.txt'), 'changed\n');
  fs.appendFileSync(j(d, LAST), 'changed\n');
  fs.appendFileSync(j(d, DEEP), 'changed\n');
  REPO = d;
});
test.afterAll(() => rmTree(REPO));

async function enter(page: Page, request: APIRequestContext) {
  await page.setViewportSize({ width: 1200, height: 600 });
  const r = await request.post('/api/editors/add', { data: { path: REPO } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await gotoWithEditors(page);
  await switchToEditorRoot(page, REPO);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
  await expect(page.locator('#area .ed-side .git-file').first()).toBeVisible({ timeout: 15000 });
}

const setSide = (page: Page, side: string) => page.evaluate((sd) => {
  const a = (window as any).app; a.testing.edSetSide(a.testing.aw(), sd);
}, side);

/** 포커스 칸에서 조건에 맞는 탭의 id. */
const tabId = (page: Page, kind: 'file' | 'diff', p: string) => page.evaluate(([k, rel, root]) => {
  const a = (window as any).app;
  const pn = a.testing.flattenPanes(a.testing.aw().layout).find((x: any) => x.id === a.focused);
  const abs = root + '/' + rel;
  const t = pn.tabs.find((x: any) => k === 'file' ? x.filePath === abs : x.gitView === 'diff' && x.diffTarget && x.diffTarget.path === rel);
  return t ? t.id : '';
}, [kind, p, REPO] as const);

const go = (page: Page, tid: string) => page.evaluate((id) => { const a = (window as any).app; a.switchTab(a.focused, id) }, tid);

/** 선택자에 맞는 행이 있고, 그 행이 스크롤 상자 안에 보이는가. */
const visibleIn = (page: Page, sel: string) => page.evaluate((s) => {
  const row = document.querySelector(s) as HTMLElement | null;
  if (!row || !row.offsetParent) return false;
  let box = row.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box) return false;
  const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
  return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
}, sel);

const EXP_ROW = (rel: string) => `#area .ed-side .ed-tree .ed-row.sel[data-path="${REPO}/${rel}"]`;
const CHG_ROW = (rel: string) => `#area .ed-side .git-changes .git-file.sel[data-path="${rel}"]`;

/** Diff 탭(LAST)과 파일 탭(DEEP)을 하나씩 고정으로 만든다. */
async function twoTabs(page: Page) {
  await page.evaluate((rel) => (window as any).app.gitPanel.poll.openFileDiff({ group: 'working', path: rel }), LAST);
  await expect.poll(() => tabId(page, 'diff', LAST)).not.toBe('');
  await page.evaluate((abs) => (window as any).app.edOpenFile(abs, { preview: false }), j(REPO, DEEP));
  await expect.poll(() => tabId(page, 'file', DEEP)).not.toBe('');
  return { diff: await tabId(page, 'diff', LAST), file: await tabId(page, 'file', DEEP) };
}

test.describe('FR-FHL-10 — 옮겨 간 하이라이트가 보이게 한다', () => {
  test('Explorer: 접힌 폴더를 펴고 그 행으로 스크롤한다', async ({ page, request }) => {
    await enter(page, request);
    const t = await twoTabs(page);
    await go(page, t.diff);
    await setSide(page, 'explorer');
    await page.evaluate((root) => {
      const a = (window as any).app; const tr = a.testing.edTree(a.testing.aw());
      for (const p of [...tr._open]) if (p.startsWith(root + '/d059')) tr.toggle(p);
      tr.list.closest('.ed-tree').scrollTop = 0; tr.list.scrollTop = 0;
    }, REPO);
    await go(page, t.file);
    await expect.poll(() => visibleIn(page, EXP_ROW(DEEP))).toBe(true);
  });

  test('Changes: 접힌 그룹을 펴고 "더 보기" 뒤의 행을 그려 그 행으로 스크롤한다', async ({ page, request }) => {
    await enter(page, request);
    const t = await twoTabs(page);
    await setSide(page, 'changes');
    await page.evaluate(() => { const p = (window as any).app.gitPanel; p._shown.clear(); p._collapsed.add('working'); p.changes._paint() });
    await go(page, t.diff);
    await expect.poll(() => visibleIn(page, CHG_ROW(LAST))).toBe(true);
  });

  test('Changes 트리 보기: 접힌 폴더를 펴고 그 행으로 스크롤한다', async ({ page, request }) => {
    await enter(page, request);
    const t = await twoTabs(page);
    await setSide(page, 'changes');
    await page.evaluate(() => {
      const p = (window as any).app.gitPanel;
      p.changes._fileView = 'tree'; p._shown.clear(); p._dirCollapsed.add('working:zz'); p.changes._paint();
    });
    await go(page, t.diff);
    await expect.poll(() => visibleIn(page, CHG_ROW(LAST))).toBe(true);
  });

  test('TC-FHL-7: 숨어 있던 사이드는 열 때 그 행으로 스크롤한다', async ({ page, request }) => {
    await enter(page, request);
    const t = await twoTabs(page);
    // Explorer 가 숨은 채 파일 탭으로 → Explorer 를 열면 그 행이 보인다.
    await go(page, t.diff);
    await setSide(page, 'changes');
    await go(page, t.file);
    await setSide(page, 'explorer');
    await expect.poll(() => visibleIn(page, EXP_ROW(DEEP))).toBe(true);
    // Changes 가 숨은 채 Diff 탭으로 → Changes 를 열면 그 행이 보인다.
    await go(page, t.diff);
    await setSide(page, 'changes');
    await expect.poll(() => visibleIn(page, CHG_ROW(LAST))).toBe(true);
  });
});
