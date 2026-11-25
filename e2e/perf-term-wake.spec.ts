import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitShellReady, waitSettled, JSON_HDR } from './fixtures';

/**
 * PERF M2 §2.5 깨움·잠듦 (FR-TRM-3·4, NFR-PRF-6·14, D-15·D-16·D-19).
 *
 * 비교 대상("숨기지 않은 터미널")은 **두 번째 칸(슬롯)의 같은 도구**다. 칸마다 인스턴스가 따로 서고(FR-WSL-20)
 * 활성 탭도 칸마다 따로라(FR-SVS-3), 칸 0 에서만 탭을 바꾸면 칸 0 의 인스턴스만 잠들고 칸 1 의 것은 줄곧 출력을
 * 받는다. 줄은 칸 폭보다 짧게 써서 다시 감싸기가 비교에 끼지 않게 한다. 새 이모지(U+1F000 이상)는 쓰지 않는다 —
 * 데몬과 xterm 의 폭이 다르다(2.4 사용자 결정).
 *
 * **고정 대기의 예외 (`TEST-16`).** 잠든 터미널로 바이트가 **오지 않음**을 재는 자리의 `waitForTimeout` 하나.
 */

const SLEEP_MS = 2000;

/** 칸 `slot` 의 도구 `id` 인스턴스에 `fn` 을 건다. */
const onPane = (page: Page, id: string, slot: number, fn: string) => page.evaluate(`(() => {
  const a = window.app;
  const p = a.tools.get(a.slot.slotKey(${JSON.stringify(id)}, ${slot}));
  if (!p) return null;
  return (${fn})(p);
})()`);

const dump = `p => {
  const b = p.term.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); lines.push((l.isWrapped ? '~' : '') + l.translateToString(true)) }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { type: b.type, cx: b.cursorX, cy: b.cursorY, cols: p.term.cols, rows: p.term.rows, lines };
}`;

const hasText = (s: string) => `p => {
  if (!p.term) return false;
  const b = p.term.buffer.active;
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) || '').includes(${JSON.stringify(s)})) return true;
  return false;
}`;

const asleep = `p => !!p.term && !p._sock.live && !p._sock.want`;

const blank = `p => {
  const b = p.term.buffer.active;
  if (b.length > p.term.rows) return false;
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) || '').trim()) return false;
  return true;
}`;

async function run(request: any, id: string, text: string) {
  const res = await request.post('/api/tools/input', { headers: JSON_HDR, data: { id, text, execute: true } });
  expect(res.ok()).toBe(true);
}

/** 포커스 칸에 터미널 탭 하나를 더하고, (처음 도구, 새 도구, 칸, 두 탭 id) 를 준다. */
async function twoTabs(page: Page) {
  await waitForInit(page, { clearLocalStorage: true });
  await waitShellReady(page);
  const first = await page.evaluate(() => {
    const a = (window as any).app;
    return { pane: a.focused, tool: a.testing.focusedTerminal().id };
  });
  await page.evaluate(async (pn) => (window as any).app.layout.tabAdd.addTab(pn, 'terminal'), first.pane);
  await waitSettled(page);
  await waitShellReady(page);
  return page.evaluate((f) => {
    const a = (window as any).app;
    const loc = a.tool.life.findToolLocation(f.tool);
    const other = loc.pane.tabs.find((t: any) => t.toolId && t.toolId !== f.tool);
    return { pane: f.pane, x: f.tool, y: other.toolId, xTab: loc.tab.id, yTab: other.id };
  }, first);
}

const switchIn = (page: Page, pane: string, tab: string, slot: number) =>
  page.evaluate(({ pn, t, s }) => (window as any).app.layout.tabOps.switchTab(pn, t, s), { pn: pane, t: tab, s: slot });

/**
 * 칸 0·1 이 같은 창에서 X 를 보인 뒤, 칸 0 만 Y 로 바꿔 칸 0 의 X 를 재운다.
 *
 * 칸을 더하면 PTY 폭이 바뀐다. 폭이 바뀔 때 셸이 다시 그린 프롬프트는 xterm.js 와 데몬 에뮬레이터(alacritty)가 다르게
 * 다시 흘린다(reflow) — 스냅숏이 아니라 두 에뮬레이터의 차이다. 그래서 화면과 기록을 지운 뒤부터 잰다.
 */
