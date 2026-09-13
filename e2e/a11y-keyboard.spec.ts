import * as fs from 'fs';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled, addEditor, rmTree, enterExplorer } from './fixtures';
import { TMP, realPath } from './osenv';

// ACCESSIBILITY_BASELINE_SRS §5.1 — TC-A11Y-6·7 (FR-A11Y-16·17 / M7 `UX-4`).
//
// **재는 것은 "역할이 붙었다" 가 아니라 "키보드만으로 간다" 다.** `role=option`
// 은 한 줄이고, 그것만으로는 `Tab` 이 거기 닿지도 화살표가 움직이지도 않는다.
// 그래서 셋을 **동작으로** 단정한다: ① `Tab` 이 닿는다 ② 화살표가 포커스만
// 옮긴다 (활성은 그대로) ③ `Enter` 가 클릭과 같은 일을 한다.
//
// 도달은 "N 번 안에 닿는가" 로 잰다 — 순서를 손으로 적으면 컨트롤이 하나 늘 때
// 깨지고, 그 실패는 접근성이 아니라 목록의 실패다 (D-A11Y-3 과 같은 규약).

/** 지금 포커스를 가진 요소가 `sel` 에 맞는가. */
const focusedIs = (page: Page, sel: string) =>
  page.evaluate((s) => !!document.activeElement && document.activeElement.matches(s), sel);

/** 포커스를 문서 밖(`body`)으로 돌린다 — `Tab` 이 문서 맨 앞에서 출발한다. */
const blurAll = (page: Page) =>
  page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() });

/**
 * `Tab` 을 눌러 `sel` 에 닿을 때까지 간다. `cap` 안에 닿지 않으면 그것이 결함이다
 * — xterm·Monaco 는 `Tab` 을 먹으므로 거기 들어가면 더 가지 못한다(E-1·E-2).
 */
async function tabTo(page: Page, sel: string, cap = 60) {
  for (let i = 0; i < cap; i++) {
    if (await focusedIs(page, sel)) return i;
    await page.keyboard.press('Tab');
  }
  const at = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return a ? `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}.${a.className}` : 'null';
  });
  throw new Error(`Tab ${cap}번 안에 ${sel} 에 닿지 못했다 — 지금은 ${at}`);
}

const activeWindow = (page: Page) => page.evaluate(() => (window as any).app.ws.activeWindow);
const focusedSid = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.sid || '');

/** 창을 하나 더 만든다. 목록에 둘은 있어야 화살표가 갈 곳이 있다. */
async function ensureTwoWindows(page: Page) {
  const n = await page.locator('#windows .si').count();
  if (n >= 2) return;
  await page.evaluate(() => (window as any).app.addWindow());
  await expect(page.locator('#windows .si')).toHaveCount(n + 1, { timeout: 10000 });
  await waitSettled(page);
}

