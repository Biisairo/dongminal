import * as fs from 'fs';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitShellReady, rmTree } from './fixtures';
import { TMP, realPath, echoCmd } from './osenv';

/**
 * UX_BATCH11_SRS TC-FPL-3·4 — 터미널 출력의 파일 경로 링크.
 *
 * `bare-link.spec.ts` 와 같이 마우스 위치가 아니라 **등록된 공급자에 그 줄을 직접 묻는다.**
 */
let DIR = '';

test.beforeAll(() => {
  DIR = realPath(fs.mkdtempSync(path.join(TMP, 'dm-fpl-')));
  fs.mkdirSync(path.join(DIR, 'src'));
  fs.writeFileSync(path.join(DIR, 'src', 'a.go'), 'package a\n\nfunc A() {}\n');
  fs.writeFileSync(path.join(DIR, 'main.go'), 'package main\n');
  fs.writeFileSync(path.join(DIR, 'README.md'), '# r\n');
});

test.afterAll(() => { rmTree(DIR) });

async function cdInto(page: Page) {
  await waitShellReady(page);
  await page.click('#area .pn.focused .xterm-screen');
  await page.keyboard.type(`cd "${DIR}"`);
  await page.keyboard.press('Enter');
  const base = path.basename(DIR);
  await expect.poll(() => page.evaluate((b) =>
    String((window as any).app.testing.focusedTerminal()._cwd || '').endsWith(b), base), { timeout: 15000 }).toBe(true);
}

/** 그 글자의 출력 줄에서 두 공급자가 내는 링크. */
const linksOn = (page: Page, line: string) => page.evaluate(async (want) => {
  const pane = (window as any).app.testing.focusedTerminal();
  const b = pane.term.buffer.active;
  let y = -1;
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === want) y = i + 1;
  if (y < 0) return null;
  const ask = (prov: any) => new Promise<any[]>((res) => prov.provideLinks(y, (l: any) => res(l || [])));
  return { file: (await ask(pane._fileLinks)).map((l) => l.text), bare: (await ask(pane._bareLinks)).map((l) => l.text) };
}, line);

test('TC-FPL-3 있는 파일의 경로형만 링크이고, 누르면 편집기의 그 줄로 연다', async ({ page }) => {
  await waitForInit(page);
  await cdInto(page);
  const line = 'src/a.go:2 nope/x.go:1 main.go';
  await page.keyboard.type(echoCmd(line));
  await page.keyboard.press('Enter');
  await expect.poll(() => linksOn(page, line), { timeout: 15000 }).toEqual({ file: ['src/a.go:2'], bare: [] });

  const abs = path.join(DIR, 'src', 'a.go');
  const call = await page.evaluate(async ([want, absPath]) => {
    const app = (window as any).app;
    const pane = app.testing.focusedTerminal();
    const b = pane.term.buffer.active;
    let y = -1;
    for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === want) y = i + 1;
    const links: any[] = await new Promise((res) => pane._fileLinks.provideLinks(y, (l: any) => res(l || [])));
    const orig = app.edOpenFile;
    let got: any = null;
    app.edOpenFile = (p: string, o: any) => { got = { p, o }; app.edOpenFile = orig; return orig.call(app, p, o) };
    links[0].activate(new MouseEvent('click'), links[0].text);
    return { got, absPath };
  }, [line, abs] as const);
  expect(call.got).toEqual({ p: abs, o: { line: 2 } });
  await expect.poll(() => page.evaluate((p) => !!(window as any).app.testing.findEditorTab(p), abs), { timeout: 15000 }).toBe(true);
});

test('TC-FPL-4 같은 글자가 파일이면 맨 도메인 링크 없이 파일 링크 하나만 선다', async ({ page }) => {
  await waitForInit(page);
  await cdInto(page);
  const line = 'README.md:1';
  await page.keyboard.type(echoCmd(line));
  await page.keyboard.press('Enter');
  await expect.poll(() => linksOn(page, line), { timeout: 15000 }).toEqual({ file: ['README.md:1'], bare: [] });
});
