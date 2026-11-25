import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitShellReady, waitSettled, JSON_HDR } from './fixtures';

/**
 * PERF M2 §2.8.2 검색·질의 답·내려받기 (FR-TRM-8, D-21·D-23·D-24).
 *
 * 질의 답은 앱 자리에서 잰다: 원시 모드로 DA(`CSI c`)와 커서 위치(`CSI 6 n`)를 묻고, 받은 답을 16진수로 찍는다.
 * 데몬(alacritty)의 DA 답은 `CSI ? 6 c`, 브라우저(xterm.js)의 것은 `CSI ? 1 ; 2 c` 라 누가 답했는지 가를 수 있다.
 */

const SLEEP_MS = 2000;
const DAEMON_DA = '\x1b[?6c';
const XTERM_DA = '\x1b[?1;2c';

const QUERY_PY = `import os, select, termios, tty
fd = 0
old = termios.tcgetattr(fd)
tty.setraw(fd)
os.write(1, b'\\x1b[c\\x1b[6n')
r = b''
while select.select([fd], [], [], 5)[0]:
    r += os.read(fd, 256)
    if b'R' in r and b'c' in r:
        while select.select([fd], [], [], 1)[0]:
            r += os.read(fd, 256)
        break
termios.tcsetattr(fd, termios.TCSADRAIN, old)
print('ANS=' + r.hex() + '=END')
`;

function queryScript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-query-'));
  const f = path.join(dir, 'q.py');
  fs.writeFileSync(f, QUERY_PY);
  return f;
}

async function run(request: any, id: string, text: string) {
  const res = await request.post('/api/tools/input', { headers: JSON_HDR, data: { id, text, execute: true } });
  expect(res.ok()).toBe(true);
}

/** 도구 출력에 찍힌 답을 기다려 글자로 돌려준다. */
async function answer(request: any, id: string): Promise<string> {
  let hex = '';
  await expect.poll(async () => {
    const o = await request.get('/api/tools/output?id=' + id + '&strip=1');
    const m = o.ok() ? /ANS=([0-9a-f]*)=END/.exec((await o.json()).text || '') : null;
    hex = m ? m[1] : '';
    return !!m;
  }, { timeout: 20000 }).toBe(true);
  return Buffer.from(hex, 'hex').toString('latin1');
}

const count = (s: string, re: RegExp) => (s.match(re) || []).length;

const onPane = (page: Page, id: string, fn: string) => page.evaluate(`(() => {
  const a = window.app;
  const p = a.tools.get(a.slot.slotKey(${JSON.stringify(id)}, 0));
  if (!p) return null;
  return (${fn})(p);
})()`);

const asleep = `p => !!p.term && !p._sock.live && !p._sock.want`;

/** 포커스 칸에 터미널 탭 하나를 더해 처음 도구를 가린다. (가린 도구, 칸, 가린 탭) 을 준다. */
async function hideFirst(page: Page) {
  await waitForInit(page, { clearLocalStorage: true });
  await waitShellReady(page);
  const first = await page.evaluate(() => {
    const a = (window as any).app;
    return { pane: a.focused, tool: a.testing.focusedTerminal().id };
  });
  await page.evaluate(async (pn) => (window as any).app.layout.tabAdd.addTab(pn, 'terminal'), first.pane);
  await waitSettled(page);
  await waitShellReady(page);
  const tab = await page.evaluate((id) => (window as any).app.tool.life.findToolLocation(id).tab.id, first.tool);
  await expect.poll(() => onPane(page, first.tool, asleep), { timeout: SLEEP_MS + 5000 }).toBe(true);
  return { x: first.tool, pane: first.pane, xTab: tab };
}