test.describe('접근성 — 목록·탭·트리의 키보드 (FR-A11Y-16 / UX-4)', () => {
  test('TC-A11Y-6a: 창 목록 — Tab 이 닿고 화살표가 옮기고 Enter 가 연다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await ensureTwoWindows(page);
    const before = await activeWindow(page);

    await blurAll(page);
    await tabTo(page, '#windows [role=option]');
    // Tab 이 닿는 자리는 **활성 창**이다 — roving tabindex 는 하나만 Tab 에 둔다.
    expect(await focusedSid(page)).toBe(before);
    await expect(page.locator('#windows [role=option]:focus')).toHaveAttribute('aria-selected', 'true');
    expect(await page.evaluate(() => document.getElementById('windows')?.getAttribute('role'))).toBe('listbox');

    // 화살표는 **포커스만** 옮긴다. 활성 창이 따라오면 그것은 목록 훑기가 창
    // 전환이 되는 것이고, 창 전환은 터미널이 포커스를 가져간다 (D-A11Y-12).
    const idx = await page.evaluate(() =>
      [...document.querySelectorAll('#windows [role=option]')].indexOf(document.activeElement!));
    await page.keyboard.press(idx === 0 ? 'ArrowDown' : 'ArrowUp');
    const target = await focusedSid(page);
    expect(target).toBeTruthy();
    expect(target).not.toBe(before);
    expect(await activeWindow(page)).toBe(before);

    // Enter 는 클릭이다 — 창이 바뀌고 포커스는 터미널로 간다 (마우스와 같다).
    await page.keyboard.press('Enter');
    await expect.poll(() => activeWindow(page), { timeout: 10000 }).toBe(target);
    await expect.poll(() => focusedIs(page, '.xterm-helper-textarea'), { timeout: 10000 }).toBe(true);
  });

  test('TC-A11Y-6a-del: 창 목록 — Delete 가 × 와 같은 일을 한다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await ensureTwoWindows(page);
    const n = await page.locator('#windows .si').count();
    const active = await activeWindow(page);

    await blurAll(page);
    await tabTo(page, '#windows [role=option]');
    // 활성이 아닌 창을 고른다 — 지우는 것이 지금 보는 창이면 화면이 통째로 바뀐다.
    const idx = await page.evaluate(() =>
      [...document.querySelectorAll('#windows [role=option]')].indexOf(document.activeElement!));
    await page.keyboard.press(idx === 0 ? 'ArrowDown' : 'ArrowUp');
    const victim = await focusedSid(page);
    expect(victim).not.toBe(active);

    await page.keyboard.press('Delete');
    await expect(page.locator('#windows .si')).toHaveCount(n - 1, { timeout: 10000 });
    await expect(page.locator(`#windows .si[data-sid="${victim}"]`)).toHaveCount(0);
  });

  test('TC-A11Y-6b: 분할 칸 탭 — tablist/tab 이고 화살표+Enter 로 전환된다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const tabs = page.locator('#area .pn.focused [role=tablist] [role=tab]');
    if ((await tabs.count()) < 2) {
      await page.evaluate(() => (window as any).app.addTabFocused());
      await expect(tabs).toHaveCount(2, { timeout: 10000 });
      await waitSettled(page);
    }
    // `+` 는 tablist 의 자식이 아니다 — 자식이 `tab` 뿐이어야 한다 (D-A11Y-11).
    expect(await page.evaluate(() =>
      [...document.querySelectorAll('#area .pn.focused [role=tablist] > *')]
        .every((e) => e.getAttribute('role') === 'tab'))).toBe(true);

    const state = () => page.evaluate(() =>
      [...document.querySelectorAll('#area .pn.focused [role=tab]')].map((e) => ({
        id: (e as HTMLElement).dataset.tabId,
        active: e.classList.contains('active'),
        sel: e.getAttribute('aria-selected'),
        focused: e === document.activeElement,
      })));
    const same = (rows: { active: boolean; sel: string | null }[]) =>
      rows.every((r) => r.sel === (r.active ? 'true' : 'false')) && rows.filter((r) => r.active).length === 1;

    await blurAll(page);
    await tabTo(page, '#area .pn.focused [role=tab]');
    let rows = await state();
    expect(same(rows)).toBe(true);
    // Tab 이 닿는 것은 **활성 탭**이다.
    expect(rows.find((r) => r.focused)?.active).toBe(true);

    const i = rows.findIndex((r) => r.focused);
    await page.keyboard.press(i === 0 ? 'ArrowRight' : 'ArrowLeft');
    rows = await state();
    const want = rows.find((r) => r.focused)!;
    expect(want.active).toBe(false);
    // 화살표는 활성을 바꾸지 않는다.
    expect(rows.filter((r) => r.active).length).toBe(1);

    await page.keyboard.press('Enter');
    await expect(page.locator(`#area .pn.focused .pn-tab[data-tab-id="${want.id}"]`))
      .toHaveClass(/active/, { timeout: 10000 });
    rows = await state();
    expect(same(rows)).toBe(true);
  });

  test('TC-A11Y-6b-del: 분할 칸 탭 — Delete 가 × 와 같은 일을 한다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const tabs = page.locator('#area .pn.focused .pn-tab');
    if ((await tabs.count()) < 2) {
      await page.evaluate(() => (window as any).app.addTabFocused());
      await expect(tabs).toHaveCount(2, { timeout: 10000 });
      await waitSettled(page);
    }
    const n = await tabs.count();

    await blurAll(page);
    await tabTo(page, '#area .pn.focused [role=tab]');
    const i = await page.evaluate(() =>
      [...document.querySelectorAll('#area .pn.focused [role=tab]')].indexOf(document.activeElement!));
    await page.keyboard.press(i === 0 ? 'ArrowRight' : 'ArrowLeft');
    const victim = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.tabId);
    await page.keyboard.press('Delete');
    // 실행 중이면 확인이 뜬다 (FR-BG-3) — × 클릭과 같은 길이다.
    const ok = page.locator('.confirm-overlay .confirm-ok');
    if (await ok.count()) await ok.first().click();
    await expect(tabs).toHaveCount(n - 1, { timeout: 10000 });
    await expect(page.locator(`#area .pn.focused .pn-tab[data-tab-id="${victim}"]`)).toHaveCount(0);
  });

  test('TC-A11Y-6d: 화살표로 옮긴 포커스가 render 를 살아남는다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await ensureTwoWindows(page);
    const before = await activeWindow(page);

    await blurAll(page);
    await tabTo(page, '#windows [role=option]');
    const idx = await page.evaluate(() =>
      [...document.querySelectorAll('#windows [role=option]')].indexOf(document.activeElement!));
    await page.keyboard.press(idx === 0 ? 'ArrowDown' : 'ArrowUp');
    const at = await focusedSid(page);
    expect(at).not.toBe(before);

    // SSE 한 번이면 render 가 돈다. 재포커스가 활성 도구로 포커스를 끌고 가면
    // 목록을 훑던 사람은 터미널에 떨어진다 — 탐색기가 FR-EXR-58 로 막은 함정이다.
    await page.evaluate(() => (window as any).app.render());
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await focusedSid(page)).toBe(at);
    expect(await activeWindow(page)).toBe(before);
  });
});

