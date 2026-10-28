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
  await page.evaluate(async (want) => {
    const app = (window as any).app;
    const pane = app.testing.focusedTerminal();
    const b = pane.term.buffer.active;
    let y = -1;
    for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === want) y = i + 1;
    const links: any[] = await new Promise((res) => pane._fileLinks.provideLinks(y, (l: any) => res(l || [])));
    const orig = app.edOpenFile;
    (window as any).__fplGot = null;
    app.edOpenFile = (p: string, o: any) => { (window as any).__fplGot = { p, o }; app.edOpenFile = orig; return orig.call(app, p, o) };
    links[0].activate(new MouseEvent('click'), links[0].text);
  }, line);
  // FR-FPL-7: 여는 것은 이벤트 디스패치가 끝난 뒤다.
  await expect.poll(() => page.evaluate(() => (window as any).__fplGot)).toEqual({ p: abs, o: { line: 2 } });
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

/**
 * TC-FPL-5 (FR-FPL-7): 마우스 리포팅 앱 위에서 링크를 **실제 마우스로** 누른다.
 *
 * 종전에는 링크가 mouseup 처리 도중에 편집기를 열어 터미널을 문서에서 뗐고, 같은
 * mouseup 의 release 보고가 떨어진 요소로 좌표를 재어 `ESC[<0;NaN;NaNm` 으로 나갔다.
 * Claude Code 는 그 뒤쪽 `aN;NaNm` 을 입력 줄에 남긴다.
 */
test('TC-FPL-5 마우스 리포팅 앱에서 링크를 누르면 release 보고가 수치 좌표로 나간다', async ({ page }) => {
  await waitForInit(page);
  await cdInto(page);
  const line = 'src/a.go:2';
  const app = `node -e "console.log('${line}');process.stdout.write('\\x1b[?1002h\\x1b[?1006h');setInterval(()=>{},1000)"`;
  await page.keyboard.type(app);
  await page.keyboard.press('Enter');
  await expect.poll(() => linksOn(page, line), { timeout: 15000 }).toEqual({ file: [line], bare: [] });
  await expect.poll(() => page.evaluate(() =>
    (window as any).app.testing.focusedTerminal().term.modes.mouseTrackingMode), { timeout: 15000 }).not.toBe('none');

  await page.evaluate(() => {
    const pane = (window as any).app.testing.focusedTerminal();
    (window as any).__sent = [];
    const orig = pane._sendText.bind(pane);
    pane._sendText = (s: string, u: any) => { (window as any).__sent.push(s); orig(s, u) };
  });

  // 링크 글자의 셋째 칸 가운데. 칸 크기는 화면 크기 ÷ 행·열이다.
  const at = await page.evaluate((want) => {
    const pane = (window as any).app.testing.focusedTerminal();
    const t = pane.term;
    const b = t.buffer.active;
    let row = -1;
    for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === want) row = i - b.viewportY;
    const r = t.element.querySelector('.xterm-screen').getBoundingClientRect();
    const cw = r.width / t.cols, ch = r.height / t.rows;
    return { x: r.left + cw * 2.5, y: r.top + ch * (row + 0.5) };
  }, line);
  // 링크는 hover 가 공급자에 물어야 선다 — 선 것을 커서 모양으로 확인한다.
  let dx = 0;
  await expect.poll(async () => {
    dx = dx ? 0 : 1;
    await page.mouse.move(at.x + dx, at.y);
    return page.evaluate(() => !!document.querySelector('#area .pn.focused .xterm-screen.xterm-cursor-pointer'));
  }, { timeout: 15000 }).toBe(true);

  await page.mouse.down();
  await page.mouse.up();
  const abs = path.join(DIR, 'src', 'a.go');
  await expect.poll(() => page.evaluate((p) => !!(window as any).app.testing.findEditorTab(p), abs), { timeout: 15000 }).toBe(true);

  const reports: string[] = await page.evaluate(() =>
    ((window as any).__sent as string[]).filter((s) => s.startsWith('\x1b[<')));
  expect(reports.some((s) => s.includes('NaN'))).toBe(false);
  expect(reports.some((s) => /^\x1b\[<0;\d+;\d+M$/.test(s))).toBe(true);
  expect(reports.some((s) => /^\x1b\[<0;\d+;\d+m$/.test(s))).toBe(true);
});
