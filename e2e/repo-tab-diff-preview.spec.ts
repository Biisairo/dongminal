/**
 * UX_BATCH12_SRS §3.5f FR-RTB — Repo 창의 탭: Diff 탭 다중화와 미리보기·고정 (묶음 2).
 *
 * TC-RTB-3: Diff 미리보기는 칸에 하나이고 대상만 바뀐다. 고정하면 Diff 탭이 여럿 선다 (FR-RTB-1·7).
 * TC-RTB-2: Changes 행 더블클릭이 Diff 를 고정한다 (FR-RTB-6 ③).
 * TC-RTB-6: ‹ › — 미리보기 Diff 는 대상이 바뀌고, 고정 Diff 는 남고 미리보기가 다음 파일로 선다 (FR-RTB-9).
 * TC-RTB-5: 새로고침 뒤 Diff 탭의 미리보기 상태와 대상이 되살아난다 (FR-RTB-13).
 * 두 칸이 동시에 서로 다른 Diff 를 보인다 (FR-RTB-1, "칸은 서로 영향을 주지 않는다").
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot, openExplorerSide, gotoWithEditors } from './fixtures';
import { TMP, realPath, cssPath } from './osenv';

let REPO = '';
const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
const FILES = ['a.txt', 'b.txt', 'c.txt'];

test.beforeAll(() => {
  const d = realPath(fs.mkdtempSync(j(TMP, 'dm-rtbd-')));
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  for (const f of FILES) fs.writeFileSync(j(d, f), f + ' base\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  for (const f of FILES) fs.appendFileSync(j(d, f), f + ' changed\n');
  REPO = d;
});
test.afterAll(() => rmTree(REPO));

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: REPO } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await gotoWithEditors(page);
  await switchToEditorRoot(page, REPO);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
  await expect(changeRow(page, 'c.txt')).toBeVisible({ timeout: 10000 });
}

const changeRow = (page: Page, p: string) =>
  page.locator(`#area .ed-side .git-view.git-changes .git-group[data-group="working"] .git-file[data-path="${p}"]`);

type TabInfo = { name: string; preview: boolean; kind: string };
type PaneInfo = { id: string; tabs: TabInfo[]; active: string };

async function panes(page: Page): Promise<{ focused: string; list: PaneInfo[] }> {
  return page.evaluate(() => {
    const a = (window as any).app;
    const w = a.testing.aw();
    const list = a.testing.flattenPanes(w.layout).map((pn: any) => {
      const act = pn.tabs.find((x: any) => x.id === pn.activeTab);
      return {
        id: pn.id,
        tabs: pn.tabs.map((x: any) => ({ name: x.name, preview: !!x.preview, kind: x.type === 'git' ? x.gitView : x.type })),
        active: act ? act.name : '',
      };
    });
    return { focused: w.focusedPane, list };
  });
}

const diffPath = (page: Page, paneId?: string) =>
  page.locator(`#area .ed-area ${paneId ? `.pn[data-paneid="${paneId}"] ` : ''}.git-view.git-diff .git-diff-path`);
const mainTabs = (page: Page) => page.locator('#area .ed-area .pn-tab');
const D = (name: string, preview: boolean) => ({ name, preview, kind: 'diff' });

test.describe('TC-RTB-3 — Diff 미리보기는 칸에 하나다 (FR-RTB-1·7)', () => {
  test('Changes 두 파일을 차례로 누르면 Diff 미리보기 하나가 대상만 바꾼다', async ({ page, request }) => {
    await enter(page, request);
    await changeRow(page, 'a.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', true)]);
    await expect(diffPath(page)).toHaveText('a.txt');
    await changeRow(page, 'b.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('b.txt', true)]);
    await expect(diffPath(page)).toHaveText('b.txt');
  });

  test('첫 Diff 를 고정하고 둘째를 누르면 Diff 탭이 둘이다', async ({ page, request }) => {
    await enter(page, request);
    await changeRow(page, 'a.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', true)]);
    await mainTabs(page).first().dblclick();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', false)]);
    await changeRow(page, 'b.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', false), D('b.txt', true)]);
    await expect(diffPath(page)).toHaveText('b.txt');
    // 고정된 a.txt 탭으로 돌아가면 그 탭의 대상이 보인다.
    await mainTabs(page).first().click();
    await expect(diffPath(page)).toHaveText('a.txt');
  });

  test('편집기 미리보기가 있는 칸에서 Changes 를 누르면 그 미리보기가 Diff 로 바뀐다', async ({ page, request }) => {
    await enter(page, request);
    await openExplorerSide(page);
    await page.locator(`#area .ed-side .ed-tree .ed-row[data-path="${cssPath(j(REPO, 'a.txt'))}"]`).click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([{ name: 'a.txt', preview: true, kind: 'editor' }]);
    await page.evaluate(() => { const a = (window as any).app; a.testing.edSetSide(a.testing.aw(), 'changes') });
    await changeRow(page, 'b.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('b.txt', true)]);
    // 거꾸로 — Diff 미리보기가 있는 칸에서 Explorer 를 누르면 편집기 미리보기로 바뀐다.
    await openExplorerSide(page);
    await page.locator(`#area .ed-side .ed-tree .ed-row[data-path="${cssPath(j(REPO, 'c.txt'))}"]`).click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([{ name: 'c.txt', preview: true, kind: 'editor' }]);
  });

  test('두 칸이 서로 다른 Diff 를 함께 보인다', async ({ page, request }) => {
    await enter(page, request);
    await changeRow(page, 'a.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', true)]);
    await mainTabs(page).first().dblclick();
    await changeRow(page, 'b.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs.length).toBe(2);
    // b.txt 미리보기를 오른쪽 칸으로 떼어 낸다.
    await page.evaluate(() => {
      const a = (window as any).app;
      const pn = a.testing.flattenPanes(a.testing.aw().layout)[0];
      a.testing.splitPaneWithTab(pn.id, pn.tabs[1].id, pn.id, 'right');
    });
    await expect.poll(async () => (await panes(page)).list.length).toBe(2);
    const p = await panes(page);
    await expect(diffPath(page, p.list[0].id)).toHaveText('a.txt');
    await expect(diffPath(page, p.list[1].id)).toHaveText('b.txt');
  });
});

test.describe('TC-RTB-2 — Changes 행 더블클릭은 Diff 를 고정한다 (FR-RTB-6 ③)', () => {
  test('더블클릭하면 기울임이 풀리고 다음 클릭은 새 미리보기다', async ({ page, request }) => {
    await enter(page, request);
    await changeRow(page, 'a.txt').dblclick();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', false)]);
    await changeRow(page, 'b.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', false), D('b.txt', true)]);
  });
});

test.describe('TC-RTB-2 — Diff 미리보기의 수정·저장 고정 (FR-RTB-6 ④⑤)', () => {
  const mod = (page: Page) => page.locator('#area .ed-area .git-view.git-diff .git-diff-side-mod .cm-content');

  test('④ 수정 가능한 오른쪽에서 입력하면 고정된다', async ({ page, request }) => {
    await enter(page, request);
    await changeRow(page, 'a.txt').click();
    await expect(mod(page)).toContainText('a.txt changed', { timeout: 10000 });
    await mod(page).click();
    await page.keyboard.type('x');
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', false)]);
  });

  test('⑤ 수정 없이 저장해도 고정된다', async ({ page, request }) => {
    await enter(page, request);
    await changeRow(page, 'b.txt').click();
    await expect(mod(page)).toContainText('b.txt changed', { timeout: 10000 });
    await mod(page).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('b.txt', false)]);
  });
});

test.describe('TC-RTB-6 — Diff 의 ‹ › (FR-RTB-9)', () => {
  const next = (page: Page) => page.locator('#area .ed-area .git-view.git-diff .git-diff-nav[data-nav="next"]');

  test('미리보기 Diff 에서 › 는 그 탭의 대상을 바꾼다', async ({ page, request }) => {
    await enter(page, request);
    await changeRow(page, 'a.txt').click();
    await expect(diffPath(page)).toHaveText('a.txt');
    await next(page).click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('b.txt', true)]);
    await expect(diffPath(page)).toHaveText('b.txt');
  });

  test('고정 Diff 에서 › 는 그 탭을 두고 같은 칸에 미리보기 Diff 로 다음 파일을 연다', async ({ page, request }) => {
    await enter(page, request);
    await changeRow(page, 'a.txt').dblclick();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', false)]);
    await expect(diffPath(page)).toHaveText('a.txt');
    await next(page).click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', false), D('b.txt', true)]);
    await expect(diffPath(page)).toHaveText('b.txt');
  });
});

test.describe('TC-RTB-5 — Diff 탭은 새로고침을 넘는다 (FR-RTB-13)', () => {
  test('미리보기 상태와 대상이 되살아난다', async ({ page, request }) => {
    await enter(page, request);
    await changeRow(page, 'a.txt').dblclick();
    await changeRow(page, 'c.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', false), D('c.txt', true)]);

    await page.evaluate(() => (window as any).app.testing.save());
    await page.reload();
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([D('a.txt', false), D('c.txt', true)]);
    await expect(diffPath(page)).toHaveText('c.txt');
    await mainTabs(page).first().click();
    await expect(diffPath(page)).toHaveText('a.txt');
  });
});
