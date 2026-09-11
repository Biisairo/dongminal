/**
 * VIEW_SCROLL_RESTORE_SRS §5.2 — V-VSR-1~7·10.
 *
 * 재려는 것은 접수한 말 그대로다: **"editor 가 스크롤값을 저장하지 않는다. 다른
 * 화면을 갔다오면 스크롤이 맨 아래로 가있는다."**
 *
 * 터미널 쪽(V-VSR-8·9)은 `regression-pane-scroll.spec.ts` 가 이미 그 자리를 재므로
 * 여기서 다시 쓰지 않는다 — 그쪽의 무변경 통과로 판정한다.
 */
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot, openExplorerSide, waitSettled } from './fixtures';
import { TMP, realPath } from './osenv';

const j = (...p: string[]) => path.join(...p);
let BASE = '';
let ROOT = '';

// 스크롤할 것이 있어야 시선이 뜻을 갖는다 — 편집기 높이보다 확실히 긴 파일.
const LONG = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const LONG_MD = '# 문서\n\n' +
  Array.from({ length: 200 }, (_, i) => `단락 ${i + 1} 의 본문.`).join('\n\n') + '\n';

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-vsr-')));
  ROOT = j(BASE, 'root');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(j(ROOT, 'long.txt'), LONG);
  fs.writeFileSync(j(ROOT, 'other.txt'), 'other\n');
  fs.writeFileSync(j(ROOT, 'long.md'), LONG_MD);
  ROOT = realPath(ROOT);
});
test.afterAll(() => {
  rmTree(BASE);
});

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: ROOT } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, ROOT);
  await openExplorerSide(page);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

/** 파일을 **고정 탭**으로 연다 — 한 번 클릭은 미리보기 탭이라 다음 파일이 그 자리를 뺏는다. */
async function openPinned(page: Page, name: string) {
  await page.locator('.ed-tree .ed-row', { hasText: name }).first().dblclick();
  await expect(page.locator('.pn-body .file-editor.vis .monaco-editor').first())
    .toBeVisible({ timeout: 20000 });
  await expect.poll(async () => await edScroll(page, name), { timeout: 20000 })
    .toBeGreaterThanOrEqual(0);
}

const tab = (page: Page, name: string) =>
  page.locator('#area .pn .pn-tab', { hasText: name }).first();

/** 이 파일을 보는 편집기 뷰의 스크롤. 없으면 -1. */
function edScroll(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => {
    const a = (window as any).app;
    for (const v of a.fileEditors.values()) {
      if (v && v._editor && String(v.filePath || '').endsWith(n)) return v._editor.getScrollTop();
    }
    return -1;
  }, name);
}

async function edScrollTo(page: Page, name: string, top: number) {
  await page.evaluate(({ n, t }) => {
    const a = (window as any).app;
    for (const v of a.fileEditors.values()) {
      if (v && v._editor && String(v.filePath || '').endsWith(n)) v._editor.setScrollTop(t);
    }
  }, { n: name, t: top });
  await expect.poll(async () => await edScroll(page, name), { timeout: 10000 }).toBe(top);
}

/** 같은 pane 안에서 다른 탭으로 갔다 돌아온다 — 요구가 말하는 "다른 화면을 갔다오면". */
async function roundTrip(page: Page, away: string, back: string) {
  await tab(page, away).click();
  await expect(page.locator(`.pn-body .file-editor.vis`).first()).toBeVisible({ timeout: 10000 });
  await tab(page, back).click();
  await expect(page.locator('.pn-body .file-editor.vis .monaco-editor').first())
    .toBeVisible({ timeout: 10000 });
}

/** 창을 갔다 온다 — 탭 전환과 다른 이동 경로다 (FR-VSR-21). */
async function winRoundTrip(page: Page) {
  const ids = await page.evaluate(() => {
    const a = (window as any).app;
    const other = a.ws.windows.find((w: any) => w.id !== a.ws.activeWindow);
    return { cur: a.ws.activeWindow, other: other ? other.id : '' };
  });
  expect(ids.other).not.toBe('');
  await page.evaluate((id) => (window as any).app.switchWindow(id), ids.other);
  await waitSettled(page);
  await page.evaluate((id) => (window as any).app.switchWindow(id), ids.cur);
  await waitSettled(page);
}

