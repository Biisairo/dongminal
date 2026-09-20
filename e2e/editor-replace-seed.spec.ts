/**
 * EDITOR_REPLACE_AND_SEED_SRS §5 — V-ERS-1~10.
 *
 * 접수한 둘은 화면이 다르지만 **같은 결핍**이다 — 찾기가 거기서 끝난다.
 * 찾은 것을 고칠 길이 없고(묶음 R), 고를 것을 이미 골라 두었는데 다시 쳐야
 * 한다(묶음 S).
 */
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot, openExplorerSide } from './fixtures';
import { TMP, realPath } from './osenv';

const j = (...p: string[]) => path.join(...p);
const P = (rel: string) => j(ROOT, ...rel.split('/'));
let BASE = '';
let ROOT = '';

// `needle` 셋 · `Needle` 하나. **대소문자 옵션은 기본이 꺼짐이므로 `needle` 을
// 찾으면 넷이 걸린다** — 이 파일의 기대 수(4)는 그 사실을 적은 것이다.
const BODY = [
  'alpha needle one',
  'beta Needle two',
  'gamma needle three',
  'delta needle four',
  '',
].join('\n');
// 캡처 치환용. `a_b` → `b_a` 를 한 번에 한다.
const CAPS = ['left_right', 'up_down', ''].join('\n');

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-ers-')));
  ROOT = j(BASE, 'root');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(j(ROOT, 'rep.txt'), BODY);
  fs.writeFileSync(j(ROOT, 'caps.txt'), CAPS);
  ROOT = realPath(ROOT);
});
test.afterAll(() => { rmTree(BASE) });

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: ROOT } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  // 앞선 스펙이 켠 토글(정규식·바꾸기 줄)이 따라오면 전제를 잃는다 (FR-EFP-23).
  await page.context().addInitScript(() => { try { localStorage.removeItem('edFindOpts') } catch { /* 사생활 모드 */ } });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, ROOT);
  await openExplorerSide(page);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

async function openFile(page: Page, name: string) {
  await page.evaluate((p) => (window as any).app.testing.edOpenFile(p), P(name));
  await page.waitForFunction((n) => {
    const v = (window as any).app.testing.edActiveEditor();
    return !!(v && v._editor && new RegExp('[\\\\/]' + n + '$').test(String(v.filePath)) && v.el.offsetParent !== null);
  }, name, { timeout: 20000 });
}

async function focusBody(page: Page) {
  await page.locator('.file-editor:visible .monaco-editor .view-lines').first().click();
  await page.waitForFunction(
    () => !!document.activeElement?.closest('.monaco-editor'), undefined, { timeout: 5000 });
}

const panel = (page: Page) => page.locator('.fe-find.vis:visible');
const q = (page: Page) => page.locator('.fe-find.vis:visible .fe-find-q');
const rep = (page: Page) => page.locator('.fe-find.vis:visible .fe-find-r');
const toggle = (page: Page) => page.locator('.fe-find.vis:visible .fe-find-toggle');
const repOne = (page: Page) => page.locator('.fe-find.vis:visible .fe-find-rep-one');
const repAll = (page: Page) => page.locator('.fe-find.vis:visible .fe-find-rep-all');
const count = (page: Page) => page.locator('.fe-find.vis:visible .fe-find-count');
const opt = (page: Page, k: string) =>
  page.locator(`.fe-find.vis:visible .fe-find-opt[data-opt="${k}"]`);

const docText = (page: Page) => page.evaluate(
  () => (window as any).app.testing.edActiveEditor()?._editor?.getModel()?.getValue() ?? '');

async function openFind(page: Page) {
  await page.keyboard.press('Control+f');
  await expect(panel(page)).toBeVisible({ timeout: 5000 });
}

/** 찾기를 열고 질의를 채운다. 일치 수가 실제로 설 때까지 기다린다. */
async function find(page: Page, needle: string) {
  await openFind(page);
  await q(page).fill(needle);
  await expect(count(page)).not.toHaveText('', { timeout: 5000 });
}

async function openReplaceRow(page: Page) {
  if (!(await repOne(page).isVisible())) await toggle(page).click();
  await expect(repOne(page)).toBeVisible({ timeout: 5000 });
}

