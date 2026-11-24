import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, gitFixture, cleanGitFixture, switchToEditorRoot, gotoWithEditors } from './fixtures';
import { tmpPath, realPath } from './osenv';

// UX_BATCH12_SRS FR-FHL-1~7 (R12) — Repo 창의 하이라이트는 Changes·Explorer 를 통틀어 하나이고
// 포커스 탭을 따른다 (TC-FHL-1~3). 파일을 바꾸지 않으므로 픽스처는 스펙 하나가 함께 쓴다.

const FIXTURES = tmpPath('otter-git-fx-fhl-' + process.pid);
test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });

const REPO = () => realPath(join(FIXTURES, 'basic'));
const NESTED = () => join(REPO(), '디렉터리 한글', '파일 이름.txt');
const TOP = () => join(REPO(), 'tracked.txt');

/** 지금 두 패널의 선택. Changes 는 경로만, Explorer 는 앵커와 집합. */
const state = (page: Page) => page.evaluate(() => {
  const a = (window as any).app;
  const t = a.testing.edTree(a.testing.aw());
  return {
    changes: a.gitPanel.files._selected().map((x: any) => x.path).sort(),
    sel: t ? t._sel : null,
    set: t ? [...t._selSet].sort() : [],
    open: t ? [...t._open] : [],
    side: (a.testing.aw().editor || {}).side || null,
  };
});

/** 포커스 pane 의 탭 중 조건에 맞는 것의 id. */
const tabId = (page: Page, kind: 'file' | 'diff', path = '') => page.evaluate(([k, p]) => {
  const a = (window as any).app;
  const pn = a.testing.flattenPanes(a.testing.aw().layout).find((x: any) => x.id === a.focused);
  const t = pn.tabs.find((x: any) => k === 'file' ? x.filePath === p : x.gitView === 'diff');
  return t ? t.id : '';
}, [kind, path] as const);

const go = (page: Page, tid: string) => page.evaluate((id) => {
  const a = (window as any).app;
  a.layout.tabOps.switchTab(a.focused, id);
}, tid);

/** Changes 의 행 하나를 사용자가 고르듯 고른다. */
const pickChange = (page: Page, rel: string, mods: any = undefined) => page.evaluate(([r, m]) => {
  const p = (window as any).app.gitPanel;
  const e = p.diffPane._fileList().find((x: any) => x.path === r);
  p.selection._select(e.group, e, m);
}, [rel, mods] as const);

async function setup(page: Page) {
  await waitForInit(page);
  await openGit(page, REPO());
  // 탐색기를 한 번 세워 트리가 있게 한 뒤 Changes 로 돌아간다 — 사이드 탭은 자동으로 바뀌지 않는다.
  await page.evaluate(() => { const a = (window as any).app; a.testing.edSetSide(a.testing.aw(), 'explorer') });
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => { const a = (window as any).app; a.testing.edSetSide(a.testing.aw(), 'changes') });
  await page.evaluate(async ([a1, a2]) => {
    const a = (window as any).app;
    await a.editor.file.edOpenFile(a1, { preview: false });
    await a.editor.file.edOpenFile(a2, { preview: false });
  }, [TOP(), NESTED()]);
}