async function sleepInSlot0(page: Page, request: any, s: { pane: string; x: string; xTab: string; yTab: string }) {
  await switchIn(page, s.pane, s.xTab, 0);
  await page.evaluate(() => (window as any).app.slot.ops.slotAdd());
  await waitSettled(page);
  await switchIn(page, s.pane, s.xTab, 1);
  await waitSettled(page);
  await expect.poll(() => onPane(page, s.x, 1, 'p => !!p.term && p._seqLive'), { timeout: 15000 }).toBe(true);
  await run(request, s.x, "printf '\\033[H\\033[2J\\033[3J'");
  for (const slot of [0, 1]) {
    await expect.poll(() => onPane(page, s.x, slot, 'p => p.term.buffer.active.length <= p.term.rows && !(p.term.buffer.active.getLine(0)?.translateToString(true) || "").includes("printf")'), { timeout: 15000 }).toBe(true);
  }
  await switchIn(page, s.pane, s.yTab, 0);
  await expect.poll(() => onPane(page, s.x, 0, asleep), { timeout: SLEEP_MS + 5000 }).toBe(true);
  expect(await onPane(page, s.x, 0, blank), '잠든 터미널의 버퍼가 비지 않았다').toBe(true);
}

async function wakeAndCompare(page: Page, s: { pane: string; x: string; xTab: string }, marker: string) {
  await switchIn(page, s.pane, s.xTab, 0);
  await expect.poll(() => onPane(page, s.x, 0, hasText(marker)), { timeout: 15000 }).toBe(true);
  await waitSettled(page);
  const woke: any = await onPane(page, s.x, 0, dump);
  const ref: any = await onPane(page, s.x, 1, dump);
  expect([woke.cols, woke.rows], '두 칸의 크기가 달라 비교할 수 없다').toEqual([ref.cols, ref.rows]);
  expect(woke.type).toBe(ref.type);
  expect(woke.lines).toEqual(ref.lines);
  expect([woke.cx, woke.cy]).toEqual([ref.cx, ref.cy]);
  return woke;
}

