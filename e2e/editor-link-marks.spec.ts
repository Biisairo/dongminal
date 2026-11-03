/**
 * EDITOR_LINK_LSP_SRS — 수정키+클릭 URL 열기 · 수정키 hover 밑줄 · ruler·미니맵 표식 · LSP 대화상자 테마.
 *
 * 언어 서버 없이 잰다. 문서 링크·정의 이동은 단위(`lsp-click.test.mjs`)와 `editor-lsp-nav.spec.ts` 가 잰다.
 */
import { mkdtempSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, rmTree, enterDocRoot, openDocFile } from './fixtures';
import { ED_SEL } from './editor';
import { TMP, realPath } from './osenv';

let BASE = '';
test.beforeAll(() => { BASE = realPath(mkdtempSync(join(TMP, 'dm-elm-'))) });
test.afterAll(() => { rmTree(BASE) });
// 설치 제안 띠가 편집기 위를 덮지 않게 서버 목록을 비운다 (editor-scrollbar.spec.ts 와 같다).
test.beforeEach(async ({ page }) => {
  await page.route('**/api/lsp/status', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ servers: [] }),
  }));
});

const URL = 'https://example.com/x';

// doc.md 맨 위에 `text` 를 넣는다.
async function start(page: Page, request: any, name: string, text: string) {
  const root = await enterDocRoot(page, request, BASE, name);
  await openDocFile(page, root);
  await page.evaluate((t) => {
    const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md');
    edT.insert(edT.of(v), 1, 1, t);
    edT.revealLine(edT.of(v), 1);
  }, text);
}

const inDoc = <T, A>(page: Page, fn: (h: any, a: A) => T, arg: A) => page.evaluate(([src, a]) => {
  const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'doc.md');
  return (0, eval)('(' + src + ')')(edT.of(v), a);
}, [fn.toString(), arg] as const);

async function modKey(page: Page) {
  return (await page.evaluate(() => (0, eval)('IS_MAC'))) ? 'Meta' : 'Control';
}

async function pointAt(page: Page, line: number, col: number) {
  return inDoc(page, (h, a: number[]) => {
    const p = edT.coords(h, a[0], a[1]);
    return { x: p.left + 2, y: p.top + p.height / 2 };
  }, [line, col]);
}

test('FR-ELS-30·33: 선택 · 같은 낱말 · 커서가 ruler 에 서고 선택·같은 낱말은 미니맵에도 선다', async ({ page, request }) => {
  await start(page, request, 'marks', 'alpha beta alpha\nalpha\n');
  await inDoc(page, (h) => edT.setSelection(h, 1, 1, 1, 6), null);

  await expect.poll(() => inDoc(page, (h) => edT.rulerItems(h)
    .filter((x: any) => x.cls.startsWith('ed-mark-'))
    .map((x: any) => [x.cls, x.from, x.lane, x.color]), null)).toEqual([
    ['ed-mark-match', 11, 'right', '--text-hint'],
    ['ed-mark-match', 17, 'right', '--text-hint'],
    ['ed-mark-sel', 0, 'right', '--text'],
    ['ed-mark-cursor', 5, 'full', '--text-bright'],
  ]);

  if (await inDoc(page, (h) => edT.option(h, 'minimapEnabled'), null)) {
    await expect.poll(() => inDoc(page, (h) => edT.minimapMarks(h)
      .filter((x: any) => x.cls.startsWith('ed-mark-'))
      .map((x: any) => [x.cls, x.line]), null)).toEqual([
      ['ed-mark-match', 1], ['ed-mark-match', 2], ['ed-mark-sel', 1],
    ]);
  }

  // 선택을 풀면 선택·같은 낱말 표식이 사라지고 커서만 남는다.
  await inDoc(page, (h) => edT.setCursor(h, 2, 1), null);
  await expect.poll(() => inDoc(page, (h) => edT.rulerItems(h)
    .filter((x: any) => x.cls.startsWith('ed-mark-')).map((x: any) => x.cls), null)).toEqual(['ed-mark-cursor']);
});

