/**
 * UX_BATCH12_SRS §3.5f FR-RTB — Repo 창의 탭: 칸마다 미리보기 (묶음 1, 편집기).
 *
 * TC-RTB-1: 미리보기는 지금 칸에 서고 다른 칸을 건드리지 않는다 (FR-RTB-1·2·4).
 * TC-RTB-2: 고정 계기 중 편집기 쪽 — 수정 시작·저장 (FR-RTB-6 ④⑤).
 *           탭 더블클릭·Explorer 행 더블클릭은 repo-tab.spec P2·X5 가 잰다.
 */
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot, openExplorerSide, gotoWithEditors } from './fixtures';
import { ED_SEL } from './editor';
import { TMP, realPath, cssPath } from './osenv';

let ROOT = '';
const j = (...p: string[]) => path.join(...p);

test.beforeAll(() => {
  ROOT = realPath(fs.mkdtempSync(j(TMP, 'dm-rtb-')));
  for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(j(ROOT, n + '.txt'), n + '\n');
});
test.afterAll(() => rmTree(ROOT));

// 한 번 클릭으로 연 탭이 다음 시험에 남지 않게 시험마다 새 파일을 쓴다.
test.beforeEach(() => {
  for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(j(ROOT, n + '.txt'), n + '\n');
});

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: ROOT } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await gotoWithEditors(page);
  await switchToEditorRoot(page, ROOT);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
  await openExplorerSide(page);
  await expect(row(page, 'a.txt')).toBeVisible({ timeout: 10000 });
}

const row = (page: Page, n: string) =>
  page.locator(`#area .ed-side .ed-tree .ed-row[data-path="${cssPath(j(ROOT, n))}"]`);

type PaneInfo = { id: string; tabs: { name: string; preview: boolean }[]; active: string };

async function panes(page: Page): Promise<{ focused: string; list: PaneInfo[] }> {
  return page.evaluate(() => {
    const a = (window as any).app;
    const w = a.testing.aw();
    const list = a.testing.flattenPanes(w.layout).map((pn: any) => {
      const act = pn.tabs.find((x: any) => x.id === pn.activeTab);
      return {
        id: pn.id,
        tabs: pn.tabs.map((x: any) => ({ name: String(x.filePath || '').split(/[\\/]/).pop(), preview: !!x.preview })),
        active: act ? String(act.filePath || '').split(/[\\/]/).pop() : '',
      };
    });
    return { focused: w.focusedPane, list };
  });
}

// 왼쪽 칸에 a.txt, 오른쪽 칸에 b.txt (둘 다 고정). 끝나면 오른쪽 칸이 포커스다.
async function twoPanes(page: Page) {
  await row(page, 'a.txt').dblclick();
  await row(page, 'b.txt').dblclick();
  await expect.poll(async () => (await panes(page)).list[0].tabs.length).toBe(2);
  await page.evaluate(() => {
    const a = (window as any).app;
    const pn = a.testing.flattenPanes(a.testing.aw().layout)[0];
    const tab = pn.tabs[1];
    a.testing.splitPaneWithTab(pn.id, tab.id, pn.id, 'right');
  });
  await expect.poll(async () => (await panes(page)).list.length).toBe(2);
  const p = await panes(page);
  expect(p.focused).toBe(p.list[1].id);
  return p;
}

const paneTab = (page: Page, paneId: string) => page.locator(`#area .ed-area .pn[data-paneid="${paneId}"] .pn-tab`);