test.describe('시선 보존', () => {
  test.beforeEach(async ({ page, request }) => { await enter(page, request) });

  // V-VSR-1
  test('탭을 갔다 오면 편집기의 스크롤과 커서가 남는다', async ({ page }) => {
    // **보이는 편집기를 스크롤한다.** 숨은 편집기를 만지면 그 값은 갈무리를
    // 지나지 않으므로(FR-VSR-2) 검사가 재려는 것을 재지 못한다.
    await openPinned(page, 'other.txt');
    await openPinned(page, 'long.txt');
    await edScrollTo(page, 'long.txt', 1200);
    await page.evaluate(() => {
      const a = (window as any).app;
      for (const v of a.fileEditors.values()) {
        if (v && v._editor && String(v.filePath || '').endsWith('long.txt')) {
          v._editor.setPosition({ lineNumber: 90, column: 2 });
        }
      }
    });

    await roundTrip(page, 'other.txt', 'long.txt');

    expect(await edScroll(page, 'long.txt')).toBe(1200);
    const ln = await page.evaluate(() => {
      const a = (window as any).app;
      for (const v of a.fileEditors.values()) {
        if (v && v._editor && String(v.filePath || '').endsWith('long.txt')) {
          return v._editor.getPosition().lineNumber;
        }
      }
      return -1;
    });
    expect(ln).toBe(90);
  });

  // V-VSR-2 — 두 번째 왕복도 같다. 갈무리가 한 번만 도는 구현을 잡는다.
  test('왕복을 두 번 해도 남는다', async ({ page }) => {
    await openPinned(page, 'other.txt');
    await openPinned(page, 'long.txt');
    await edScrollTo(page, 'long.txt', 900);

    await roundTrip(page, 'other.txt', 'long.txt');
    expect(await edScroll(page, 'long.txt')).toBe(900);

    await edScrollTo(page, 'long.txt', 1500);
    await roundTrip(page, 'other.txt', 'long.txt');
    expect(await edScroll(page, 'long.txt')).toBe(1500);
  });

  // V-VSR-2a — 떠나 있는 동안 시간이 지나도 남는다. `automaticLayout` 의
  // ResizeObserver 가 0 높이로 도달한 뒤를 재는 자리다 — 빠른 왕복만 재면 이
  // 자리를 놓친다.
  test('떠나 있는 시간이 지나도 남는다', async ({ page }) => {
    await openPinned(page, 'other.txt');
    await openPinned(page, 'long.txt');
    await edScrollTo(page, 'long.txt', 1300);
    await tab(page, 'other.txt').click();
    await expect(page.locator('.pn-body .file-editor.vis').first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1800);
    await tab(page, 'long.txt').click();
    await expect(page.locator('.pn-body .file-editor.vis .monaco-editor').first())
      .toBeVisible({ timeout: 10000 });
    expect(await edScroll(page, 'long.txt')).toBe(1300);
  });

  // V-VSR-4 — 왕복이 없으면 복원도 없다. 처음 열린 자리를 덮지 않는다.
  test('처음 여는 편집기는 맨 위에 선다', async ({ page }) => {
    await openPinned(page, 'long.txt');
    expect(await edScroll(page, 'long.txt')).toBe(0);
  });

  // V-VSR-5 — 탭을 닫으면 시선도 사라진다.
  test('탭을 닫고 다시 열면 맨 위다', async ({ page }) => {
    await openPinned(page, 'long.txt');
    await edScrollTo(page, 'long.txt', 1100);
    await tab(page, 'long.txt').locator('.pn-tab-x').click();
    await expect(tab(page, 'long.txt')).toHaveCount(0);
    await openPinned(page, 'long.txt');
    expect(await edScroll(page, 'long.txt')).toBe(0);
  });

  // V-VSR-6 — 렌더 뷰(DocRender)도 같은 계기로 남는다.
  test('문서 렌더 뷰의 스크롤이 남는다', async ({ page }) => {
    await openPinned(page, 'long.md');
    await page.locator('.file-editor.vis .fe-render').click();
    const body = page.locator('.doc-render.vis .dr-body');
    await expect(body).toBeVisible({ timeout: 20000 });
    await body.evaluate((el) => { el.scrollTop = 600 });
    await expect.poll(async () => body.evaluate((el) => el.scrollTop), { timeout: 10000 })
      .toBe(600);

    await winRoundTrip(page);

    await expect(body).toBeVisible({ timeout: 10000 });
    expect(await body.evaluate((el) => el.scrollTop)).toBe(600);
  });

  // V-VSR-10 — 창 전환도 이동이다. 탭 전환과 같은 결과여야 한다.
  test('창을 갔다 와도 편집기의 스크롤이 남는다', async ({ page }) => {
    await openPinned(page, 'long.txt');
    await edScrollTo(page, 'long.txt', 1000);
    await winRoundTrip(page);
    expect(await edScroll(page, 'long.txt')).toBe(1000);
  });

  // V-VSR-7 / NFR-VSR-1 — 레이아웃이 그대로인 render 는 갈무리도 복원도 하지 않는다.
  test('이동이 없는 다시 그리기는 시선을 만지지 않는다', async ({ page }) => {
    await openPinned(page, 'long.txt');
    await edScrollTo(page, 'long.txt', 800);
    const calls = await page.evaluate(() => {
      const w = window as any;
      w.__vsr = { keep: 0, restore: 0 };
      for (const v of w.app.fileEditors.values()) {
        const k = v.keepView ? v.keepView.bind(v) : null;
        const r = v.restoreView ? v.restoreView.bind(v) : null;
        v.keepView = () => { w.__vsr.keep++; if (k) k() };
        v.restoreView = () => { w.__vsr.restore++; if (r) r() };
      }
      for (let i = 0; i < 10; i++) w.app.render();
      return w.__vsr;
    });
    // NFR-VSR-1(개정): **복원**이 0 이다. 갈무리는 매 render 의 머리에서 돌며
    // 값을 쓰기만 하므로 화면을 만지지 않는다 (D-2).
    expect(calls.restore).toBe(0);
    expect(calls.keep).toBeGreaterThan(0);
    expect(await edScroll(page, 'long.txt')).toBe(800);
  });
});
