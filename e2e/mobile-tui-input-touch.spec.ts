import { CDPSession, Page } from '@playwright/test';
import { test, expect } from './fixtures';

// MOBILE_TUI_INPUT_SCROLL_SRS §4 — 모바일 터치 경로 (hasTouch:true 프로젝트 전용).

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'mobile');
  });
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 15000 });
  await page.waitForSelector('#mobile-keybar .mkb-btn', { timeout: 15000 });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 포커스된 터미널의 _send 를 감싸 전송 문자열을 기록한다.
async function installSendSpy(page: Page) {
  await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    if (!p) throw new Error('포커스된 터미널이 없다');
    (window as any).__sent = [];
    if ((p as any).__spied) return;
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      if (m[0] === 0) (window as any).__sent.push(new TextDecoder().decode(m.subarray(1)));
      return orig(m);
    };
    (p as any).__spied = true;
  });
}

const sent = (page: Page) => page.evaluate(() => (window as any).__sent as string[]);
const clearSent = (page: Page) => page.evaluate(() => { (window as any).__sent = []; });

// 실기기 소프트 키보드의 이벤트 패턴: keydown(229) → beforeinput/input(composed).
async function softKey(page: Page, data: string, opts: { keydown?: boolean; keyup?: boolean; composing?: boolean } = {}) {
  await page.evaluate(({ data, opts }) => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.focus();
    if (opts.keydown !== false) {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
    }
    const bi = new InputEvent('beforeinput', {
      data, inputType: opts.composing ? 'insertCompositionText' : 'insertText',
      composed: true, bubbles: true, cancelable: true, isComposing: !!opts.composing,
    } as any);
    const notCancelled = ta.dispatchEvent(bi);
    // 브라우저는 beforeinput 이 취소되지 않았을 때만 값을 바꾸고 input 을 낸다.
    if (notCancelled) {
      ta.value += data;
      ta.dispatchEvent(new InputEvent('input', {
        data, inputType: opts.composing ? 'insertCompositionText' : 'insertText',
        composed: true, bubbles: true, cancelable: true, isComposing: !!opts.composing,
      } as any));
    }
    if (opts.keyup) {
      ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, bubbles: true }));
    }
  }, { data, opts });
}

async function paneState(page: Page) {
  return await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    return { viewportY: p.term.buffer.active.viewportY, rows: p.term.rows };
  });
}

async function fill(page: Page, lines = 300) {
  await page.evaluate((n) => {
    const p = (window as any).app._focusedTerminal();
    let s = '';
    for (let i = 1; i <= n; i++) s += `line-${i}\r\n`;
    p.term.write(s);
  }, lines);
  await page.waitForTimeout(300);
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

async function screenCenter(page: Page) {
  const box = await page.locator('#area .pn.focused .xterm-screen').boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

test.describe('FR-MTI-1~5: 모바일 IME 입력이 유실되지 않는다', () => {
  test('TC-MTI-1: keydown(229) 뒤의 insertText 가 전송된다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);
    await softKey(page, 'A', { keyup: true });
    expect(await sent(page)).toEqual(['A']);
  });

  test('TC-MTI-2: 같은 tick 3연타가 중복 없이 전송된다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);
    // 실측된 결함: xterm CompositionHelper 는 ["abc","bc","c"] 를 보내 6글자가 들어간다.
    await page.evaluate(async () => {
      const p = (window as any).app._focusedTerminal();
      const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      ta.focus(); ta.value = '';
      const soft = (d: string) => {
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true } as any));
        const bi = new InputEvent('beforeinput', { data: d, inputType: 'insertText', composed: true, bubbles: true, cancelable: true } as any);
        if (ta.dispatchEvent(bi)) {
          ta.value += d;
          ta.dispatchEvent(new InputEvent('input', { data: d, inputType: 'insertText', composed: true, bubbles: true, cancelable: true } as any));
        }
        ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, bubbles: true } as any));
      };
      soft('a'); soft('b'); soft('c');
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(await sent(page)).toEqual(['a', 'b', 'c']);
  });

  test('TC-MTI-13: 소프트키 직후 같은 tick 의 Enter 에서 글자가 유실되지 않는다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);
    // 실측된 결함: 'x' 가 사라지고 "\r" 만 전송된다.
    await page.evaluate(async () => {
      const p = (window as any).app._focusedTerminal();
      const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      ta.focus(); ta.value = '';
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true } as any));
      const bi = new InputEvent('beforeinput', { data: 'x', inputType: 'insertText', composed: true, bubbles: true, cancelable: true } as any);
      if (ta.dispatchEvent(bi)) {
        ta.value += 'x';
        ta.dispatchEvent(new InputEvent('input', { data: 'x', inputType: 'insertText', composed: true, bubbles: true, cancelable: true } as any));
      }
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, code: 'Enter', bubbles: true, cancelable: true } as any));
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(await sent(page)).toEqual(['x', '\r']);
  });

  test('TC-MTI-3: composition 중 beforeinput 은 가로채지 않는다', async ({ page }) => {
    await gotoMobile(page);
    const notCancelled = await page.evaluate(() => {
      const p = (window as any).app._focusedTerminal();
      const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      ta.focus();
      const bi = new InputEvent('beforeinput', {
        data: '가', inputType: 'insertCompositionText', composed: true,
        bubbles: true, cancelable: true, isComposing: true,
      } as any);
      return ta.dispatchEvent(bi);
    });
    expect(notCancelled).toBe(true);
  });
});

