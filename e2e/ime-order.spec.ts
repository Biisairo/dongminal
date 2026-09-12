/**
 * **조합 중에는 어떤 키도 앞지르지 않는다** — FR-IME-1~5 · FR-IMK-1~3.
 *
 * 접수한 말: *"한글을 치고 엔터를 누르면 마지막 글자 전에 엔터가 들어간다."*
 *
 * 원인은 xterm 의 `CompositionHelper.keydown` 이다 — 조합 중에 다른 키를 보면 그
 * 자리에서 `_finalizeComposition(false)` 로 **아직 낡은** 조각을 내보내고
 * (`_compositionPosition.end` 가 `setTimeout` 으로 갱신되므로 한 글자 뒤진다),
 * 이어서 그 키의 데이터를 보낸다. 수식키가 붙은 경로(`box` 의 keydown 리스너)는
 * 조합 게이트 **밖**이라 같은 일이 한 겹 더 있었다.
 *
 * `TEST-7` 로 `ux-batch6`(묶음 I)·`ux-batch9`(묶음 C)에서 옮겨 왔다 — 납품 묶음이
 * 아니라 **이 기능**이 이 파일의 주제다. 단정은 그대로다.
 */
import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// 전송을 가로채 순서를 본다. 패턴은 ux-batch6.spec.ts 의 것과 같다.
async function termReady(page: Page) {
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 25000 });
  await page.evaluate(() => {
    const p = (window as any).app.testing.focusedTerminal();
    (window as any).__sent = [];
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      if (m[0] === 0) {
        const t = new TextDecoder().decode(m.subarray(1));
        if (t !== '\x1b[I' && t !== '\x1b[O') (window as any).__sent.push(t);
      }
      return orig(m);
    };
    (p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement).focus();
  });
}

const sent = (page: Page) => page.evaluate(() => ((window as any).__sent as string[]).join(''));

// 조합을 열고 한 글자를 만든 뒤, 주어진 키를 누르고 조합을 닫는다.
async function composeThenKey(page: Page, key: string, code: string, mods: Record<string, boolean>) {
  await page.evaluate(async ({ key, code, mods }) => {
    const p = (window as any).app.testing.focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.focus();
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const d of ['ㅎ', '하', '한']) {
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
      ta.value = d;
    }
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key, code, bubbles: true, cancelable: true, ...mods,
    } as any));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
  }, { key, code, mods });
}

test.describe('묶음 C — 조합 중에는 어떤 키도 앞지르지 않는다', () => {
  // TC-IMK-1: 종전에는 `box` 의 keydown 리스너가 조합 게이트 **밖**이라
  // Home(0x01)이 조합 문자보다 먼저 나갔다.
  test('TC-IMK-1: 조합 중 Cmd+← 는 조합 문자 뒤에 나가고 한 번만 나간다', async ({ page }) => {
    await waitForInit(page);
    await termReady(page);
    await composeThenKey(page, 'ArrowLeft', 'ArrowLeft', { metaKey: true });

    const s = await sent(page);
    expect(s, `전송 순서=${JSON.stringify(s)}`).toContain('한');
    expect(s.indexOf('한')).toBeLessThan(s.indexOf('\x01'));
    expect(s.split('\x01').length - 1, '두 번 움직이면 안 된다').toBe(1);
  });

  // TC-IMK-2: Alt+← 도 같은 자리다.
  test('TC-IMK-2: 조합 중 Alt+← 도 조합 문자 뒤에 한 번만 나간다', async ({ page }) => {
    await waitForInit(page);
    await termReady(page);
    await composeThenKey(page, 'ArrowLeft', 'ArrowLeft', { altKey: true });

    const s = await sent(page);
    expect(s).toContain('한');
    expect(s.indexOf('한')).toBeLessThan(s.indexOf('\x1bb'));
    expect(s.split('\x1bb').length - 1).toBe(1);
  });

  // TC-IMK-3: 조합이 없을 때의 동작은 그대로다.
  test('TC-IMK-3: 조합이 없으면 Cmd+←/→ 는 종전대로 즉시 나간다', async ({ page }) => {
    await waitForInit(page);
    await termReady(page);
    await page.evaluate(() => {
      const p = (window as any).app.testing.focusedTerminal();
      const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      for (const key of ['ArrowLeft', 'ArrowRight']) {
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key, code: key, metaKey: true, bubbles: true, cancelable: true,
        } as any));
      }
    });
    await expect.poll(() => sent(page), { timeout: 10000 }).toBe('\x01\x05');
    expect(await sent(page)).toBe('\x01\x05');
  });
});

