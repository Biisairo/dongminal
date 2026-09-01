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

    ta.value = '';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const d of ['ㅇ', '여', '여ㅈ', '여전', '여전히']) {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
      ta.dispatchEvent(new InputEvent('beforeinput', { data: d, inputType: 'insertCompositionText', isComposing: true, bubbles: true, cancelable: true } as any));
      // 브라우저는 조합 중 textarea 값을 조합 문자열로 갱신한다. xterm 의
      // _finalizeComposition 이 그 값을 잘라 보내므로 재현에 필요하다.
      ta.value = d;
      ta.dispatchEvent(new InputEvent('input', { data: d, inputType: 'insertCompositionText', isComposing: true, bubbles: true, cancelable: true } as any));
    }
    // 스페이스: isComposing=false 로 오지만 compositionend 는 아직이다.
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new InputEvent('beforeinput', { data: ' ', inputType: 'insertText', isComposing: false, bubbles: true, cancelable: true } as any));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '여전히', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
  });
}

test('TC-MTI-28 (FR-MTI-30): 확정 문자는 조합이 닫힌 뒤에 나간다', async ({ page }) => {
  await gotoMobile(page);
  await typeKoreanThenSpace(page);
  const out = (await sent(page)).join('');
  // 조합 문자열은 xterm 이 보낸다. 우리가 보류한 확정 문자는 그 뒤여야 한다.
  // 이전 결함은 " 여전히" — 스페이스가 조합보다 앞섰다.
  expect(out.endsWith(' ')).toBe(true);
  expect(out.startsWith(' ')).toBe(false);
  expect(out).toContain('여전히');
});

test('TC-MTI-29 (FR-MTI-30): 조합 중에는 확정 문자를 보내지 않는다', async ({ page }) => {
  await gotoMobile(page);
  await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    ta.dispatchEvent(new InputEvent('beforeinput', { data: ' ', inputType: 'insertText', isComposing: false, bubbles: true, cancelable: true } as any));
    await new Promise((r) => setTimeout(r, 150));
  });
  // 조합이 아직 열려 있으므로 보류 상태여야 한다.
  expect((await sent(page)).join('')).toBe('');
});

test('TC-MTI-33 (FR-MTI-35): 조합 미리보기가 살아 있다 — 치는 과정이 보인다', async ({ page }) => {
  await gotoMobile(page);
  const view = await page.evaluate(async () => {
    const p = (window as any).app._focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: '가나', bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const v = p.el.querySelector('.composition-view') as HTMLElement | null;
    return { exists: !!v, active: !!v && v.classList.contains('active'), text: v ? v.textContent : null };
  });
  expect(view.exists).toBe(true);
  expect(view.active).toBe(true);
  expect(view.text).toBe('가나');
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

// RELOAD_CONTINUITY_SRS FR-RLC-1·4 로 개정: 새 버전은 배너를 띄우지 않고 **곧바로
// 다시 연다.** 이 스펙이 재는 것은 그 계기(감지)가 모바일에서도 살아 있는가이므로,
// 재는 대상만 배너에서 새로고침으로 옮긴다.
test('TC-MTI-32 (FR-RLC-1·4): 새 버전이 감지되면 배너 없이 다시 뜬다', async ({ page }) => {
  await gotoMobile(page);
  await page.evaluate(() => { (window as any).__alive = 1 });
  // index.html 이 다른 버전을 가리키는 상황을 만든다.
  await page.route('**/?_v=*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<script src="js/core/main.js?v=999999"></script>' }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => !(window as any).__alive, undefined, { timeout: 10000 });
  await expect(page.locator('#ver-banner')).toHaveCount(0);
});
