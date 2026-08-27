import { Page } from '@playwright/test';
import { test, expect } from './fixtures';

// MOBILE_TUI_INPUT_SCROLL_SRS §8 — IME 전송 순서와 wheel 병합.

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'mobile') });
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 15000 });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    (window as any).__sent = [];
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      if (m[0] === 0) (window as any).__sent.push(new TextDecoder().decode(m.subarray(1)));
      return orig(m);
    };
    (p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement).focus();
  });
}

const sent = (page: Page) => page.evaluate(() => (window as any).__sent as string[]);

// Android GBoard 의 실제 순서를 재현한다: 조합 중에는 insertCompositionText 가
// 오고, 확정 문자(스페이스)는 compositionend 보다 **먼저** insertText 로 온다.
async function typeKoreanThenSpace(page: Page) {
  await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    const fire = (type: string, init: any) => ta.dispatchEvent(new (init.__ce ? CompositionEvent : InputEvent)(type, init));

    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const d of ['ㅇ', '여', '여ㅈ', '여전', '여전히']) {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
      ta.dispatchEvent(new InputEvent('beforeinput', { data: d, inputType: 'insertCompositionText', isComposing: true, bubbles: true, cancelable: true } as any));
      ta.dispatchEvent(new InputEvent('input', { data: d, inputType: 'insertCompositionText', isComposing: true, bubbles: true, cancelable: true } as any));
    }
    // 스페이스: isComposing=false 로 오지만 compositionend 는 아직이다.
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new InputEvent('beforeinput', { data: ' ', inputType: 'insertText', isComposing: false, bubbles: true, cancelable: true } as any));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '여전히', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
  });
}

test('TC-MTI-28 (FR-MTI-30): 조합 문자열이 확정 문자보다 먼저 전송된다', async ({ page }) => {
  await gotoMobile(page);
  await typeKoreanThenSpace(page);
  const out = (await sent(page)).join('');
  // 이전 결함: " 여전히" (스페이스가 앞섰다)
  expect(out).toBe('여전히 ');
});

test('TC-MTI-29 (FR-MTI-30): 조합 중에는 아무것도 전송하지 않는다', async ({ page }) => {
  await gotoMobile(page);
  await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const d of ['ㄱ', '가', '간']) {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
      ta.dispatchEvent(new InputEvent('beforeinput', { data: d, inputType: 'insertCompositionText', isComposing: true, bubbles: true, cancelable: true } as any));
      ta.dispatchEvent(new InputEvent('input', { data: d, inputType: 'insertCompositionText', isComposing: true, bubbles: true, cancelable: true } as any));
    }
    await new Promise((r) => setTimeout(r, 150));
  });
  expect((await sent(page)).join('')).toBe('');
});

test('TC-MTI-30 (FR-MTI-31): 조합 밖의 백스페이스는 DEL 로 전송된다', async ({ page }) => {
  await gotoMobile(page);
  await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent('beforeinput', { data: null, inputType: 'deleteContentBackward', isComposing: false, bubbles: true, cancelable: true } as any));
    await new Promise((r) => setTimeout(r, 100));
  });
  expect((await sent(page)).join('')).toBe('\x7f');
});

test('TC-MTI-31 (FR-MTI-32): wheel 은 프레임당 한 번, 누적 delta 로 나간다', async ({ page }) => {
  await gotoMobile(page);
  const n = await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const got: number[] = [];
    p.term.element.addEventListener('wheel', (e: WheelEvent) => got.push(e.deltaY), true);
    for (let i = 0; i < 10; i++) p._touchScrollBy(-10);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return got;
  });
  expect(n.length).toBe(1);
  expect(n[0]).toBe(-100);
});

test('TC-MTI-32 (FR-MTI-33): 새 버전이 감지되면 배너가 뜬다', async ({ page }) => {
  await gotoMobile(page);
  await expect(page.locator('#ver-banner')).toHaveCount(0);
  // index.html 이 다른 버전을 가리키는 상황을 만든다.
  await page.route('**/?_v=*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<script src="js/core/main.js?v=999999"></script>' }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#ver-banner')).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('#ver-banner')).toContainText('새 버전');
});
