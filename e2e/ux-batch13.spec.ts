/**
 * UX_BATCH13_SRS — Activity 접기 단추 방향(FR-ACB) · 편집기 줄 이동(FR-EGL).
 */
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { ED_SEL } from './editor';
import { test, expect, rmTree, switchToEditorRoot, openExplorerSide, waitForInit, nextFrames } from './fixtures';
import { TMP, realPath } from './osenv';

const j = (...p: string[]) => path.join(...p);
let BASE = '';
let ROOT = '';
const BODY = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-ub13-')));
  ROOT = j(BASE, 'root');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(j(ROOT, 'g.txt'), BODY);
  ROOT = realPath(ROOT);
});
test.afterAll(() => { rmTree(BASE) });

const icon = (page: Page) => page.locator('#agents-panel .ag-collapse use').first().getAttribute('href');

test.describe('FR-ACB — Activity 접기 단추', () => {
  test('ACB1: 오른쪽·왼쪽에서 방향이 바뀐다', async ({ page }) => {
    await waitForInit(page, { mode: 'desktop', clearOnFirstLoad: ['panelDock', 'agentsPanelOpen'] });
    expect(await icon(page)).toContain('chevron-left');           // 오른쪽 레일
    await page.locator('#agents-panel .ag-collapse').click();
    expect(await icon(page)).toContain('chevron-right');          // 오른쪽 펼침
    await page.evaluate(() => (window as any).app.testing.setPanelDock({ left: ['activity', 'sidebar'], right: [] }));
    await nextFrames(page);
    expect(await icon(page)).toContain('chevron-left');           // 왼쪽 펼침
    await page.locator('#agents-panel .ag-collapse').click();
    expect(await icon(page)).toContain('chevron-right');          // 왼쪽 레일
  });

  test('ACB2: 모바일에서는 위로 접는다', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile', clearOnFirstLoad: ['panelDock', 'agentsPanelOpen'] });
    await page.evaluate(() => (window as any).app.setAgentsPanelOpen(true));
    await nextFrames(page);
    expect(await icon(page)).toContain('chevron-up');
  });
});

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: ROOT } });
  expect(r.ok()).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(() => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, ROOT);
  await openExplorerSide(page);
  await page.evaluate((p) => (window as any).app.testing.edOpenFile(p), j(ROOT, 'g.txt'));
  await page.waitForFunction(() => {
    const v = (window as any).app.testing.edActiveEditor();
    return !!(v && v._view && v.el.offsetParent !== null);
  }, undefined, { timeout: 20000 });
  await page.locator(`.file-editor:visible ${ED_SEL.surface} ${ED_SEL.text}`).first().click();
}

const goto = (page: Page) => page.locator('.fe-goto.vis:visible');
const cursor = (page: Page) => page.evaluate(() => { const h = edT.of((window as any).app.testing.edActiveEditor()); return edT.cursor(h) });

test.describe('FR-EGL — 줄 이동', () => {
  test('EGL1: Ctrl+G 로 열고 줄:열 로 옮긴다', async ({ page, request }) => {
    await enter(page, request);
    await page.keyboard.press('Control+g');
    await expect(goto(page)).toBeVisible();
    await expect(page.locator(`${ED_SEL.surface} .cm-panels`)).toHaveCount(0);
    await expect(goto(page).locator('.fe-goto-q')).toBeFocused();
    await expect(goto(page).locator('.fe-goto-q')).toHaveAttribute('placeholder', /201/);
    await page.keyboard.type('150:3');
    await page.keyboard.press('Enter');
    await expect(goto(page)).toHaveCount(0);
    expect(await cursor(page)).toEqual({ line: 150, col: 3 });
    await page.keyboard.type('X');   // 편집기에 포커스가 돌아왔다
    expect(await page.evaluate(() => { const h = edT.of((window as any).app.testing.edActiveEditor()); return edT.text(h).split('\n')[149] })).toBe('liXne 150');
  });

  test('EGL2: 잘못된 값은 오류 표시, Esc 는 닫는다, 찾기와는 하나만 연다', async ({ page, request }) => {
    await enter(page, request);
    await page.keyboard.press('Control+g');
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');
    await expect(page.locator('.fe-goto.vis.bad')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(goto(page)).toHaveCount(0);
    await page.keyboard.press('Control+g');
    await expect(goto(page)).toBeVisible();
    await page.keyboard.press('Control+f');
    await expect(page.locator('.fe-find.vis:visible')).toBeVisible();
    await expect(goto(page)).toHaveCount(0);
    await page.keyboard.press('Control+g');
    await expect(page.locator('.fe-find.vis:visible')).toHaveCount(0);
  });
});
