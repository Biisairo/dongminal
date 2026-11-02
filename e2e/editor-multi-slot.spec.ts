/**
 * CODEMIRROR_MIGRATION_SRS 묶음 P (M4) — 같은 파일을 여러 칸에서 편집한다.
 *
 * FR-CMR-20·21·22 · NFR-CMR-4 · §4.3 "여러 칸 동시 편집 · 칸별 실행 취소".
 * 내용은 문서 하나이고(`EdBuffer`), 칸마다 `EditorState` 와 실행 취소 기록이 따로다.
 */
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, waitForInit, rmTree } from './fixtures';
import { ED_SEL } from './editor';
import { TMP, realPath } from './osenv';

const BODY = 'one\ntwo\nthree\n';
let BASE = '';
let ROOT = '';
let FILE = '';

test.beforeAll(() => {
  BASE = realPath(fs.mkdtempSync(path.join(TMP, 'dm-cms-')));
  ROOT = path.join(BASE, 'root');
  fs.mkdirSync(ROOT);
  ROOT = realPath(ROOT);
  FILE = path.join(ROOT, 'doc.txt');
});
test.beforeEach(() => { fs.writeFileSync(FILE, BODY) });
test.afterAll(() => { rmTree(BASE) });

/** 같은 파일을 세 칸에서 연다. 칸 순서대로 편집기 키를 돌려준다. */
async function sameFileInThreeSlots(page: Page, request: APIRequestContext): Promise<string[]> {
  const r = await request.post('/api/editors/add', { data: { path: ROOT } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await waitForInit(page);
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  const edWin = await page.evaluate((root) => {
    const a = (window as any).app;
    const win = a.testing.edWindows().find((x: any) => x.editor && String(x.editor.root).replace(/\\/g, '/') === String(root).replace(/\\/g, '/'));
    a.switchWindow(win.id);
    return win.id;
  }, ROOT);
  await page.evaluate((fp) => (window as any).app.testing.edOpenFile(fp), FILE);
  await page.evaluate(() => { const a = (window as any).app; a.slotAdd(); a.slotAdd() });
  await page.evaluate((id) => { const a = (window as any).app; for (let i = 0; i < 3; i++) a.slotOpen(i, id) }, edWin);
  await page.evaluate(() => (window as any).app.render());
  await page.waitForFunction(() => {
    const es = [...(window as any).app.fileEditors.values()];
    return es.length === 3 && es.every((e: any) => edT.has(e));
  }, undefined, { timeout: 20000 });
  // 칸 순서 = 화면 왼쪽부터.
  return page.evaluate(() => [...(window as any).app.fileEditors.entries()]
    .sort((x: any, y: any) => x[1].el.getBoundingClientRect().left - y[1].el.getBoundingClientRect().left)
    .map((x: any) => x[0]));
}

const texts = (page: Page, keys: string[]) => page.evaluate(
  (ks) => ks.map((k: string) => edT.text(edT.of((window as any).app.fileEditors.get(k)))), keys);

test.describe('같은 파일 여러 칸 (묶음 P)', () => {
  test('NFR-CMR-4: 칸 셋 — 한 칸의 입력이 다른 두 칸의 화면에 1프레임 안에 선다', async ({ page, request }) => {
    const keys = await sameFileInThreeSlots(page, request);
    const r = await page.evaluate(async (ks) => {
      const a = (window as any).app;
      const hs = ks.map((k: string) => edT.of(a.fileEditors.get(k)));
      const frame = () => new Promise((res) => requestAnimationFrame(() => res(null)));
      const times: number[] = [];
      let missed = 0;
      for (let i = 0; i < 12; i++) {
        const src = hs[i % 3];
        const others = hs.filter((h: any) => h !== src);
        const mark = 'Q' + i + 'Z';
        await frame();
        const t0 = performance.now();
        edT.setCursor(src, 1, 1);
        edT.type(src, mark);
        const seen = () => others.every((h: any) => edT.dom(h).querySelector('.cm-content')!.textContent!.includes(mark));
        if (!seen()) await frame();
        if (!seen()) missed++;
        times.push(performance.now() - t0);
      }
      return { missed, max: Math.max(...times) };
    }, keys);
    test.info().annotations.push({ type: 'NFR-CMR-4 max ms', description: r.max.toFixed(2) });
    expect(r.missed, '다음 프레임까지 다른 칸에 서지 않은 입력이 있다').toBe(0);
    expect(r.max).toBeLessThanOrEqual(16);
    const t = await texts(page, keys);
    expect(t[1]).toBe(t[0]);
    expect(t[2]).toBe(t[0]);
  });

  test('FR-CMR-21: 두 칸에서 번갈아 쳐도 세 칸의 내용이 같다', async ({ page, request }) => {
    const keys = await sameFileInThreeSlots(page, request);
    await page.evaluate((ks) => {
      const a = (window as any).app;
      const [x, y] = ks.map((k: string) => edT.of(a.fileEditors.get(k)));
      for (let i = 0; i < 5; i++) {
        edT.insert(x, 1, 1, 'a', 'type');
        edT.insert(y, 3, 1, 'b', 'type');
      }
    }, keys);
    const t = await texts(page, keys);
    expect(t[0]).toBe('aaaaaone\ntwo\nbbbbbthree\n');
    expect(t[1]).toBe(t[0]);
    expect(t[2]).toBe(t[0]);
  });

  test('FR-CMR-22: 실행 취소는 칸마다 따로다 — 그 칸의 입력만 되돌린다', async ({ page, request }) => {
    const keys = await sameFileInThreeSlots(page, request);
    await page.evaluate((ks) => {
      const a = (window as any).app;
      const [x, y] = ks.map((k: string) => edT.of(a.fileEditors.get(k)));
      edT.insert(x, 1, 1, 'L', 'type');
      edT.insert(y, 3, 1, 'R', 'type');
    }, keys);
    expect((await texts(page, keys))[2]).toBe('Lone\ntwo\nRthree\n');

    const undoIn = async (i: number) => {
      await page.locator(`.file-editor:visible ${ED_SEL.surface} ${ED_SEL.text}`).nth(i).click();
      await page.keyboard.press('Control+z');
    };
    await undoIn(0);
    await expect.poll(() => texts(page, keys)).toEqual(Array(3).fill('one\ntwo\nRthree\n'));
    // 셋째 칸은 친 것이 없다 — 되돌릴 것도 없다.
    await undoIn(2);
    await expect.poll(() => texts(page, keys)).toEqual(Array(3).fill('one\ntwo\nRthree\n'));
    await undoIn(1);
    await expect.poll(() => texts(page, keys)).toEqual(Array(3).fill(BODY));
  });
});