// ── 잡으면 안 되는 것 (FR-A11Y-25 의 반대편) ──────────────────

test.describe('접근성 — 키보드 계약이 마우스·입력을 건드리지 않는다 (D-A11Y-12)', () => {
  test('TC-A11Y-6e: 마우스로 창·탭을 고르면 종전대로 터미널이 포커스를 받는다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await ensureTwoWindows(page);
    const before = await activeWindow(page);
    // 활성이 아닌 창 행을 **누른다**. 행에 `tabindex` 가 생겼으므로 클릭이 행에
    // 포커스를 두는데, 재포커스는 마우스 포커스를 지키지 않아야 한다 — 지키면
    // 창을 고른 뒤 터미널에 글자를 칠 수 없다.
    await page.locator(`#windows .si:not([data-sid="${before}"])`).first().click();
    await expect.poll(() => activeWindow(page), { timeout: 10000 }).not.toBe(before);
    await expect.poll(() => focusedIs(page, '.xterm-helper-textarea'), { timeout: 10000 }).toBe(true);

    const tabs = page.locator('#area .pn.focused .pn-tab');
    if ((await tabs.count()) < 2) {
      await page.evaluate(() => (window as any).app.addTabFocused());
      await expect(tabs).toHaveCount(2, { timeout: 10000 });
      await waitSettled(page);
    }
    await page.locator('#area .pn.focused .pn-tab:not(.active)').first().click();
    await expect.poll(() => focusedIs(page, '.xterm-helper-textarea'), { timeout: 10000 }).toBe(true);
  });

  test('TC-A11Y-6f: 이름 변경 입력의 Enter·Backspace 는 입력의 것이다', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await ensureTwoWindows(page);
    const n = await page.locator('#windows .si').count();
    const row = page.locator('#windows .si').first();
    await row.locator('.si-name').dblclick();
    const input = page.locator('#windows .rename-input');
    await expect(input).toBeVisible();
    await input.fill('abc');
    // Backspace 가 행을 지우면 그것이 결함이다 (Delete 와 같은 키다).
    await page.keyboard.press('Backspace');
    await expect(input).toHaveValue('ab');
    await expect(page.locator('#windows .si')).toHaveCount(n);
    await page.keyboard.press('Enter');
    await expect(page.locator('#windows .si').first().locator('.si-name')).toHaveText('ab', { timeout: 10000 });
    await expect(page.locator('#windows .si')).toHaveCount(n);
  });
});

// ── 탐색기 (트리) ─────────────────────────────────────────

let BASE = '';
let ROOT = '';