test.describe('찾은 것을 바꾼다 (묶음 R)', () => {
  // V-ERS-1 · FR-ERS-1
  test('바꾸기 줄은 기본 접힘이고 토글로 열린다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'rep.txt');
    await focusBody(page);
    await openFind(page);

    await expect(repOne(page), '바꾸기 줄이 처음부터 열려 있다').toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await toggle(page).click();
    await expect(repOne(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
  });

  // V-ERS-2 · FR-ERS-2
  test('토글 상태는 패널을 닫았다 열어도 남는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'rep.txt');
    await focusBody(page);
    await openFind(page);
    await toggle(page).click();
    await expect(repOne(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden({ timeout: 5000 });
    await focusBody(page);
    await openFind(page);
    await expect(repOne(page), '열어 둔 줄이 접힌 채 돌아왔다').toBeVisible();
  });

  // V-ERS-3 · FR-ERS-4
  test('바꾸기는 현재 일치 하나만 고친다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'rep.txt');
    await focusBody(page);
    await find(page, 'needle');
    await openReplaceRow(page);

    await rep(page).fill('pin');
    await repOne(page).click();

    const t = await docText(page);
    expect(t.split('pin').length - 1, '하나만 바뀌어야 한다').toBe(1);
    expect(t.split('needle').length - 1).toBe(2);
  });

  // V-ERS-4 · FR-ERS-5 — 되돌리기가 사용자의 일이 되면 안 된다 (D-3).
  test('모두 바꾸기 뒤 undo 한 번에 전부 돌아온다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'rep.txt');
    await focusBody(page);
    await find(page, 'needle');
    await openReplaceRow(page);

    await rep(page).fill('pin');
    await repAll(page).click();

    // 대소문자를 가리지 않으므로 `Needle` 까지 넷이 바뀐다.
    await expect.poll(async () => (await docText(page)).split('pin').length - 1,
      { timeout: 5000 }).toBe(4);
    expect((await docText(page)).toLowerCase()).not.toContain('needle');

    await focusBody(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => docText(page), { timeout: 5000 }).toBe(BODY);
  });

  // V-ERS-5 · FR-ERS-6
  test('정규식이 켜지면 $1 이 캡처로 바뀐다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'caps.txt');
    await focusBody(page);
    await openFind(page);
    await opt(page, 'regex').click();
    await q(page).fill('(\\w+)_(\\w+)');
    await expect(count(page)).not.toHaveText('', { timeout: 5000 });
    await openReplaceRow(page);

    await rep(page).fill('$2_$1');
    await repAll(page).click();

    await expect.poll(() => docText(page), { timeout: 5000 }).toBe(['right_left', 'down_up', ''].join('\n'));
  });

  // V-ERS-6 · FR-ERS-6 — 꺼져 있으면 `$` 는 글자다.
  test('정규식이 꺼져 있으면 $1 은 글자 그대로 들어간다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'rep.txt');
    await focusBody(page);
    await find(page, 'needle');
    await openReplaceRow(page);

    await rep(page).fill('$1');
    await repAll(page).click();

    await expect.poll(async () => (await docText(page)).split('$1').length - 1,
      { timeout: 5000 }).toBe(4);
  });

  // V-ERS-7 · FR-ERS-7
  test('일치가 없으면 두 버튼이 비활성이다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'rep.txt');
    await focusBody(page);
    await openFind(page);
    await openReplaceRow(page);

    await expect(repOne(page)).toBeDisabled();
    await q(page).fill('needle');
    await expect(repOne(page)).toBeEnabled({ timeout: 5000 });
    await q(page).fill('zzz-no-such-word');
    await expect(repOne(page)).toBeDisabled({ timeout: 5000 });
    await expect(repAll(page)).toBeDisabled();
  });
});

test.describe('고른 것을 들고 들어간다 (묶음 S)', () => {
  const gq = (page: Page) => page.locator('.ed-find.vis .ed-find-q');

  /** 편집기에서 한 줄 안의 글자를 고른다. */
  async function select(page: Page, line: number, from: number, to: number) {
    await page.evaluate(({ line, from, to }) => {
      const ed = (window as any).app.testing.edActiveEditor()._editor;
      ed.setSelection({ startLineNumber: line, startColumn: from, endLineNumber: line, endColumn: to });
    }, { line, from, to });
  }

  // V-ERS-8 · FR-ERS-20·22
  test('한 줄 선택은 전체 검색에 실리고 전체 선택돼 있다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'rep.txt');
    await focusBody(page);
    await select(page, 1, 7, 13); // "needle"

    await page.keyboard.press('Control+Shift+f');
    await expect(gq(page)).toBeVisible({ timeout: 5000 });
    await expect(gq(page)).toHaveValue('needle');
    // 한 번의 타이핑으로 갈아 칠 수 있어야 한다 — 전체가 선택돼 있다.
    const all = await gq(page).evaluate(
      (el: HTMLInputElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length);
    expect(all, '실린 글자가 전체 선택되지 않았다').toBeTruthy();
  });

  // V-ERS-9 · FR-ERS-21
  test('여러 줄 선택은 싣지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'rep.txt');
    await focusBody(page);
    await page.evaluate(() => {
      const ed = (window as any).app.testing.edActiveEditor()._editor;
      ed.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 5 });
    });

    await page.keyboard.press('Control+Shift+f');
    await expect(gq(page)).toBeVisible({ timeout: 5000 });
    await expect(gq(page)).toHaveValue('');
  });

  // V-ERS-10 · FR-ERS-23 — 파일 **이름**을 찾는 칸에 본문 조각을 넣지 않는다.
  test('파일 찾기는 선택이 있어도 빈 칸이다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'rep.txt');
    await focusBody(page);
    await select(page, 1, 7, 13);

    await page.keyboard.press('Control+p');
    await expect(gq(page)).toBeVisible({ timeout: 5000 });
    await expect(gq(page)).toHaveValue('');
  });
});