test.describe('PERF 2.5 깨움·잠듦', () => {
  test('W1 (NFR-PRF-6): 잠든 터미널은 term.close 하고 버퍼를 비우며, 그 sid 로 바이트가 오지 않는다', async ({ page, request }) => {
    const s = await twoTabs(page);
    // Y 가 보이는 동안 X 는 가려져 있다 — 2초 뒤 잠든다.
    await expect.poll(() => onPane(page, s.x, 0, asleep), { timeout: SLEEP_MS + 5000 }).toBe(true);
    expect(await onPane(page, s.x, 0, blank), '잠든 터미널의 버퍼가 비지 않았다').toBe(true);
    const sid = await onPane(page, s.x, 0, 'p => p._sock.sid');
    await page.evaluate((sid) => {
      const w = window as any;
      w.__sleepBytes = 0;
      w.app.channel.onBinary((u8: Uint8Array) => {
        if (new DataView(u8.buffer, u8.byteOffset, u8.length).getUint32(1, false) === sid) w.__sleepBytes += u8.length;
      });
    }, sid);
    await run(request, s.x, 'for i in $(seq 1 300); do echo sleep-out-$i; done; echo sleep-$((1+1))-done');
    await expect.poll(async () => {
      const o = await request.get('/api/tools/output?id=' + s.x + '&strip=1');
      return o.ok() && ((await o.json()).text || '').includes('sleep-2-done');
    }, { timeout: 15000 }).toBe(true);
    // TEST-16: 오지 않음을 잰다.
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as any).__sleepBytes)).toBe(0);
    expect(await page.evaluate(() => (window as any).app.testing.sleepers().map((x: any) => x.kind))).toContain('TerminalTool');
  });

  test('W2 (FR-TRM-4): 줄 출력이 흐르는 동안 잠든 터미널을 깨우면 숨기지 않은 칸과 화면·기록이 같다', async ({ page, request }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const s = await twoTabs(page);
    await sleepInSlot0(page, request, s);
    await run(request, s.x, "for i in $(seq 1 1500); do printf '\\033[3%dmline-%04d\\033[0m \\033[1mtail\\033[0m\\n' $((i%7+1)) $i; done; echo lines-$((1+1))-done");
    await expect.poll(() => onPane(page, s.x, 1, hasText('lines-2-done')), { timeout: 20000 }).toBe(true);
    const woke = await wakeAndCompare(page, s, 'lines-2-done');
    expect(woke.lines.some((l: string) => l.includes('line-0001'))).toBe(true);
  });

  test('W3 (FR-TRM-4): 대체 화면 TUI 를 그리는 동안 잠든 터미널을 깨우면 숨기지 않은 칸과 화면이 같다', async ({ page, request }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const s = await twoTabs(page);
    await sleepInSlot0(page, request, s);
    const tui = 'node -e "const o=process.stdout;o.write(\'\\x1b[?1049h\\x1b[?2004h\\x1b[?1000h\\x1b[?1006h\');let i=0;' +
      'const t=setInterval(()=>{let s=\'\';for(let r=1;r<=12;r++)s+=\'\\x1b[\'+r+\';1H\\x1b[3\'+(r%7+1)+\'mframe \'+i+\' row \'+r+\'\\x1b[K\\x1b[0m\';' +
      'o.write(s+\'\\x1b[14;5H\');if(++i>=80){clearInterval(t);setInterval(()=>{},100000);o.write(\'\\x1b[15;1Htui-\'+\'done\\x1b[3;7H\')}},20)"';
    await run(request, s.x, tui);
    await expect.poll(() => onPane(page, s.x, 1, hasText('tui-done')), { timeout: 20000 }).toBe(true);
    const woke = await wakeAndCompare(page, s, 'tui-done');
    expect(woke.type).toBe('alternate');
    const modes = await onPane(page, s.x, 0, 'p => ({ paste: p.term.modes.bracketedPasteMode, mouse: p.term.modes.mouseTrackingMode })');
    expect(modes).toEqual({ paste: true, mouse: 'vt200' });
  });

  test('W4 (NFR-PRF-14): 기록 5천 줄 터미널을 깨워 그려질 때까지 p95 100 ms 이하', async ({ page, request }, info) => {
    test.setTimeout(240000);
    const s = await twoTabs(page);
    await switchIn(page, s.pane, s.xTab, 0);
    await waitSettled(page);
    await run(request, s.x, "awk 'BEGIN{for(i=1;i<=8000;i++) printf \"\\033[3%dm%05d\\033[0m lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod %d\\n\", i%7+1, i, i*7}'; echo fill-$((1+1))-done");
    await expect.poll(() => onPane(page, s.x, 0, hasText('fill-2-done')), { timeout: 30000 }).toBe(true);
    const samples: number[] = [];
    const sizes: number[] = [];
    for (let n = 0; n < 15; n++) {
      await switchIn(page, s.pane, s.yTab, 0);
      await expect.poll(() => onPane(page, s.x, 0, asleep), { timeout: SLEEP_MS + 5000 }).toBe(true);
      const r: any = await page.evaluate(({ id, pn, t }) => new Promise((done) => {
        const a = (window as any).app;
        const p = a.tools.get(a.slot.slotKey(id, 0));
        let bytes = 0;
        const on = p._onOp.bind(p);
        p._onOp = (d: Uint8Array) => { if (!p._seqLive) bytes += d.length; on(d) };
        const t0 = performance.now();
        a.layout.tabOps.switchTab(pn, t, 0);
        const tick = () => {
          if (!(p._seqLive && !p._flushScheduled && p._outputBuf === '' && p.term)) { setTimeout(tick, 0); return }
          p.term.write('', () => requestAnimationFrame(() => { p._onOp = on; done({ ms: performance.now() - t0, bytes }) }));
        };
        tick();
      }), { id: s.x, pn: s.pane, t: s.xTab });
      samples.push(r.ms);
      sizes.push(r.bytes);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    const lines = await onPane(page, s.x, 0, 'p => p.term.buffer.active.length');
    const msg = `wake p50=${sorted[Math.floor(sorted.length / 2)].toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${sorted.at(-1)!.toFixed(1)}ms snap=${sizes[0]}B lines=${lines} samples=${samples.map((x) => x.toFixed(0)).join(',')}`;
    info.annotations.push({ type: 'measure', description: msg });
    console.log('[W4] ' + msg);
    expect(lines).toBeGreaterThan(5000);
    expect(p95).toBeLessThanOrEqual(100);
  });
});
