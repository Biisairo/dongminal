import { Page } from '@playwright/test';

import { test, expect, waitSettled, waitForInit } from './fixtures';

/**
 * ALERT_MOBILE_CONTEXT_SRS §3.2 — 모바일 키보드 게이트 (FR-MKB-1~15).
 *
 * 접수한 말: **"⌨ 눌렀을때만 키보드가 올라오게 하고, ⌨ 를 맨 왼쪽으로, ^C 도
 * 추가해줘."** 셋이 한 문장인 데는 이유가 있다 — 소프트 키보드를 올리지 않기로
 * 하면 `Ctrl` 을 켠 뒤 `c` 를 칠 자리가 사라지고, 그때 `Ctrl+C` 를 낼 방법이
 * 아예 없어진다.
 *
 * 검증 V-7 ~ V-11.
 */

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'mobile') });
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 15000 });
  await waitSettled(page);
  await page.waitForSelector('#mobile-keybar .mkb-btn', { timeout: 15000 });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

const ta = (page: Page) => page.locator('#area .pn.focused .xterm-helper-textarea');
const kbBtn = (page: Page) => page.locator('#mobile-keybar .mkb-btn[data-act="kb"]');
const inputmode = (page: Page) => page.evaluate(() => {
  const p = (window as any).app._focusedTerminal();
  const el = p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
  return el.getAttribute('inputmode');
});

// 도구가 실제로 받은 바이트를 센다. 포커스 보고(CSI I·O)는 사용자가 보낸 키가
// 아니다 — 창이 포커스를 얻고 잃을 때 터미널이 스스로 낸다.
async function captureSends(page: Page) {
  await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    (window as any).__sent = [] as string[];
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      if (m[0] === 0) {
        const t = new TextDecoder().decode(m.subarray(1));
        if (t !== '\x1b[I' && t !== '\x1b[O') (window as any).__sent.push(t);
      }
      return orig(m);
    };
  });
}
const sent = (page: Page) => page.evaluate(() => (window as any).__sent as string[]);

test.describe('묶음 MKB — 키보드 게이트 (FR-MKB-1~7)', () => {
  /**
   * FR-MKB-1·2: 터치해도 소프트 키보드가 올라오지 않는다. **포커스는 그대로
   * 준다** — 막는 것이 포커스이면 물리 키보드·선택·붙여넣기·키바 전송이 함께
   * 죽는다.
   */
  test('MKB1 (V-7): 터미널을 탭해도 inputmode 가 none 이고, 포커스는 있다', async ({ page }) => {
    await gotoMobile(page);
    await ta(page).click({ force: true });
    expect(await inputmode(page)).toBe('none');
    const focused = await page.evaluate(() =>
      (document.activeElement as HTMLElement)?.className || '');
    expect(focused).toContain('xterm-helper-textarea');
  });

  // FR-MKB-4·5: 버튼 하나가 두 방향을 갖는다.
  test('MKB2 (V-8): `⌨` 가 풀고, 다시 누르면 되돌린다', async ({ page }) => {
    await gotoMobile(page);
    expect(await inputmode(page)).toBe('none');

    await kbBtn(page).click();
    expect(await inputmode(page), '`⌨` 가 풀지 않았다').toBe(null);

    await kbBtn(page).click();
    expect(await inputmode(page), '`⌨` 가 되돌리지 않았다').toBe('none');
  });

  // FR-MKB-6: 두 방향을 가진 버튼은 지금 어느 쪽인지 보여야 한다.
  test('MKB3 (FR-MKB-6): 현재 방향이 버튼에 보인다', async ({ page }) => {
    await gotoMobile(page);
    await expect(kbBtn(page)).not.toHaveClass(/sticky/);
    await kbBtn(page).click();
    await expect(kbBtn(page)).toHaveClass(/sticky/);
    await kbBtn(page).click();
    await expect(kbBtn(page)).not.toHaveClass(/sticky/);
  });

  /**
   * FR-MKB-7 / D-11: 키보드가 내려가면 되돌린다. 되돌리지 않으면 그 뒤로 터치마다
   * 키보드가 올라오고, 그것이 정확히 ③ 이 없애려던 동작이다.
   *
   * 실기기의 `visualViewport` 는 e2e 에서 흉내낼 수 없으므로 그 함수가 딛는
   * **전이**를 직접 만든다 — `keyboard-up` 이 참인 상태에서 거짓이 되는 순간이다.
   */
  test('MKB4 (V-8): 키보드가 내려가면 inputmode 가 none 으로 돌아온다', async ({ page }) => {
    await gotoMobile(page);
    await kbBtn(page).click();
    expect(await inputmode(page)).toBe(null);

    await page.evaluate(() => {
      document.body.classList.add('keyboard-up');
      (window as any).app._mKbH = null;   // 잡음 게이트를 지나가게 한다
      (window as any).app._mobileVvApply();
    });
    expect(await inputmode(page), '내려갔는데 풀린 채로 남았다').toBe('none');
  });

  // FR-MKB-14: 이 규칙은 터미널의 것이다. 다른 입력은 종전대로 키보드를 올린다.
  test('MKB5 (FR-MKB-14): 터미널이 아닌 입력에는 닿지 않는다', async ({ page }) => {
    await gotoMobile(page);
    const modes = await page.evaluate(() =>
      [...document.querySelectorAll('input,textarea')]
        .filter(e => !e.classList.contains('xterm-helper-textarea'))
        .map(e => e.getAttribute('inputmode')));
    expect(modes.every(m => m !== 'none'), '터미널 밖 입력이 막혔다').toBe(true);
  });
});

