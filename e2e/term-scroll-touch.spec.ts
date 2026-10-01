import { CDPSession, Page } from '@playwright/test';

import { test, expect, waitSettled } from './fixtures';

/**
 * UX_BATCH11_SRS FR-MTS (개정 1) — 모바일 터치 스크롤이 움직임을 잃지 않고 손가락을 따라온다.
 *
 * 터치는 CDP 로 낸다. "손가락이 멈췄다 뗀다" 는 기다릴 조건이 아니라 **입력 자체**라 고정 대기로
 * 흉내낸다 (`TEST-16`: 멈춤 시간이 곧 재려는 입력이다).
 */
async function goto(page: Page, mode: 'mobile' | 'desktop' = 'mobile') {
  await page.context().addInitScript((m) => { sessionStorage.setItem('displayMode', m) }, mode);
  await page.goto('/');
  if (mode === 'mobile') await page.waitForSelector('body.mobile', { timeout: 15000 });
  await waitSettled(page);
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function fill(page: Page) {
  await page.evaluate(() => {
    const p = (window as any).app.testing.focusedTerminal();
    let s = '';
    for (let i = 1; i <= 300; i++) s += `line-${i}\r\n`;
    p.term.write(s);
  });
  await expect.poll(() => page.evaluate(() =>
    (window as any).app.testing.focusedTerminal().term.buffer.active.length), { timeout: 10000 }).toBeGreaterThan(300);
}

const geo = (page: Page) => page.evaluate(() => {
  const p = (window as any).app.testing.focusedTerminal();
  const r = p.el.querySelector('.xterm-screen').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, rh: r.height / p.term.rows, vy: p.term.buffer.active.viewportY };
});
const vy = (page: Page) => page.evaluate(() => (window as any).app.testing.focusedTerminal().term.buffer.active.viewportY);

const touch = (cdp: CDPSession, type: string, pt?: { x: number; y: number }) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pt ? [pt] : [] } as any);

/** 끌고 `hold` ms 멈춘 뒤 뗀다. hold 가 0 이면 곧바로 뗀다(튕기기). */
async function drag(page: Page, cdp: CDPSession, from: { x: number; y: number }, dy: number, steps: number, hold: number, dx = 0) {
  await touch(cdp, 'touchStart', from);
  for (let i = 1; i <= steps; i++) await touch(cdp, 'touchMove', { x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps });
  // **예외 (`TEST-16`)**: 손가락이 멈춘 시간이 재려는 입력이다.
  if (hold) await page.waitForTimeout(hold);
  await touch(cdp, 'touchEnd');
}

test('TC-MTS-3 마우스 리포팅 TUI 에서 빠른 끌기의 행이 리포트로 다 간다', async ({ page }) => {
  await goto(page);
  await page.evaluate(() => {
    const p = (window as any).app.testing.focusedTerminal();
    (window as any).__reports = 0;
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      if (m[0] === 0) {
        const t = new TextDecoder().decode(m.subarray(1));
        (window as any).__reports += (t.match(/\x1b\[<6[45];\d+;\d+M/g) || []).length;
      }
      return orig(m);
    };
    p.term.write('\x1b[?1000h\x1b[?1006h');
  });
  // **예외 (`TEST-16`)**: 마우스 트래킹이 켜진 것은 화면에 드러나지 않는다.
  await page.waitForTimeout(300);
  await page.evaluate(() => { (window as any).__reports = 0 });
  const g = await geo(page);
  const cdp = await page.context().newCDPSession(page);
  // 세 번에 300 px — 종전 구현은 프레임당 리포트 하나라 3 개 남짓이었다. 관성을 빼려고 멈췄다 뗀다.
  await drag(page, cdp, { x: g.x, y: g.y + 150 }, -300, 3, 250);
  const want = Math.floor(300 / g.rh);
  await expect.poll(() => page.evaluate(() => (window as any).__reports), { timeout: 10000 }).toBeGreaterThanOrEqual(want - 1);
  expect(await page.evaluate(() => (window as any).__reports)).toBeLessThanOrEqual(want + 1);
});

test('TC-MTS-4 보통 버퍼에서 끈 만큼(1:1) 스크롤한다', async ({ page }) => {
  await goto(page);
  await fill(page);
  const g = await geo(page);
  const cdp = await page.context().newCDPSession(page);
  await drag(page, cdp, { x: g.x, y: g.y - 100 }, 200, 20, 250);
  const want = 200 / g.rh;
  await expect.poll(async () => g.vy - (await vy(page)), { timeout: 10000 }).toBeGreaterThanOrEqual(Math.floor(want) - 1);
  expect(g.vy - (await vy(page))).toBeLessThanOrEqual(Math.ceil(want) + 1);
});

test('TC-MTS-5 합성 wheel 의 좌표는 손가락 위치다', async ({ page }) => {
  await goto(page);
  await page.evaluate(() => {
    const p = (window as any).app.testing.focusedTerminal();
    (window as any).__wheel = [];
    p.term.element.addEventListener('wheel', (e: WheelEvent) => (window as any).__wheel.push([e.clientX, e.clientY]), true);
  });
  const g = await geo(page);
  const cdp = await page.context().newCDPSession(page);
  const from = { x: g.x - 80, y: g.y };
  await drag(page, cdp, from, 120, 6, 250);
  await expect.poll(() => page.evaluate(() => (window as any).__wheel.length), { timeout: 10000 }).toBeGreaterThan(0);
  const [x, y] = (await page.evaluate(() => (window as any).__wheel)).at(-1);
  expect(Math.abs(x - from.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(y - (from.y + 120))).toBeLessThanOrEqual(1);
});

test('TC-MTS-6 튕기면 더 가고, 멈췄다 떼면 더 가지 않는다', async ({ page }) => {
  await goto(page);
  await fill(page);
  const cdp = await page.context().newCDPSession(page);
  let g = await geo(page);
  await drag(page, cdp, { x: g.x, y: g.y - 100 }, 200, 5, 0);
  const atEnd = await vy(page);
  await expect.poll(async () => atEnd - (await vy(page)), { timeout: 10000 }).toBeGreaterThan(0);

  // 관성이 다 끝나기를 기다린다 — 두 번 연속 같은 자리면 멎었다.
  let last = -1;
  await expect.poll(async () => { const v = await vy(page); const same = v === last; last = v; return same }, { timeout: 10000, intervals: [200] }).toBe(true);
  g = await geo(page);
  await drag(page, cdp, { x: g.x, y: g.y - 100 }, 200, 5, 250);
  const held = await vy(page);
  // **예외 (`TEST-16`): 일어나지 않는 관성을 잰다.**
  await page.waitForTimeout(500);
  expect(await vy(page)).toBe(held);
});

test('TC-MTS-7 데스크톱 레이아웃의 터치 기기에서도 터치로 스크롤한다', async ({ page }) => {
  await goto(page, 'desktop');
  expect(await page.evaluate(() => document.body.classList.contains('mobile'))).toBe(false);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  const ta = await page.evaluate(() => getComputedStyle(document.querySelector('#area .pn.focused .tp')!).touchAction);
  expect(ta).toBe('none');
  await fill(page);
  const g = await geo(page);
  const cdp = await page.context().newCDPSession(page);
  await drag(page, cdp, { x: g.x, y: g.y - 100 }, 200, 20, 250);
  await expect.poll(async () => g.vy - (await vy(page)), { timeout: 10000 }).toBeGreaterThan(3);
});