test('FR-ELS-10·12: 수정키+클릭이 URL 을 새 탭으로 열고, 수정키 없는 클릭은 열지 않는다', async ({ page, request }) => {
  await start(page, request, 'url', `see ${URL} here\n`);
  await page.evaluate(() => {
    const w = window as any;
    w.edLinkOpened = [];
    w.open = (u: string) => { w.edLinkOpened.push(u); return null };
  });
  const at = await pointAt(page, 1, 10);
  await page.mouse.click(at.x, at.y);
  expect(await page.evaluate(() => (window as any).edLinkOpened)).toEqual([]);

  const mod = await modKey(page);
  await page.keyboard.down(mod);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up(mod);
  await expect.poll(() => page.evaluate(() => (window as any).edLinkOpened)).toEqual([URL]);
});

test('FR-ELS-15·16: 수정키+클릭은 커서를 더하지 않고, Alt+클릭이 커서를 더한다', async ({ page, request }) => {
  await start(page, request, 'cursor', 'alpha beta\ngamma delta\n');
  await inDoc(page, (h) => edT.setCursor(h, 1, 1), null);
  const at = await pointAt(page, 2, 3);
  const mod = await modKey(page);
  await page.keyboard.down(mod);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up(mod);
  expect(await inDoc(page, (h) => edT.selectionCount(h), null), '수정키+클릭이 커서를 더했다').toBe(1);

  const other = await pointAt(page, 1, 4);
  await page.keyboard.down('Alt');
  await page.mouse.click(other.x, other.y);
  await page.keyboard.up('Alt');
  await expect.poll(() => inDoc(page, (h) => edT.selectionCount(h), null)).toBe(2);
});

test('FR-ELS-20·22: 수정키를 누른 채 올리면 URL 에 밑줄이 서고, 키를 떼면 사라진다', async ({ page, request }) => {
  await start(page, request, 'hover', `see ${URL} here\n`);
  const at = await pointAt(page, 1, 10);
  const hover = page.locator(`.file-editor:visible ${ED_SEL.linkHover}`);
  await page.mouse.move(at.x, at.y);
  await expect(hover).toHaveCount(0);

  const mod = await modKey(page);
  await page.keyboard.down(mod);
  await page.mouse.move(at.x + 1, at.y);
  await expect(hover).toHaveText(URL);
  await page.keyboard.up(mod);
  await expect(hover).toHaveCount(0);
});

test('FR-ELS-40: LSP 오류 대화상자가 앱 테마 색을 따른다', async ({ page, request }) => {
  await start(page, request, 'dialog', '');
  await inDoc(page, (h) => edT.showLspError(h, 'Find definition failed: x'), null);
  const panels = page.locator(`.file-editor:visible ${ED_SEL.panels}`).first();
  await expect(panels).toBeVisible();
  const got = await panels.evaluate((el, btnSel) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--bg-alt)';
    el.appendChild(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const btn = el.querySelector(btnSel.replace('.cm-panels ', '')) as HTMLElement | null;
    return { bg: getComputedStyle(el).backgroundColor, want, btnImage: btn ? getComputedStyle(btn).backgroundImage : null };
  }, ED_SEL.dialogButton);
  expect(got.bg).toBe(got.want);
  expect(got.btnImage).toBe('none');
});

test('FR-ELS-45: hover 미리보기는 상한을 넘지 않고 안에서 스크롤한다', async ({ page, request }) => {
  await start(page, request, 'hoverbox', '');
  const b = await inDoc(page, (h) => edT.hoverBox(h, 500), null);
  expect(b.h).toBeLessThanOrEqual(Math.min(320, b.vh * 0.45) + 1);
  expect(b.w).toBeLessThanOrEqual(Math.min(600, b.vw * 0.7) + 1);
  expect(b.scrolls).toBe(true);
});

test('FR-ELS-46: hover 미리보기의 스크롤바는 앱 킷 스크롤바 규칙을 따른다', async ({ page, request }) => {
  await start(page, request, 'hoverbar', '');
  const rule = await page.evaluate(() => {
    for (const sh of [...document.styleSheets]) {
      let rules: CSSRule[] = [];
      try { rules = [...sh.cssRules] } catch { continue }
      for (const r of rules) {
        const t = r.cssText;
        if (t.includes('cm-tooltip-hover::-webkit-scrollbar-thumb') && !t.includes(':hover')) return t;
      }
    }
    return null;
  });
  expect(rule, '미리보기 스크롤바 손잡이 규칙이 없다').not.toBeNull();
  expect(rule).toContain('var(--text-dim)');
});
