import * as fs from 'fs';
import * as path from 'path';

import { test, expect, waitForInit, waitShellReady, rmTree } from './fixtures';
import { TMP, realPath, echoCmd } from './osenv';

/**
 * BARE_DOMAIN_LINK_SRS TC-BDL-4 — 터미널의 맨 도메인 링크.
 *
 * 마우스 위치로 링크를 찾지 않고 **등록된 공급자에 그 줄을 직접 묻는다.** 재려는 것은
 * "어느 글자가 링크인가" 와 "누르면 어디로 가는가" 이고, 밑줄을 그리는 것은 xterm 의 몫이다.
 */
let DIR = '';

test.beforeAll(() => {
  DIR = realPath(fs.mkdtempSync(path.join(TMP, 'dm-bdl-')));
  fs.writeFileSync(path.join(DIR, 'README.md'), '# r\n');
});

test.afterAll(() => { rmTree(DIR) });

test('TC-BDL-4 터미널: naver.com 은 링크, cwd 의 파일 README.md 는 아니다', async ({ page }) => {
  await waitForInit(page);
  await waitShellReady(page);
  await page.click('#area .pn.focused .xterm-screen');
  await page.keyboard.type(`cd "${DIR}"`);
  await page.keyboard.press('Enter');
  const base = path.basename(DIR);
  await expect.poll(() => page.evaluate((b) => {
    const app = (window as any).app;
    const pane = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis')) as any;
    return String(pane._cwd || '').endsWith(b);
  }, base), { timeout: 15000 }).toBe(true);
  // PowerShell 의 `echo a b` 는 인자마다 한 줄이다 — 한 문자열로 낸다.
  await page.keyboard.type(echoCmd('naver.com README.md'));
  await page.keyboard.press('Enter');

  await expect.poll(() => page.evaluate(async () => {
    const app = (window as any).app;
    const pane = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis')) as any;
    const b = pane.term.buffer.active;
    let y = -1;
    for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === 'naver.com README.md') y = i + 1;
    if (y < 0) return null;
    const links: any[] = await new Promise((res) => pane._bareLinks.provideLinks(y, (l: any) => res(l || [])));
    const opened: string[] = [];
    const orig = window.open;
    (window as any).open = (u: string) => { opened.push(u); return null };
    if (links[0]) links[0].activate(new MouseEvent('click'), links[0].text);
    window.open = orig;
    return { texts: links.map((l) => l.text), opened };
  }), { timeout: 15000 }).toEqual({ texts: ['naver.com'], opened: ['http://naver.com'] });
});