test.describe('UX_BATCH12 — 포커스 탭 하이라이트 (FR-FHL-1~7)', () => {
  test('TC-FHL-1: 파일 탭으로 바꾸면 Explorer 는 그 파일 하나, Changes 는 비고, 사이드 탭은 그대로', async ({ page }) => {
    await setup(page);
    const nested = await tabId(page, 'file', NESTED());
    const top = await tabId(page, 'file', TOP());
    await go(page, top);
    // 사용자가 다른 것을 고르고 접는다 — 다음 탭 전환이 이것을 바꿔야 한다.
    await pickChange(page, 'untracked.txt');
    await page.evaluate((d) => {
      const a = (window as any).app; const t = a.testing.edTree(a.testing.aw());
      if (t._open.has(d)) t.selector.toggle(d);
    }, join(REPO(), '디렉터리 한글'));

    await go(page, nested);
    await expect.poll(async () => (await state(page)).set).toEqual([NESTED()]);
    const st = await state(page);
    expect(st.sel).toBe(NESTED());
    expect(st.open).toContain(join(REPO(), '디렉터리 한글'));
    expect(st.changes).toEqual([]);
    expect(st.side).toBe('changes');
  });

  test('TC-FHL-2: Diff 탭이면 Changes 는 대상 행 하나, Explorer 는 비고, ‹ › 이동도 따른다', async ({ page }) => {
    await setup(page);
    await pickChange(page, 'tracked.txt');
    await page.evaluate(() => (window as any).app.gitPanel.selection.openView('diff'));
    const diff = await tabId(page, 'diff');
    const top = await tabId(page, 'file', TOP());
    await go(page, top);
    await expect.poll(async () => (await state(page)).set).toEqual([TOP()]);
    await pickChange(page, 'untracked.txt', { metaKey: true });

    // FR-RTB-12: Changes 는 패널이 마지막에 고른 행이 아니라 **그 Diff 탭의 대상**을 따른다.
    await go(page, diff);
    await expect.poll(async () => (await state(page)).changes).toEqual(['tracked.txt']);
    expect((await state(page)).set).toEqual([]);

    // Diff 탭에 있는 동안 사용자가 Explorer 에서 고른 것은 ‹ › 이동이 지운다 (FR-FHL-4).
    await page.evaluate((p) => {
      const a = (window as any).app; const t = a.testing.edTree(a.testing.aw());
      t.selector._selOnly(p); t._paintAll();
    }, TOP());
    // ‹ › 는 그 Diff 탭의 패널이 한다 (FR-RTB-9).
    await page.evaluate((id) => {
      const a = (window as any).app;
      const p = [...a.testing.gitPanels.values()].find((x: any) => x.diffTabId === id);
      p.diffPane._diffMove(1);
    }, diff);
    await expect.poll(async () => (await state(page)).set).toEqual([]);
    await expect.poll(async () => (await state(page)).changes).not.toEqual(['tracked.txt']);
    expect((await state(page)).changes.length).toBe(1);
  });

  test('TC-FHL-3: 포커스 탭이 그대로면 다시 그려도 사용자의 여러 선택이 남는다', async ({ page }) => {
    await setup(page);
    const top = await tabId(page, 'file', TOP());
    await go(page, top);
    await expect.poll(async () => (await state(page)).set).toEqual([TOP()]);
    const three = [TOP(), join(REPO(), 'untracked.txt'), join(REPO(), 'renamed to.txt')];
    await page.evaluate((ps) => {
      const a = (window as any).app; const t = a.testing.edTree(a.testing.aw());
      t.selector._selOnly(ps[0]); t.selector._selToggle(ps[1]); t.selector._selToggle(ps[2]); t._paintAll();
      a.render(); a.render();
    }, three);
    expect((await state(page)).set).toEqual([...three].sort());
  });

  test('TC-FHL-5: 미리보기 탭이 같은 id 로 Diff ↔ 파일을 오가도 반대쪽 선택을 지운다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, REPO());
    // Changes 행 클릭 → Diff 미리보기.
    await page.locator('.git-file[data-path="tracked.txt"]').first().click();
    await expect.poll(async () => (await state(page)).changes).toEqual(['tracked.txt']);
    await page.evaluate(() => { const a = (window as any).app; a.testing.edSetSide(a.testing.aw(), 'explorer') });
    // Explorer 파일 클릭 → 같은 미리보기 탭이 파일로 바뀐다 (FR-RTB-1). Changes 는 비어야 한다.
    await page.locator('.ed-row', { hasText: 'untracked.txt' }).first().click();
    await expect.poll(async () => (await state(page)).set).toEqual([join(REPO(), 'untracked.txt')]);
    await expect.poll(async () => (await state(page)).changes).toEqual([]);
    // 폴더를 고른 뒤 Changes 행 클릭 → 같은 탭이 다시 Diff 로. Explorer 는 비어야 한다.
    await page.locator('.ed-row', { hasText: '디렉터리 한글' }).first().click();
    await page.evaluate(() => { const a = (window as any).app; a.testing.edSetSide(a.testing.aw(), 'changes') });
    await page.locator('.git-file[data-path="tracked.txt"]').first().click();
    await expect.poll(async () => (await state(page)).changes).toEqual(['tracked.txt']);
    await expect.poll(async () => (await state(page)).set).toEqual([]);
  });

  // 하이라이트는 포커스 탭의 **상태**다. 새로고침(버전 갱신의 자동 새로고침 포함) 직후에는 트리·패널이
  // 늦게 서므로, 그때 적용하지 못한 것을 "처리했다" 로 적으면 탭을 바꾸기 전까지 하이라이트가 없다.
  for (const kind of ['file', 'diff'] as const) {
    test(`TC-FHL-6: 새로고침 뒤에도 포커스 탭(${kind})의 대상이 하이라이트다`, async ({ page, request }) => {
      const r = await request.post('/api/editors/add', { data: { path: REPO() } });
      expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
      await gotoWithEditors(page);
      await switchToEditorRoot(page, REPO());
      await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
      // 새로고침할 때 **반대쪽** 사이드를 보게 둔다 — 대상 패널이 늦게 서는 경우다.
      if (kind === 'file') {
        await page.evaluate((f) => (window as any).app.editor.file.edOpenFile(f, { preview: false }), TOP());
        await page.evaluate(() => { const a = (window as any).app; a.testing.edSetSide(a.testing.aw(), 'changes') });
      } else {
        await page.locator('#area .ed-side .git-file[data-path="tracked.txt"]').first().click();
        await expect.poll(async () => (await state(page)).changes).toEqual(['tracked.txt']);
        await openExplorer(page);
      }
      // 새로고침 전에 지금 상태의 저장이 서버에 닿게 한다.
      await page.evaluate(() => (window as any).app.wsSave.save());
      await page.reload();
      await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
      if (kind === 'file') {
        await openExplorer(page);
        await expect.poll(async () => (await state(page)).set).toEqual([TOP()]);
      } else {
        await page.evaluate(() => { const a = (window as any).app; a.testing.edSetSide(a.testing.aw(), 'changes') });
        await expect.poll(async () => (await state(page)).changes).toEqual(['tracked.txt']);
      }
    });
  }
});

async function openExplorer(page: Page) {
  await page.evaluate(() => { const a = (window as any).app; a.testing.edSetSide(a.testing.aw(), 'explorer') });
  await expect(page.locator('#area .ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}
