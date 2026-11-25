import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitShellReady, JSON_HDR } from './fixtures';

/**
 * PERF M2 §2.7 위로 스크롤 받기 (FR-TRM-5, D-20).
 *
 * 브라우저 기록(기본 5,000행)보다 많은 번호 줄을 찍고, 실시간 xterm 맨 위에서 더 올리면 그 위 구간이 기록 보기에
 * 원래 글자 그대로, 실시간 버퍼 맨 윗줄 바로 앞까지 이어서 보인다. 기록 보기 맨 위에 닿으면 더 받는다. 받는 동안
 * 입력은 막히지 않는다.
 */

const N = 8000;

const pane = (page: Page, fn: string) => page.evaluate(`((p) => (${fn})(p))(window.app.testing.focusedTerminal())`);

const liveTop = `p => p.term.buffer.active.getLine(0).translateToString(true).trim()`;

const viewLines = `p => {
  const v = p.history.view;
  if (!v) return null;
  const b = v.buffer.active, out = [];
  for (let i = 0; i < b.length; i++) { const s = b.getLine(i).translateToString(true).trim(); if (s) out.push(s) }
  return out;
}`;

const num = (s: string) => Number(s.slice(1));

async function fill(page: Page, request: any) {
  await waitForInit(page, { clearLocalStorage: true });
  await waitShellReady(page);
  const id = await pane(page, 'p => p.id');
  const res = await request.post('/api/tools/input', { headers: JSON_HDR, data: { id, text: `seq -f 'H%05g' 1 ${N}`, execute: true } });
  expect(res.ok()).toBe(true);
  await expect.poll(() => pane(page, `p => { const b = p.term.buffer.active; for (let i = b.length - 1; i >= 0; i--) if (b.getLine(i).translateToString(true).includes('H0${N}')) return true; return false }`), { timeout: 20000 }).toBe(true);
  // 마지막 줄 뒤에 프롬프트가 서야 버퍼가 멈춘다(그 전에 잰 맨 윗줄은 한 줄 밀릴 수 있다).
  await expect.poll(() => pane(page, `p => { const b = p.term.buffer.active; for (let i = b.length - 1; i >= 0; i--) { const s = b.getLine(i).translateToString(true).trim(); if (s) return s !== 'H0${N}' } return false }`), { timeout: 10000 }).toBe(true);
  // 실시간 버퍼 맨 윗줄이 번호 줄이어야 잇닿음을 잴 수 있다.
  await expect.poll(() => pane(page, liveTop), { timeout: 10000 }).toMatch(/^H\d{5}$/);
}

const wheelUp = `p => { p.term.scrollToTop(); p.box.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); return true }`;

test.describe('PERF 2.7 위로 스크롤 받기', () => {
  test('H1: 5천 줄 위로 올리면 그 위 기록이 원래 글자로 이어서 보이고, 맨 위에서 더 받는다', async ({ page, request }) => {
    await fill(page, request);
    await pane(page, wheelUp);
    await expect.poll(() => pane(page, 'p => p.history.isOpen'), { timeout: 10000 }).toBe(true);
    // 프롬프트가 늦게 한 줄 더 밀 수 있다 — 맨 윗줄은 기록 보기가 열린 뒤에 읽는다.
    const top = num(String(await pane(page, liveTop)));
    expect(top, '브라우저가 기록을 전부 들고 있다 — 시험이 되지 않는다').toBeGreaterThan(1);
    let lines = (await pane(page, viewLines)) as string[];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1], '실시간 버퍼 맨 윗줄 바로 앞에서 끝나지 않는다').toBe(`H${String(top - 1).padStart(5, '0')}`);
    lines.forEach((s, i) => expect(s).toBe(`H${String(num(lines[0]) + i).padStart(5, '0')}`));
    const first = num(lines[0]);

    if (first > 1) {
      await pane(page, 'p => { p.history.view.scrollToTop(); return true }');
      await expect.poll(async () => num(((await pane(page, viewLines)) as string[])[0]), { timeout: 10000 }).toBeLessThan(first);
      lines = (await pane(page, viewLines)) as string[];
      lines.forEach((s, i) => expect(s).toBe(`H${String(num(lines[0]) + i).padStart(5, '0')}`));
      expect(lines[lines.length - 1]).toBe(`H${String(top - 1).padStart(5, '0')}`);
    }

    await pane(page, 'p => { p.history.close(); return true }');
    expect(await pane(page, 'p => p.history.isOpen')).toBe(false);
  });

  test('H2: 받는 동안 입력이 막히지 않는다 — 입력 키는 기록 보기를 닫고 터미널로 간다', async ({ page, request }) => {
    await fill(page, request);
    await pane(page, 'p => { p.term.focus(); return true }');
    const t0 = Date.now();
    await pane(page, wheelUp);
    await page.keyboard.type('echo HIST_INPUT_OK\n');
    await expect.poll(() => pane(page, `p => { const b = p.term.buffer.active; for (let i = b.length - 1; i >= Math.max(0, b.length - 50); i--) if (b.getLine(i).translateToString(true).trim() === 'HIST_INPUT_OK') return true; return false }`), { timeout: 10000 }).toBe(true);
    expect(Date.now() - t0, '입력이 늦었다').toBeLessThan(5000);
    expect(await pane(page, 'p => p.history.isOpen')).toBe(false);
  });
});
