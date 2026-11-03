/**
 * CODEMIRROR_MIGRATION_SRS 묶음 K (FR-CMR-80~84) — 편집기 칸의 sticky scroll.
 *
 * 범위 계산의 경계(5단계 초과·legacy-modes·들여쓰기)는 단위 테스트 `cm-sticky.test.mjs` 가 잰다.
 * 여기서는 화면에 서는지, 누르면 그 줄로 가는지, 구문 색이 입혀지는지를 잰다.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, rmTree, addEditorRoot, waitForInit, switchToEditorRoot } from './fixtures';
import { ED_SEL } from './editor';
import { TMP, realPath } from './osenv';

let BASE = '';
test.beforeAll(() => { BASE = realPath(mkdtempSync(join(TMP, 'dm-sticky-'))) });
test.afterAll(() => { rmTree(BASE) });

const BODY = Array.from({ length: 120 }, (_, i) => `      call${i}();`);
// 1: class · 2: method · 3: if · 4~123: 본문 · 124~126: 닫는 줄
const SRC = ['class A {', '  m() {', '    if (x) {', ...BODY, '    }', '  }', '}', ''].join('\n');

async function openSrc(page: Page, request: any, name: string) {
  const root = join(BASE, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.js'), SRC);
  const saved = await addEditorRoot(request, root);
  await waitForInit(page);
  await switchToEditorRoot(page, saved);
  await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }), saved + '/a.js');
  await page.waitForFunction(() => [...(window as any).app.fileEditors.values()].some((e: any) => edT.has(e) && e.name === 'a.js'),
    undefined, { timeout: 30000 });
}

const run = (page: Page, fn: string, ...args: number[]) => page.evaluate(([f, a]: [string, number[]]) => {
  const v = [...(window as any).app.fileEditors.values()].find((e: any) => edT.has(e) && e.name === 'a.js');
  return (edT as any)[f](edT.of(v), ...a);
}, [fn, args] as [string, number[]]);
const sticky = (page: Page) => run(page, 'stickyLines') as Promise<number[]>;
const stickyLine = (page: Page, n: number) => page.locator(`.file-editor:visible ${ED_SEL.stickyLine}[data-line="${n}"]`);

test('FR-CMR-80·84: 맨 위 줄을 감싸는 범위의 첫 줄이 바깥부터 고정되고, 구문 색이 입혀진다', async ({ page, request }) => {
  await openSrc(page, request, 'show');
  expect(await sticky(page), '맨 위에 있을 때는 고정할 것이 없다').toEqual([]);

  await run(page, 'revealLineNearTop', 40);
  await expect.poll(() => sticky(page), { timeout: 10000 }).toEqual([1, 2, 3]);
  await expect(stickyLine(page, 1)).toBeVisible();
  await expect(stickyLine(page, 1)).toContainText('class A {');
  await expect(stickyLine(page, 1)).toContainText('1');
  // `class` 는 키워드다 — 편집기 테마의 클래스가 붙은 조각으로 그려진다.
  const keyword = stickyLine(page, 1).locator('span[class]', { hasText: /^class$/ });
  await expect(keyword).toHaveCount(1);

  // 고정된 줄은 편집기 위쪽에 겹쳐 선다 — 위에서 아래로 바깥 범위부터.
  const ys = await Promise.all([1, 2, 3].map(async (n) => (await stickyLine(page, n).boundingBox())!.y));
  expect(ys[0]).toBeLessThan(ys[1]);
  expect(ys[1]).toBeLessThan(ys[2]);
});

test('FR-CMR-82: 고정된 줄을 누르면 커서가 그 줄로 가고, 그 줄이 덮이지 않게 보인다', async ({ page, request }) => {
  await openSrc(page, request, 'click');
  await run(page, 'revealLineNearTop', 60);
  await expect.poll(() => sticky(page), { timeout: 10000 }).toEqual([1, 2, 3]);

  await stickyLine(page, 3).click();
  await expect.poll(() => run(page, 'cursor'), { timeout: 10000 }).toEqual({ line: 3, col: 1 });
  // 3 번 줄 위로 그것을 감싸는 두 줄만큼 띄운다 — 맨 위 줄이 1 번이고 고정할 것이 없다.
  await expect.poll(() => sticky(page), { timeout: 10000 }).toEqual([]);
});

test('FR-CMR-83: 범위 밖으로 스크롤하면 고정된 줄이 걷힌다', async ({ page, request }) => {
  await openSrc(page, request, 'leave');
  await run(page, 'revealLineNearTop', 40);
  await expect.poll(() => sticky(page), { timeout: 10000 }).toEqual([1, 2, 3]);
  await run(page, 'setScrollTop', 0);
  await expect.poll(() => sticky(page), { timeout: 10000 }).toEqual([]);
  await expect(page.locator(`.file-editor:visible ${ED_SEL.stickyLine}`)).toHaveCount(0);
});