/**
 * 묶음 I — **조합 중의 Enter** (FR-IME-1~5).
 *
 * 위 묶음 C 가 수식키를, 이쪽이 확정 키를 잰다 — 같은 게이트의 두 입구다.
 * `TEST-7` 로 `ux-batch6` 에서 옮겨 왔다.
 */
test('V-IME-1·3 (FR-IME-1·2·3): 조합 중 Enter 는 조합 문자열 뒤에 나간다', async ({ page }) => {
  await waitForInit(page);
  await termReady(page);
  await page.evaluate(async () => {
    const p = (window as any).app.testing.focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.value = '';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const d of ['ㅇ', '여', '여ㅈ', '여전', '여전히']) {
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
      ta.value = d;
    }
    // 데스크톱 Chrome 은 조합 중 Enter 를 keyCode 13 으로 낸다.
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    } as any));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '여전히', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  });
  const out = await sent(page);
  // 이전 결함은 `여전\r히` 류였다 — 조합의 마지막 글자가 Enter 뒤로 밀렸다.
  expect(out).toContain('여전히');
  expect(out.endsWith('\r'), `순서가 뒤집혔다: ${JSON.stringify(out)}`).toBe(true);
});

test('V-IME-2 (FR-IME-1): IME 가 나르는 키와 수식키는 보류하지 않는다', async ({ page }) => {
  await waitForInit(page);
  await termReady(page);
  const held = await page.evaluate(async () => {
    const p = (window as any).app.testing.focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const kc of [229, 16, 17, 18]) {
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Unidentified', keyCode: kc, which: kc, bubbles: true, cancelable: true,
      } as any));
    }
    await new Promise((r) => setTimeout(r, 50));
    return (p._imeQ || []).length;
  });
  expect(held, '조합을 나르는 키를 붙잡았다 — 조합 자체가 깨진다').toBe(0);
});

// **정리 창** — 접수한 모바일 증상의 자리다. `compositionend` 가 확정 문자보다
// 먼저 와도 xterm 의 전송은 setTimeout 뒤이므로, 그 사이에 보낸 문자는 조합보다
// 앞선다 (" 여전히").
test('V-IME-1 (FR-IME-3): compositionend 뒤에 온 확정 문자도 조합 뒤에 나간다', async ({ page }) => {
  await waitForInit(page);
  await termReady(page);
  await page.evaluate(async () => {
    const p = (window as any).app.testing.focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.value = '';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: '여전히', bubbles: true }));
    ta.value = '여전히';
    // 조합이 먼저 닫히고, 확정 문자가 그 뒤에 온다.
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '여전히', bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true,
    } as any));
    await new Promise((r) => setTimeout(r, 300));
  });
  const out = await sent(page);
  expect(out).toContain('여전히');
  expect(out.startsWith(' '), `확정 문자가 조합보다 앞섰다: ${JSON.stringify(out)}`).toBe(false);
  expect(out.endsWith(' '), `확정 문자가 나가지 않았다: ${JSON.stringify(out)}`).toBe(true);
});

test('V-IME-3 (FR-IME-5): 포커스를 잃어도 보류분은 갇히지 않는다', async ({ page }) => {
  await waitForInit(page);
  await termReady(page);
  await page.evaluate(async () => {
    const p = (window as any).app.testing.focusedTerminal();
    const ta = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    } as any));
    ta.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(await sent(page)).toContain('\r');
});