test.describe('PERF 2.8.2 질의 답·내려받기', () => {
  test('Q1 (D-23): 모든 브라우저에서 잠든 터미널의 앱도 DA·커서 위치 질의에 답을 하나씩 받는다 — 데몬이 답한다', async ({ page, request }) => {
    const s = await hideFirst(page);
    await run(request, s.x, 'python3 ' + queryScript());
    const a = await answer(request, s.x);
    expect(a).toContain(DAEMON_DA);
    expect(count(a, /\x1b\[\?[\d;]*c/g), a).toBe(1);
    expect(count(a, /\x1b\[\d+;\d+R/g), a).toBe(1);
  });

  test('Q2 (D-23): 깬 브라우저가 있으면 그 브라우저만 답하고 데몬은 답하지 않는다', async ({ page, request }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await waitShellReady(page);
    const id = await page.evaluate(() => (window as any).app.testing.focusedTerminal().id);
    await run(request, id, 'python3 ' + queryScript());
    const a = await answer(request, id);
    expect(a).toContain(XTERM_DA);
    expect(a).not.toContain(DAEMON_DA);
    expect(count(a, /\x1b\[\?[\d;]*c/g), a).toBe(1);
    expect(count(a, /\x1b\[\d+;\d+R/g), a).toBe(1);
  });

  test('D1 (D-24): 잠든 동안 온 Download 는 잠든 동안에도 깬 뒤에도 내려받기를 일으키지 않는다', async ({ page, request }) => {
    const s = await hideFirst(page);
    await onPane(page, s.x, `p => { window.__dl = []; p.xfer._downloadFile = (v) => window.__dl.push(v); }`);
    await run(request, s.x, "printf '\\033]777;Download;/tmp/pf-d1\\007'; echo d1-$((1+1))-done");
    await expect.poll(async () => {
      const o = await request.get('/api/tools/output?id=' + s.x + '&strip=1');
      return o.ok() && ((await o.json()).text || '').includes('d1-2-done');
    }, { timeout: 15000 }).toBe(true);
    await page.evaluate(({ pn, t }) => (window as any).app.layout.tabOps.switchTab(pn, t, 0), { pn: s.pane, t: s.xTab });
    await expect.poll(() => onPane(page, s.x, `p => {
      const b = p.term.buffer.active;
      for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) || '').includes('d1-2-done')) return true;
      return false;
    }`), { timeout: 15000 }).toBe(true);
    expect(await page.evaluate(() => (window as any).__dl)).toEqual([]);
  });

  test('S1 (D-21): 브라우저 버퍼(5천 줄) 위의 일치를 "이전 기록에서 찾기" 가 데몬 저장소에서 찾는다', async ({ page, request }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await waitShellReady(page);
    const id = await page.evaluate(() => (window as any).app.testing.focusedTerminal().id);
    await run(request, id, 'echo needle-$((40+2)); seq 1 7000; echo s1-$((1+1))-done');
    await expect.poll(async () => {
      const o = await request.get('/api/tools/output?id=' + id + '&strip=1');
      return o.ok() && ((await o.json()).text || '').includes('s1-2-done');
    }, { timeout: 20000 }).toBe(true);
    // 다시 붙어 스냅숏을 받으면 버퍼는 최근 기록뿐이고, 그 첫 줄 번호가 앵커다.
    await page.reload();
    await waitForInit(page);
    await waitShellReady(page);
    await expect.poll(() => onPane(page, id, 'p => p._firstLine'), { timeout: 15000 }).toBeGreaterThan(0);
    expect(await onPane(page, id, `p => {
      const b = p.term.buffer.active;
      for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) || '').includes('needle-42')) return true;
      return false;
    }`), '브라우저 버퍼에 이미 있다 — 시험의 전제가 깨졌다').toBe(false);
    await page.evaluate(() => (window as any).app.tool.search.toggleSearch());
    await page.fill('#search-input', 'needle-42');
    await page.click('#search-older');
    await expect(page.locator('#search-older-list .search-older-hit')).toHaveText(['needle-42']);
    // PERF 2.7: 고른 결과는 기록 보기(D-20)로 열리고 그 줄이 보인다.
    await page.click('#search-older-list .search-older-hit');
    await expect.poll(() => onPane(page, id, `p => {
      const v = p.history.view;
      if (!v) return false;
      const b = v.buffer.active;
      for (let i = b.viewportY; i < b.viewportY + v.rows; i++) if ((b.getLine(i)?.translateToString(true) || '').includes('needle-42')) return true;
      return false;
    }`), { timeout: 15000 }).toBe(true);
  });

  test('R1 (FR-TRM-8): 잠든 동안 나온 글자도 깬 버퍼에서 복사·링크가 같은 결과를 낸다', async ({ page, request }) => {
    const s = await hideFirst(page);
    await run(request, s.x, 'echo r1-copy-$((1+1)) see naver.com now');
    await expect.poll(async () => {
      const o = await request.get('/api/tools/output?id=' + s.x + '&strip=1');
      return o.ok() && ((await o.json()).text || '').includes('r1-copy-2 see');
    }, { timeout: 15000 }).toBe(true);
    await page.evaluate(({ pn, t }) => (window as any).app.layout.tabOps.switchTab(pn, t, 0), { pn: s.pane, t: s.xTab });
    const row = `p => {
      const b = p.term.buffer.active;
      for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) || '').startsWith('r1-copy-2')) return i;
      return -1;
    }`;
    await expect.poll(() => onPane(page, s.x, row), { timeout: 15000 }).toBeGreaterThanOrEqual(0);
    const got: any = await page.evaluate(`(async () => {
      const a = window.app;
      const p = a.tools.get(a.slot.slotKey(${JSON.stringify(s.x)}, 0));
      const y = (${row})(p);
      p.term.select(0, y, 'r1-copy-2'.length);
      const sel = p.term.getSelection();
      const links = await new Promise((res) => p._bareLinks.provideLinks(y + 1, (l) => res(l || [])));
      return { sel, links: links.map((l) => l.text) };
    })()`);
    expect(got.sel).toBe('r1-copy-2');
    expect(got.links).toEqual(['naver.com']);
  });
});