test.describe('TC-RTB-1 — 미리보기는 지금 칸에 선다 (FR-RTB-1·2·4)', () => {
  test('오른쪽 칸 포커스에서 연 미리보기는 오른쪽 칸에 서고 왼쪽은 그대로다', async ({ page, request }) => {
    await enter(page, request);
    const two = await twoPanes(page);
    const [L, R] = two.list.map((x) => x.id);

    await row(page, 'c.txt').click();
    await expect.poll(async () => (await panes(page)).list[1].tabs).toEqual([
      { name: 'b.txt', preview: false }, { name: 'c.txt', preview: true },
    ]);
    const p = await panes(page);
    expect(p.list[0].tabs).toEqual([{ name: 'a.txt', preview: false }]);
    expect(p.focused).toBe(R);

    // 왼쪽 칸으로 옮겨 다른 파일을 연다 — 칸마다 미리보기가 하나씩 선다.
    await paneTab(page, L).first().click();
    await expect.poll(async () => (await panes(page)).focused).toBe(L);
    await row(page, 'd.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([
      { name: 'a.txt', preview: false }, { name: 'd.txt', preview: true },
    ]);
    const q = await panes(page);
    expect(q.list[1].tabs).toEqual([{ name: 'b.txt', preview: false }, { name: 'c.txt', preview: true }]);
    expect(q.focused).toBe(L);
  });

  test('다른 칸에만 열린 파일은 지금 칸에 미리보기로 열리고 포커스가 남는다', async ({ page, request }) => {
    await enter(page, request);
    const two = await twoPanes(page);
    const [L] = two.list.map((x) => x.id);

    await paneTab(page, L).first().click();
    await expect.poll(async () => (await panes(page)).focused).toBe(L);
    // b.txt 는 오른쪽 칸에 고정돼 있다.
    await row(page, 'b.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([
      { name: 'a.txt', preview: false }, { name: 'b.txt', preview: true },
    ]);
    const p = await panes(page);
    expect(p.focused).toBe(L);
    expect(p.list[0].active).toBe('b.txt');
    expect(p.list[1].tabs).toEqual([{ name: 'b.txt', preview: false }]);
  });

  test('지금 칸에 같은 파일의 탭이 있으면 새로 만들지 않고 그 탭으로 간다', async ({ page, request }) => {
    await enter(page, request);
    await twoPanes(page);
    await row(page, 'c.txt').click();
    await expect.poll(async () => (await panes(page)).list[1].active).toBe('c.txt');

    await row(page, 'b.txt').click();
    await expect.poll(async () => (await panes(page)).list[1].active).toBe('b.txt');
    const p = await panes(page);
    expect(p.list[1].tabs).toEqual([{ name: 'b.txt', preview: false }, { name: 'c.txt', preview: true }]);
    expect(p.list[0].tabs).toEqual([{ name: 'a.txt', preview: false }]);
  });

  test('Explorer 더블클릭은 지금 칸의 미리보기를 고정한다', async ({ page, request }) => {
    await enter(page, request);
    const two = await twoPanes(page);
    const [L] = two.list.map((x) => x.id);
    // 오른쪽 칸에도 c.txt 미리보기를 둔다 — 고정 대상은 지금(왼쪽) 칸의 것이어야 한다.
    await row(page, 'c.txt').click();
    await expect.poll(async () => (await panes(page)).list[1].active).toBe('c.txt');
    await paneTab(page, L).first().click();
    await expect.poll(async () => (await panes(page)).focused).toBe(L);

    await row(page, 'c.txt').dblclick();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([
      { name: 'a.txt', preview: false }, { name: 'c.txt', preview: false },
    ]);
    expect((await panes(page)).list[1].tabs).toEqual([
      { name: 'b.txt', preview: false }, { name: 'c.txt', preview: true },
    ]);
  });
});

test.describe('TC-RTB-2 — 편집기 미리보기의 고정 계기 (FR-RTB-6 ④⑤)', () => {
  test('④ 미리보기에서 입력하면 고정된다', async ({ page, request }) => {
    await enter(page, request);
    await row(page, 'a.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([{ name: 'a.txt', preview: true }]);
    const text = page.locator(`#area .ed-area ${ED_SEL.text}`).first();
    await expect(text).toContainText('a', { timeout: 10000 });
    await text.click();
    await page.keyboard.type('x');
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([{ name: 'a.txt', preview: false }]);
  });

  test('⑤ 수정 없이 저장해도 고정된다', async ({ page, request }) => {
    await enter(page, request);
    await row(page, 'a.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([{ name: 'a.txt', preview: true }]);
    const text = page.locator(`#area .ed-area ${ED_SEL.text}`).first();
    await expect(text).toContainText('a', { timeout: 10000 });
    await text.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([{ name: 'a.txt', preview: false }]);
    // 다음 클릭은 새 미리보기 탭이다 (FR-RTB-5).
    await row(page, 'b.txt').click();
    await expect.poll(async () => (await panes(page)).list[0].tabs).toEqual([
      { name: 'a.txt', preview: false }, { name: 'b.txt', preview: true },
    ]);
  });
});