test.describe('접근성 — 탐색기의 키보드 (FR-A11Y-16·17 / UX-4)', () => {
  test.beforeAll(() => {
    BASE = realPath(fs.mkdtempSync(path.join(TMP, 'dm-a11y-')));
    ROOT = path.join(BASE, 'root');
    fs.mkdirSync(path.join(ROOT, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sub', 'inner.txt'), 'inner\n');
    fs.writeFileSync(path.join(ROOT, 'alpha.txt'), 'alpha\n');
    ROOT = realPath(ROOT);
  });
  test.afterAll(() => { rmTree(BASE) });

  const tree = (page: Page) => page.locator('.ed-win .ed-explorer [role=tree]');
  const activeRow = (page: Page) => page.evaluate(() => {
    const t = document.querySelector('.ed-win .ed-explorer [role=tree]');
    const id = t?.getAttribute('aria-activedescendant') || '';
    const el = id ? document.getElementById(id) : null;
    return el ? {
      role: el.getAttribute('role'), kind: el.dataset.kind, path: el.dataset.path,
      sel: el.getAttribute('aria-selected'), exp: el.getAttribute('aria-expanded'),
      level: el.getAttribute('aria-level'),
    } : null;
  });

  test('TC-A11Y-6c: Tab 이 트리에 닿고 화살표가 activedescendant 를 옮긴다', async ({ page, request }) => {
    await enterExplorer(page, request, ROOT);
    await expect(tree(page)).toHaveCount(1);
    expect(await page.evaluate(() =>
      [...document.querySelectorAll('.ed-win .ed-explorer .ed-row')].every((e) => e.getAttribute('role') === 'treeitem'))).toBe(true);

    await blurAll(page);
    await tabTo(page, '.ed-win .ed-explorer [role=tree]');
    // 아직 고른 것이 없다 — 가리키는 행도 없다.
    expect(await activeRow(page)).toBeNull();

    await page.keyboard.press('ArrowDown');
    let row = await activeRow(page);
    expect(row).not.toBeNull();
    expect(row!.role).toBe('treeitem');
    expect(row!.sel).toBe('true');
    expect(row!.level).toBe('1');
    // 첫 행은 폴더(`sub`)다 — 정렬이 폴더를 앞세운다.
    expect(row!.kind).toBe('dir');
    expect(row!.exp).toBe('false');

    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await activeRow(page))?.exp, { timeout: 10000 }).toBe('true');
    // 펼침은 곧바로 표시되지만 자식 행은 조회 뒤에 선다 — 행이 서고 나서 내려간다.
    await expect(page.locator('.ed-win .ed-explorer [role=treeitem][aria-level="2"]').first())
      .toBeVisible({ timeout: 10000 });
    await page.keyboard.press('ArrowDown');
    row = await activeRow(page);
    expect(row!.level).toBe('2');
    expect(row!.path!.endsWith('inner.txt')).toBe(true);
    // 컨테이너가 포커스를 쥔 채다 — 행이 아니라 (D-A11Y-11).
    expect(await focusedIs(page, '.ed-win .ed-explorer [role=tree]')).toBe(true);
  });

  test('TC-A11Y-7: 단축키 없이 — Tab·화살표·Enter 만으로 파일이 열린다', async ({ page, request }) => {
    await addEditor(request, ROOT);
    await waitForInit(page, { clearLocalStorage: true });

    // ① 사이드바의 Repo 탭.
    await blurAll(page);
    await tabTo(page, '#sb-tabs .sb-tab[data-panel="repo"]');
    await page.keyboard.press('Enter');
    await expect(page.locator('#sb-panel-repo')).toBeVisible();

    // ② 그 루트의 행. 목록의 Tab 정지는 하나(활성 행)이므로 맨 위부터 화살표로 찾는다.
    await tabTo(page, '#sb-panel-repo [role=option]');
    await page.keyboard.press('Home');
    for (let i = 0; i < 20; i++) {
      const p = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.edRoot || '');
      if (p.replace(/\\/g, '/').toLowerCase() === ROOT.replace(/\\/g, '/').toLowerCase()) break;
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await expect.poll(async () => page.evaluate(() => {
      const a = (window as any).app;
      return String(a.testing.edRootOf(a.testing.aw()) || '').replace(/\\/g, '/').toLowerCase();
    }), { timeout: 15000 }).toBe(ROOT.replace(/\\/g, '/').toLowerCase());

    // ③ Explorer 사이드 (기본은 Changes 다 — FR-DSP-1).
    await blurAll(page);
    await tabTo(page, '#area .ed-win .ed-side-tab[data-side="explorer"]');
    await page.keyboard.press('Enter');
    await expect(tree(page)).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('.ed-win .ed-explorer .ed-row').first()).toBeVisible({ timeout: 10000 });

    // ④ 트리에서 파일 행까지 내려가 연다.
    await blurAll(page);
    await tabTo(page, '.ed-win .ed-explorer [role=tree]');
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('ArrowDown');
      const r = await activeRow(page);
      if (r?.kind === 'file') break;
    }
    const opened = (await activeRow(page))!;
    expect(opened.kind).toBe('file');
    await page.keyboard.press('Enter');
    const name = path.basename(opened.path!);
    await expect(page.locator('#area .pn-tab.active .pn-tab-label')).toHaveText(name, { timeout: 15000 });
    await expect(page.locator('#area .monaco-editor').first()).toBeVisible({ timeout: 15000 });
  });
});