test.describe('묶음 MKB — 키 배열과 `^C` (FR-MKB-8~12)', () => {
  // FR-MKB-8·9: 자리가 요구의 절반이다 — 맨 왼쪽과 `Ctrl` 옆.
  test('MKB6 (V-9): `⌨` 가 첫 버튼이고 `^C` 가 `Ctrl` 다음이다', async ({ page }) => {
    await gotoMobile(page);
    const labels = await page.locator('#mobile-keybar .mkb-btn')
      .evaluateAll(els => els.map(e => (e.textContent || '').trim()));
    expect(labels[0]).toBe('⌨');
    expect(labels[labels.indexOf('Ctrl') + 1]).toBe('^C');
  });

  /**
   * FR-MKB-10 / D-12: 모디파이어를 거치지 않는다. 중단은 급할 때 누르는 것이고,
   * 두 번 눌러야 하는 중단은 중단이 아니다.
   */
  test('MKB7 (V-10): `^C` 가 곧바로 0x03 을 보내고 sticky 를 건드리지 않는다', async ({ page }) => {
    await gotoMobile(page);
    await captureSends(page);
    const ctrl = page.locator('#mobile-keybar .mkb-btn[data-mod="ctrl"]');
    await expect(ctrl).not.toHaveClass(/sticky/);

    await page.locator('#mobile-keybar .mkb-btn').filter({ hasText: /^\^C$/ }).click();
    await page.waitForTimeout(150);

    expect(await sent(page), '0x03 이 오지 않았다').toContain('\x03');
    await expect(ctrl, '`^C` 가 sticky 를 건드렸다').not.toHaveClass(/sticky/);
  });

  // FR-MKB-10 의 나머지 절반: `Ctrl` 이 켜져 있어도 그 상태를 읽지도 바꾸지도 않는다.
  test('MKB8 (V-10): `Ctrl` 이 켜져 있어도 `^C` 는 0x03 하나만 보낸다', async ({ page }) => {
    await gotoMobile(page);
    const ctrl = page.locator('#mobile-keybar .mkb-btn[data-mod="ctrl"]');
    await ctrl.click();
    await expect(ctrl).toHaveClass(/sticky/);
    await captureSends(page);

    await page.locator('#mobile-keybar .mkb-btn').filter({ hasText: /^\^C$/ }).click();
    await page.waitForTimeout(150);

    expect(await sent(page)).toEqual(['\x03']);
    await expect(ctrl, 'sticky 가 소모됐다').toHaveClass(/sticky/);
  });
});

test.describe('묶음 MKB — 데스크톱 (FR-MKB-13)', () => {
  test('MKB9 (V-11): 데스크톱에서는 inputmode 를 걸지 않는다', async ({ page }) => {
    await waitForInit(page);
    const mode = await page.evaluate(() => {
      const el = document.querySelector('#area .pn.focused .xterm-helper-textarea');
      return el ? el.getAttribute('inputmode') : 'no-textarea';
    });
    expect(mode).toBe(null);
  });
});
