import { CDPSession, Page } from '@playwright/test';
import { test, expect } from './fixtures';

// MOBILE_TUI_INPUT_SCROLL_SRS §7 — 실기기 로그가 지목한 근본 원인의 교정.

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'mobile') });
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 15000 });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function screenCenter(page: Page) {
  const box = await page.locator('#area .pn.focused .xterm-screen').boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

async function touchDrag(client: CDPSession, from: { x: number; y: number }, dy: number, steps = 10) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] } as any);
  for (let i = 1; i <= steps; i++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: from.x, y: from.y + (dy * i) / steps }],
    } as any);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any);
}

test('TC-MTI-24 (FR-MTI-27): layout viewport 를 줄이지 않는다 — interactive-widget=resizes-visual', async ({ page }) => {
  await gotoMobile(page);
  const v = await page.evaluate(() =>
    (document.querySelector('meta[name="viewport"]') as HTMLMetaElement)?.content || '');
  expect(v).toContain('interactive-widget=resizes-visual');
  expect(v).not.toContain('resizes-content');
});

test('TC-MTI-25 (FR-MTI-28): 터치 드래그가 xterm 의 wheel 경로로 넘어간다', async ({ page }) => {
  await gotoMobile(page);
  // 스크롤백이 전혀 없는 상태 — 실기기의 TUI 조건(len==rows)이다.
  // 이전 구현(scrollLines)은 여기서 아무 일도 하지 못했다.
  const wheels = await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    (window as any).__wheels = [];
    p.term.element.addEventListener('wheel', (e: WheelEvent) => {
      (window as any).__wheels.push(e.deltaY);
    }, true);
    return (window as any).__wheels.length;
  });
  expect(wheels).toBe(0);

  const client = await page.context().newCDPSession(page);
  await touchDrag(client, await screenCenter(page), 200);
  await page.waitForTimeout(200);

  const got = await page.evaluate(() => (window as any).__wheels as number[]);
  expect(got.length).toBeGreaterThan(0);
  // 아래로 끌면(위로 스크롤) deltaY 는 음수여야 한다.
  expect(got.every((d) => d < 0)).toBe(true);
  // 감도 배율이 실려 있어야 한다 — 이동 픽셀 총합보다 크다.
  expect(Math.abs(got.reduce((a, b) => a + b, 0))).toBeGreaterThan(200);
});

test('TC-MTI-26 (FR-MTI-28): 마우스 리포팅이 켜진 TUI 에는 휠 리포트가 전송된다', async ({ page }) => {
  await gotoMobile(page);
  const client = await page.context().newCDPSession(page);
  // 마우스 리포팅을 켠다(DECSET 1000+1006) — 실기기 로그의 조건.
  await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    (window as any).__sent = [];
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      if (m[0] === 0) (window as any).__sent.push(new TextDecoder().decode(m.subarray(1)));
      return orig(m);
    };
    p.term.write('\x1b[?1000h\x1b[?1006h');
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { (window as any).__sent = [] });

  await touchDrag(client, await screenCenter(page), -200);   // 위로 끌기 = 아래로 스크롤
  await page.waitForTimeout(200);

  const sent = (await page.evaluate(() => (window as any).__sent as string[])).join('');
  // SGR 휠 리포트: ESC[<64;x;yM (up) / ESC[<65;x;yM (down)
  expect(sent).toMatch(/\x1b\[<6[45];\d+;\d+M/);
});

test('TC-MTI-27 (FR-MTI-29): 스크롤 제스처의 합성 마우스 이벤트가 차단된다', async ({ page }) => {
  await gotoMobile(page);
  const client = await page.context().newCDPSession(page);
  const c = await screenCenter(page);
  await touchDrag(client, c, 200);

  // 제스처 직후의 합성분에 해당하는 창에서 mousedown 이 막힌다.
  const dp = await page.evaluate(({ x, y }) => {
    const p = (window as any).app._focusedTerminal();
    const ev = new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true, cancelable: true });
    p.el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, c);
  expect(dp).toBe(true);
});