test.describe('FR-MTI-6~11: 터치 스크롤', () => {
  test('TC-MTI-5: 200px 드래그가 1:1(11행) 보다 크게 스크롤한다', async ({ page }) => {
    await gotoMobile(page);
    await fill(page);
    const before = await paneState(page);
    const client = await page.context().newCDPSession(page);
    await touchDrag(client, await screenCenter(page), 200);
    await page.waitForTimeout(100);
    const after = await paneState(page);
    const moved = before.viewportY - after.viewportY;
    expect(moved).toBeGreaterThan(20);
  });

  test('TC-MTI-6: 손을 뗀 뒤에도 관성으로 더 스크롤된다', async ({ page }) => {
    await gotoMobile(page);
    await fill(page);
    const client = await page.context().newCDPSession(page);
    const center = await screenCenter(page);
    // touchEnd 직후 즉시 관측 → 감쇠가 끝난 뒤 다시 관측
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: center.x, y: center.y }] } as any);
    for (let i = 1; i <= 10; i++) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: center.x, y: center.y + (200 * i) / 10 }],
      } as any);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any);
    const atEnd = await paneState(page);
    await page.waitForTimeout(800);
    const settled = await paneState(page);
    expect(atEnd.viewportY - settled.viewportY).toBeGreaterThan(0);
  });

  test('TC-MTI-7: slop 미만의 짧은 탭은 스크롤하지 않는다', async ({ page }) => {
    await gotoMobile(page);
    await fill(page);
    const before = await paneState(page);
    const client = await page.context().newCDPSession(page);
    const c = await screenCenter(page);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] } as any);
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x, y: c.y + 3 }] } as any);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any);
    await page.waitForTimeout(300);
    const after = await paneState(page);
    expect(after.viewportY).toBe(before.viewportY);
  });
});

test.describe('FR-MTI-12: 리사이즈 병합', () => {
  test('TC-MTI-9: visualViewport 이벤트 다수가 프레임당 fit 1회로 병합된다', async ({ page }) => {
    await gotoMobile(page);
    const n = await page.evaluate(async () => {
      const app = (window as any).app;
      let fits = 0;
      for (const p of app.tools.values()) {
        if (!p.el.classList.contains('vis')) continue;
        const orig = p.doFit.bind(p);
        p.doFit = () => { fits++; return orig(); };
      }
      for (let i = 0; i < 20; i++) app._scheduleMobileFit();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return fits;
    });
    expect(n).toBe(1);
  });
});

test.describe('FR-MTI-14: 키바 버튼은 포커스를 받지 않는다', () => {
  test('TC-MTI-10: tabindex=-1 이고 스와이프 후에도 포커스가 터미널에 남는다', async ({ page }) => {
    await gotoMobile(page);
    const tabs = await page.locator('#mobile-keybar .mkb-btn').evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).tabIndex));
    expect(new Set(tabs)).toEqual(new Set([-1]));

    const box = await page.locator('#mobile-keybar .mkb-btn').first().boundingBox();
    const client = await page.context().newCDPSession(page);
    const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] } as any);
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 40, y }] } as any);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as any);
    await page.waitForTimeout(300);
    const cls = await page.evaluate(() => document.activeElement?.className || '');
    expect(cls).toContain('xterm-helper-textarea');
  });
});

test.describe('FR-MTI-15~17: sticky modifier', () => {
  test('TC-MTI-11: Ctrl sticky 는 여러 문자 입력에서도 소비된다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);
    await page.evaluate(() => { (window as any).app._modKbd.ctrl = true; });
    await softKey(page, 'ab', { keyup: true });
    const out = await sent(page);
    expect(out).toEqual(['\x01b']);
    expect(await page.evaluate(() => (window as any).app._modKbd.ctrl)).toBe(false);
  });

  test('TC-MTI-12: Alt sticky + 한글에는 ESC 를 붙이지 않고 sticky 를 소비한다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);
    await page.evaluate(() => { (window as any).app._modKbd.alt = true; });
    await softKey(page, '가', { keyup: true });
    expect(await sent(page)).toEqual(['가']);
    expect(await page.evaluate(() => (window as any).app._modKbd.alt)).toBe(false);
  });
});

test.describe('FR-MTI-19: 물리 키보드 중복 방지', () => {
  test('TC-MTI-14: 모바일 폭에서 물리 키보드 입력이 중복 전송되지 않는다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);
    // page.keyboard.type 은 keydown/char/keyup 을 보낸다 — xterm 이 keydown 을
    // 처리한 뒤 char 의 beforeinput 이 오는 경로다.
    // 공백은 xterm 이 keypress 로 전송하며 preventDefault 를 하지 않는다 —
    // 중복이 나는 유일한 문자였다. 반드시 포함한다.
    await page.keyboard.type('cd /tmp/xyz');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect((await sent(page)).join('')).toBe('cd /tmp/xyz\r');
  });
});
