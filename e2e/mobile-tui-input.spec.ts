import { Page } from '@playwright/test';
import { test, expect } from './fixtures';

// MOBILE_TUI_INPUT_SCROLL_SRS §4 — 데스크톱 회귀 (FR-MTI-4 / FR-MTI-11).
// 이 파일은 chromium(hasTouch:false) 프로젝트에서 돈다.

async function gotoDesktop(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

test('TC-MTI-4: 데스크톱 모드에서는 beforeinput 을 가로채지 않는다', async ({ page }) => {
  await gotoDesktop(page);
  const r = await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    const sentArr: string[] = [];
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => { if (m[0] === 0) sentArr.push(new TextDecoder().decode(m.subarray(1))); return orig(m); };
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.focus();
    const bi = new InputEvent('beforeinput', {
      data: 'Z', inputType: 'insertText', composed: true, bubbles: true, cancelable: true,
    } as any);
    const notCancelled = ta.dispatchEvent(bi);
    return { notCancelled, sent: sentArr };
  });
  // 취소되지 않아야 한다 — 데스크톱은 xterm 의 기존 경로를 그대로 쓴다.
  expect(r.notCancelled).toBe(true);
  expect(r.sent).toEqual([]);
});

test('TC-MTI-8: 데스크톱 모드의 터치 스크롤 개입은 없다', async ({ page }) => {
  await gotoDesktop(page);
  const moved = await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    let s = '';
    for (let i = 1; i <= 300; i++) s += `line-${i}\r\n`;
    p.term.write(s);
    const before = p.term.buffer.active.viewportY;
    const el = p.el as HTMLElement;
    const mk = (type: string, y: number) => {
      const t = new Touch({ identifier: 1, target: el, clientX: 10, clientY: y, pageX: 10, pageY: y });
      return new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], bubbles: true, cancelable: true });
    };
    el.dispatchEvent(mk('touchstart', 300));
    el.dispatchEvent(mk('touchmove', 100));
    el.dispatchEvent(mk('touchend', 100));
    return { before, after: p.term.buffer.active.viewportY };
  });
  expect(moved.after).toBe(moved.before);
});
