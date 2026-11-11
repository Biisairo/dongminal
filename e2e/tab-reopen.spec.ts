/**
 * UX_BATCH12_SRS §3.5g FR-RTR — 닫은 탭 다시 열기 · 뒤로·앞으로.
 *
 * TC-RTR-1: 편집기·Diff·History 탭을 닫고 Ctrl+Shift+U 셋 — 닫은 역순으로 원래 칸·위치에 보통 탭으로 (FR-RTR-1~5).
 *           터미널 탭은 되살아나지 않는다.
 * TC-RTR-2: 다시 연 편집기 탭은 닫을 때의 커서·스크롤이다 (FR-RTR-6).
 * TC-RTR-3: A → B 로 옮긴 뒤 A 를 닫고 뒤로가기 — A 가 그 자리에 다시 열린다 (FR-RTR-7).
 * TC-RTR-6: 마우스 4번은 앱의 뒤로가기를 돌리지 않고 기본 동작을 막지 않는다 (FR-RTR-11).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot, gotoWithEditors, waitForInit } from './fixtures';
import { TMP, realPath } from './osenv';

let REPO = '';
const j = (...p: string[]) => path.join(...p);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
const LONG_LINES = 300;

test.beforeAll(() => {
  const d = realPath(fs.mkdtempSync(j(TMP, 'dm-rtr-')));
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(j(d, f), f + ' base\n');
  fs.writeFileSync(j(d, 'long.txt'), Array.from({ length: LONG_LINES }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  fs.appendFileSync(j(d, 'b.txt'), 'b changed\n');
  REPO = d;
});
test.afterAll(() => rmTree(REPO));

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: REPO } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await gotoWithEditors(page);
  await switchToEditorRoot(page, REPO);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 10000 });
}

type TabInfo = { name: string; preview: boolean; kind: string; path: string };

async function tabs(page: Page): Promise<{ list: TabInfo[]; active: string; focused: boolean }> {
  return page.evaluate(() => {
    const a = (window as any).app;
    const w = a.testing.aw();
    const pn = w.layout ? a.testing.flattenPanes(w.layout)[0] : null;
    if (!pn) return { list: [], active: '', focused: false };
    const act = pn.tabs.find((x: any) => x.id === pn.activeTab);
    return {
      list: pn.tabs.map((x: any) => ({
        name: x.name, preview: !!x.preview,
        kind: x.type === 'git' ? x.gitView : x.type,
        path: x.diffTarget ? x.diffTarget.path : '',
      })),
      active: act ? act.name : '',
      focused: w.focusedPane === pn.id,
    };
  });
}

const openFile = (page: Page, name: string) => page.evaluate((p) => (window as any).app.edOpenFile(p), j(REPO, name));

async function closeByName(page: Page, name: string) {
  await page.evaluate((n) => {
    const a = (window as any).app;
    const pn = a.testing.flattenPanes(a.testing.aw().layout)[0];
    const tab = pn.tabs.find((x: any) => x.name === n);
    return a.closeTab(pn.id, tab.id);
  }, name);
}

const reopenKey = async (page: Page) => {
  await page.locator('#area .ed-win .ed-side').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+Shift+KeyU');
};

const E = (name: string) => ({ name, preview: false, kind: 'editor', path: '' });
const DIFF = { name: 'b.txt', preview: false, kind: 'diff', path: 'b.txt' };
const HIST = { name: 'History', preview: false, kind: 'history', path: '' };

test.describe('TC-RTR-1 — 닫은 탭을 역순으로 다시 연다 (FR-RTR-1~5)', () => {
  test('편집기·Diff·History 를 닫고 Ctrl+Shift+U 셋이면 원래 자리에 보통 탭으로 선다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'a.txt');
    const changeB = page.locator('#area .ed-side .git-view.git-changes .git-group[data-group="working"] .git-file[data-path="b.txt"]');
    await page.evaluate(() => { const a = (window as any).app; a.testing.edSetSide(a.testing.aw(), 'changes') });
    await changeB.dblclick();
    await page.evaluate(() => {
      const a = (window as any).app;
      const pn = a.testing.flattenPanes(a.testing.aw().layout)[0];
      return a.addTab(pn.id, 'git', { gitView: 'history' });
    });
    await expect.poll(async () => (await tabs(page)).list).toEqual([E('a.txt'), DIFF, HIST]);

    await closeByName(page, 'a.txt');
    await closeByName(page, 'History');
    await closeByName(page, 'b.txt');
    await expect.poll(async () => (await tabs(page)).list.length).toBe(0);

    await reopenKey(page);
    await expect.poll(async () => (await tabs(page)).list).toEqual([DIFF]);
    await reopenKey(page);
    await expect.poll(async () => (await tabs(page)).list).toEqual([DIFF, HIST]);
    await reopenKey(page);
    await expect.poll(async () => (await tabs(page)).list).toEqual([E('a.txt'), DIFF, HIST]);
    const st = await tabs(page);
    expect(st.active, '다시 연 탭이 활성이 아니다').toBe('a.txt');
    expect(st.focused, '다시 연 칸이 포커스가 아니다').toBe(true);
    await expect(page.locator('#area .ed-area .git-view.git-diff .git-diff-path')).toHaveCount(0);

    // 목록이 비었으면 아무 일도 없다.
    await reopenKey(page);
    await expect.poll(async () => (await tabs(page)).list.length).toBe(3);
  });

  test('같은 대상의 탭이 이미 있으면 새로 만들지 않고 그 탭으로 간다 (FR-RTR-5)', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'a.txt');
    await openFile(page, 'long.txt');
    await expect.poll(async () => (await tabs(page)).list.length).toBe(2);
    await closeByName(page, 'a.txt');
    await openFile(page, 'a.txt');
    await expect.poll(async () => (await tabs(page)).list.length).toBe(2);
    await openFile(page, 'long.txt');
    await reopenKey(page);
    await expect.poll(async () => (await tabs(page)).active).toBe('a.txt');
    expect((await tabs(page)).list.length).toBe(2);
  });

  test('터미널 탭은 다시 열리지 않는다', async ({ page }) => {
    await waitForInit(page);
    const pnTabs = page.locator('#area .pn.focused .pn-tab');
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(pnTabs).toHaveCount(2, { timeout: 15000 });
    await page.evaluate(() => { const a = (window as any).app; return a.closeTabFocused() });
    await expect(pnTabs).toHaveCount(1, { timeout: 15000 });
    await page.evaluate(() => (window as any).app.executeAction('tabReopen'));
    // **예외 (`TEST-16`)**: 터미널 탭이 **되살아나지 않음**을 잰다.
    await page.waitForTimeout(500);
    await expect(pnTabs).toHaveCount(1);
  });
});

test.describe('TC-RTR-2 — 다시 연 편집기는 커서·스크롤이 그대로다 (FR-RTR-6)', () => {
  test('스크롤·커서를 옮긴 뒤 닫고 다시 열면 같은 자리다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'a.txt');
    await openFile(page, 'long.txt');
    const view = () => page.evaluate(() => {
      const a = (window as any).app;
      const pn = a.testing.flattenPanes(a.testing.aw().layout)[0];
      const tab = pn.tabs.find((x: any) => x.name === 'long.txt');
      const ed = tab && a.editorAny(tab.id);
      const v = ed && ed._view;
      if (!v) return null;
      return { line: v.state.doc.lineAt(v.state.selection.main.head).number, top: Math.round(v.scrollDOM.scrollTop) };
    });
    await expect.poll(view).not.toBeNull();
    await page.evaluate(() => {
      const a = (window as any).app;
      const pn = a.testing.flattenPanes(a.testing.aw().layout)[0];
      const v = a.editorAny(pn.tabs.find((x: any) => x.name === 'long.txt').id)._view;
      v.dispatch({ selection: { anchor: v.state.doc.line(150).from } });
      v.scrollDOM.scrollTop = 1500;
    });
    await expect.poll(async () => (await view())!.top).toBeGreaterThan(1000);
    const before = (await view())!;
    expect(before.line).toBe(150);

    await closeByName(page, 'long.txt');
    await expect.poll(async () => (await tabs(page)).list.length).toBe(1);
    await reopenKey(page);
    await expect.poll(async () => (await view())?.line).toBe(150);
    await expect.poll(async () => Math.abs((await view())!.top - before.top)).toBeLessThan(40);
  });
});

test.describe('TC-RTR-3 — 뒤로가기가 닫힌 탭의 자리를 다시 연다 (FR-RTR-7)', () => {
  test('A → B 뒤 A 를 닫고 뒤로가기면 A 가 그 자리에 다시 열린다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'a.txt');
    await openFile(page, 'long.txt');
    await expect.poll(async () => (await tabs(page)).active).toBe('long.txt');
    await closeByName(page, 'a.txt');
    await expect.poll(async () => (await tabs(page)).list).toEqual([E('long.txt')]);
    await page.evaluate(() => (window as any).app.executeAction('focusBack'));
    await expect.poll(async () => (await tabs(page)).list).toEqual([E('a.txt'), E('long.txt')]);
    expect((await tabs(page)).active).toBe('a.txt');
    // 닫은 탭 목록에서 빠졌다 — 다시 열기가 둘째 a.txt 를 만들지 않는다.
    await page.evaluate(() => (window as any).app.executeAction('tabReopen'));
    // **예외 (`TEST-16`)**: 둘째 a.txt 가 **생기지 않음**을 잰다.
    await page.waitForTimeout(300);
    expect((await tabs(page)).list.length).toBe(2);
    // 앞으로가 long.txt 로 간다.
    await page.evaluate(() => (window as any).app.executeAction('focusForward'));
    await expect.poll(async () => (await tabs(page)).active).toBe('long.txt');
  });
});

test.describe('TC-RTR-6 — 마우스 4·5번은 브라우저의 것이다 (FR-RTR-11)', () => {
  test('마우스 4번 mousedown 은 자리를 옮기지 않고 막지도 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(2, { timeout: 15000 });
    const place = () => page.evaluate(() => (window as any).app.testing.navPlace());
    const before = await place();
    for (const b of [3, 4]) {
      const prevented = await page.evaluate((btn) => {
        const ev = new MouseEvent('mousedown', { button: btn, bubbles: true, cancelable: true });
        window.dispatchEvent(ev);
        const ax = new MouseEvent('auxclick', { button: btn, bubbles: true, cancelable: true });
        window.dispatchEvent(ax);
        return ev.defaultPrevented || ax.defaultPrevented;
      }, b);
      expect(prevented, `버튼 ${b} 의 기본 동작을 막았다`).toBe(false);
    }
    // **예외 (`TEST-16`)**: 자리가 **옮겨지지 않음**을 잰다.
    await page.waitForTimeout(300);
    expect(await place()).toEqual(before);
  });
});

test.describe('TC-RTR-7 — 뒤로·앞으로 버튼 (FR-RTR-13·14)', () => {
  test('Repo 창에서만 서고, 갈 곳이 없으면 비활성이다', async ({ page, request }) => {
    const back = page.locator('#topbar #nav-back');
    const fwd = page.locator('#topbar #nav-forward');
    await enter(page, request);
    await expect(back).toBeVisible();
    await expect(fwd).toBeVisible();
    // 슬롯 버튼의 왼쪽이다.
    const nb = (await page.locator('#topbar #nav-ctl').boundingBox())!;
    const sb = (await page.locator('#topbar .slot-ctl').boundingBox())!;
    expect(nb.x + nb.width, '버튼 묶음이 슬롯 버튼의 왼쪽이 아니다').toBeLessThanOrEqual(sb.x);
    // 첫 진입의 버튼 상태는 그 앞의 기록에 달렸다 — 앞길은 없다.
    await expect(fwd).toBeDisabled();

    await openFile(page, 'a.txt');
    await openFile(page, 'long.txt');
    await expect.poll(async () => (await tabs(page)).active).toBe('long.txt');
    await expect(back).toBeEnabled();
    await expect(fwd).toBeDisabled();

    await back.click();
    await expect.poll(async () => (await tabs(page)).active).toBe('a.txt');
    await expect(fwd).toBeEnabled();
    await fwd.click();
    await expect.poll(async () => (await tabs(page)).active).toBe('long.txt');
    await expect(fwd).toBeDisabled();

    // 터미널 창으로 가면 버튼이 서지 않는다.
    await page.evaluate(() => {
      const a = (window as any).app;
      const w = a.testing.plainWindows()[0];
      a.switchWindow(w.id);
    });
    await expect(back).toBeHidden();
    await expect(fwd).toBeHidden();
  });

  test('기록에 갈 수 있는 자리가 없으면 비활성이다 (닫힌 터미널 자리만 남음)', async ({ page }) => {
    await waitForInit(page);
    // 터미널 창에서는 버튼이 서지 않는다 — 판정 함수만 잰다.
    await page.locator('#area .pn.focused .pn-tab-add').click();
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(2, { timeout: 15000 });
    expect(await page.evaluate(() => (window as any).app.navCan(-1))).toBe(true);
    await page.evaluate(() => { const a = (window as any).app; return a.closeTab(a.focused, a.testing.aw().layout.tabs[0].id) });
    await expect(page.locator('#area .pn.focused .pn-tab')).toHaveCount(1, { timeout: 15000 });
    expect(await page.evaluate(() => (window as any).app.navCan(-1))).toBe(false);
  });
});
