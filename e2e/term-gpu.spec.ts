import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * TERMINAL_GPU_RENDER_SRS FR-TGR-18 — 보이는 칸만 GPU 로 그린다.
 *
 * fixture 는 모든 스펙을 DOM 렌더러로 고정한다 (FR-TGR-17). 이 파일만 그 값을 다시 켠다 —
 * init 스크립트는 건 순서대로 돌므로 여기서 건 것이 이긴다.
 *
 * 헤드리스에 WebGL2 가 없으면 붙이기가 실패한다. 그때는 **DOM 복귀**를 잰다 — 그것도
 * 이 SRS 의 요구다 (FR-TGR-9·12).
 */

const gpuState = (page: Page) => page.evaluate(() => {
  const p = (window as any).app.testing.focusedTerminal();
  const g = (0, eval)('TermGpu');
  return {
    renderer: p.gpuRenderer() as string,
    canvas: p.el.querySelectorAll('.xterm-screen canvas').length as number,
    unavailable: !!g.unavailable,
  };
});

/** 버퍼에 `needle` 이 있는가. WebGL 에서는 `.xterm-rows` 가 비므로 버퍼로 잰다. */
const bufferHas = (page: Page, needle: string) => page.evaluate((s) => {
  const b = (window as any).app.testing.focusedTerminal().term.buffer.active;
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) || '').includes(s)) return true;
  return false;
}, needle);

/**
 * FR-TGR-7a: 터미널 화면이 칸 너비를 얼마나 덮는가. `fit` 이 맞으면 한 칸 폭 이내로 꽉 찬다.
 * 렌더러를 바꾸고 다시 재지 않으면 DOM↔WebGL 칸 폭 차이(약 5%)만큼 모자라거나 넘친다.
 */
const coverage = (page: Page) => page.evaluate(() => {
  const p = (window as any).app.testing.focusedTerminal();
  const scr = p.el.querySelector('.xterm-screen').getBoundingClientRect().width;
  return scr / p.box.clientWidth;
});

/** WebGL 이 실제로 그리는가 — 비운 화면과 글자를 쓴 화면의 스크린샷이 달라야 한다. */
async function paints(page: Page) {
  const scr = page.locator('#area .pn.focused .xterm-screen');
  const settle = (s: string) => page.evaluate((text) => new Promise<void>((r) => {
    const t = (window as any).app.testing.focusedTerminal().term;
    t.options.cursorBlink = false;
    if (!text) t.reset();
    t.write(text, () => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  }), s);
  await settle('');
  const blank = await scr.screenshot();
  await settle('\x1b[1m' + '█'.repeat(40) + ' WEBGL PAINT 한글\x1b[0m\r\n');
  const drawn = await scr.screenshot();
  return !blank.equals(drawn);
}

async function roundTrip(page: Page, tag: string) {
  await page.locator('#area .pn.focused .xterm-helper-textarea').focus();
  await page.keyboard.type(`echo ${tag}-$((40+2))`);
  await page.keyboard.press('Enter');
  await expect.poll(() => bufferHas(page, `${tag}-42`), { timeout: 15000 }).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.context().addInitScript(() => { localStorage.setItem('termGpu', '1') });
  await waitForInit(page);
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
});

test('V-TGR-1: 보이는 칸은 WebGL 로 그리거나, 쓸 수 없으면 DOM 으로 돌아가고 입력이 왕복한다', async ({ page }) => {
  await expect.poll(async () => {
    const s = await gpuState(page);
    return s.renderer === 'webgl' || s.unavailable;
  }, { timeout: 10000 }).toBe(true);
  const s = await gpuState(page);
  if (s.renderer === 'webgl') expect(s.canvas).toBeGreaterThan(0);
  else expect(s.canvas).toBe(0);
  expect(await paints(page)).toBe(true);
  await roundTrip(page, 'gpu1');
});

test('V-TGR-2: 탭을 바꾸면 숨은 칸에서 떼고, 새로 보이는 칸에 붙인다', async ({ page }) => {
  const first = await gpuState(page);
  test.skip(first.unavailable, '이 환경은 WebGL2 를 쓸 수 없다 — V-TGR-1 이 복귀를 잰다');
  await expect.poll(() => gpuState(page).then((s) => s.renderer), { timeout: 10000 }).toBe('webgl');

  await page.evaluate(() => {
    const w = window as any;
    w.__gpuFirst = w.app.testing.focusedTerminal();
    w.app.addTabFocused();
  });
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.app.testing.focusedTerminal() !== w.__gpuFirst && w.__gpuFirst.gpuRenderer() === 'dom'
      && w.__gpuFirst.el.querySelectorAll('.xterm-screen canvas').length === 0;
  }), { timeout: 10000 }).toBe(true);
  await expect.poll(() => gpuState(page).then((s) => s.renderer), { timeout: 10000 }).toBe('webgl');
});

test('V-TGR-3: 설정을 끄면 곧바로 DOM 으로 돌아가고 글자가 .xterm-rows 에 선다', async ({ page }) => {
  const first = await gpuState(page);
  test.skip(first.unavailable, '이 환경은 WebGL2 를 쓸 수 없다 — V-TGR-1 이 복귀를 잰다');
  await expect.poll(() => gpuState(page).then((s) => s.renderer), { timeout: 10000 }).toBe('webgl');
  await roundTrip(page, 'gpu3');
  const on = await coverage(page);
  expect(on).toBeGreaterThan(0.97);
  expect(on).toBeLessThan(1.01);

  await page.click('#settings-btn');
  await page.click('.mtab[data-tab="terminal"]');
  const cb = page.locator('#ds-termgpu');
  await expect(cb).toBeChecked();
  await cb.uncheck();
  await page.click('#modal-close');

  await expect.poll(() => gpuState(page).then((s) => `${s.renderer}/${s.canvas}`), { timeout: 10000 }).toBe('dom/0');
  const off = await coverage(page);
  expect(off).toBeGreaterThan(0.97);
  expect(off).toBeLessThan(1.01);
  expect(await page.evaluate(() => localStorage.getItem('termGpu'))).toBe('0');
  await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('gpu3-42');
});
