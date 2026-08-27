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

// FR-MTI-35 회귀: xterm 의 CompositionHelper 를 건드리면 데스크톱의 한글 조합까지
// 죽는다. 실제로 그 회귀를 냈다 — 조합 미리보기가 사라지고(치는 과정이 보이지
// 않음), 증분 계산이 없어져 확정마다 누적 전체가 다시 전송됐다.
test('TC-MTI-34 (FR-MTI-35): 데스크톱의 조합 미리보기와 증분 전송이 살아 있다', async ({ page }) => {
  await gotoDesktop(page);
  const r = await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const sentArr: string[] = [];
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => { if (m[0] === 0) sentArr.push(new TextDecoder().decode(m.subarray(1))); return orig(m) };
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.focus(); ta.value = '';

    const compose = async (steps: string[], final: string) => {
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
      for (const d of steps) {
        ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
        ta.value = d;
        ta.dispatchEvent(new InputEvent('input', { data: d, inputType: 'insertCompositionText', isComposing: true, bubbles: true, cancelable: true } as any));
      }
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: final, bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
    };

    await compose(['ㄱ', '가', '간'], '간');
    const v = p.el.querySelector('.composition-view') as HTMLElement | null;
    const previewExists = !!v;

    // 두 번째 조합: textarea 값이 누적돼도 증분만 나가야 한다.
    sentArr.length = 0;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const d of ['간ㄴ', '간나']) {
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
      ta.value = d;
      ta.dispatchEvent(new InputEvent('input', { data: d, inputType: 'insertCompositionText', isComposing: true, bubbles: true, cancelable: true } as any));
    }
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '간나', bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    return { previewExists, second: sentArr.join('') };
  });
  expect(r.previewExists).toBe(true);
  // 누적 전체("간나")가 아니라 증분("나")이어야 한다.
  expect(r.second).not.toContain('간나');
});
