import { CDPSession, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// 묶음 C (USER_CHECKLIST_FIXES_SRS §3.3 / §4.3) — 모바일 키바 실기기 터치 경로.
//
// 이 파일은 hasTouch:true 프로젝트(mobile-touch)에서만 돈다. 기존 스펙은
// Desktop Chrome(hasTouch:false)에서 .click() 만 썼기 때문에 touchstart 리스너가
// 아예 발동하지 않았고, 그래서 §2.4 의 결함을 한 번도 보지 못했다.

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'mobile');
  });
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 15000 });
  await page.waitForSelector('#mobile-keybar .mkb-btn', { timeout: 15000 });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 포커스된 터미널의 _send 를 감싸 전송 바이트를 기록한다. 키 전송 여부를
// 터미널 출력으로 추론하는 것보다 결정론적이다.
async function installSendSpy(page: Page) {
  await page.evaluate(() => {
    const app = (window as any).app;
    const p = app._focusedTerminal();
    if (!p) throw new Error('포커스된 터미널이 없다');
    (window as any).__sent = [];
    if ((p as any).__spied) return;
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      (window as any).__sent.push(Array.from(m));
      return orig(m);
    };
    (p as any).__spied = true;
  });
}

const sent = (page: Page) => page.evaluate(() => (window as any).__sent as number[][]);
const clearSent = (page: Page) => page.evaluate(() => { (window as any).__sent = [] });

function keybarBtn(page: Page, label: string) {
  return page.locator('#mobile-keybar .mkb-btn').filter({ hasText: new RegExp(`^${label}$`) });
}

async function centerOf(page: Page, label: string) {
  const box = await keybarBtn(page, label).boundingBox();
  expect(box, `${label} 버튼의 좌표를 얻지 못했다`).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

// CDP 로 터치 시퀀스를 직접 만든다 — 롱프레스 홀드와 스와이프는 tap() 으로
// 표현할 수 없다.
async function touch(client: CDPSession, type: string, pts: Array<{ x: number; y: number }>) {
  await client.send('Input.dispatchTouchEvent', { type, touchPoints: pts } as any);
}

test.describe('FR-MTB-1/2: 짧은 탭이 키를 전송한다', () => {
  test('TC-MTB-1: Esc 짧은 탭 → ESC 1회 전송', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);

    await keybarBtn(page, 'Esc').tap();

    await expect.poll(() => sent(page), { timeout: 3000 }).toEqual([[0, 0x1b]]);
  });

  test('TC-MTB-2: Ctrl 짧은 탭 → sticky 토글', async ({ page }) => {
    await gotoMobile(page);
    const ctrl = page.locator('#mobile-keybar .mkb-btn[data-mod="ctrl"]');
    await ctrl.tap();
    await expect(ctrl).toHaveClass(/sticky/);
    await ctrl.tap();
    await expect(ctrl).not.toHaveClass(/sticky/);
  });

  test('TC-MTB-3: 한 번의 탭이 두 번 발동하지 않는다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);

    await keybarBtn(page, 'Tab').tap();
    // 중복 발동이 있으면 잠깐 뒤에 두 번째가 들어온다.
    await page.waitForTimeout(500);
    expect(await sent(page)).toEqual([[0, 0x09]]);
  });

  test('TC-MTB-3b: 화살표 탭이 CSI 시퀀스를 1회 전송', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);

    await keybarBtn(page, '↑').tap();
    await page.waitForTimeout(400);
    // '\x1b[A' → [OP.INPUT, 0x1b, 0x5b, 0x41]
    expect(await sent(page)).toEqual([[0, 0x1b, 0x5b, 0x41]]);
  });

  test('TC-MTB-4: Ctrl sticky 후 문자 탭이 제어문자로 변환된다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    const ctrl = page.locator('#mobile-keybar .mkb-btn[data-mod="ctrl"]');
    await ctrl.tap();
    await expect(ctrl).toHaveClass(/sticky/);
    await clearSent(page);

    // Ctrl 변환은 0x40~0x7e 만 대상이다 (sendToFocused). '/'(0x2f)·'-'(0x2d) 는
    // 범위 밖이라 원문이 나가는 것이 정상 — 범위 안의 '~'(0x7e) 로 검증한다.
    await keybarBtn(page, '~').tap();
    await page.waitForTimeout(400);
    expect(await sent(page)).toEqual([[0, 0x7e & 0x1f]]);
    // sticky 는 한 번 쓰고 해제된다.
    await expect(ctrl).not.toHaveClass(/sticky/);
  });
});

test.describe('FR-MTB-3: 수평 슬라이드', () => {
  test('TC-MTB-5: 버튼 위에서 시작한 스와이프로 키바가 스크롤된다', async ({ page }) => {
    await gotoMobile(page);

    const overflows = await page.evaluate(() => {
      const bar = document.getElementById('mobile-keybar')!;
      return bar.scrollWidth > bar.clientWidth;
    });
    expect(overflows, '키바가 넘치지 않아 슬라이드를 검증할 수 없다').toBe(true);

    const before = await page.evaluate(() => document.getElementById('mobile-keybar')!.scrollLeft);
    const start = await centerOf(page, 'Esc');

    const client = await page.context().newCDPSession(page);
    await touch(client, 'touchStart', [start]);
    for (let i = 1; i <= 6; i++) {
      await touch(client, 'touchMove', [{ x: start.x - i * 25, y: start.y }]);
    }
    await touch(client, 'touchEnd', []);

    await expect.poll(
      () => page.evaluate(() => document.getElementById('mobile-keybar')!.scrollLeft),
      { timeout: 3000 },
    ).toBeGreaterThan(before);
  });

  test('TC-MTB-5b: 스와이프는 키를 전송하지 않는다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);

    const start = await centerOf(page, 'Esc');
    const client = await page.context().newCDPSession(page);
    await touch(client, 'touchStart', [start]);
    for (let i = 1; i <= 6; i++) {
      await touch(client, 'touchMove', [{ x: start.x - i * 25, y: start.y }]);
    }
    await touch(client, 'touchEnd', []);
    await page.waitForTimeout(500);

    expect(await sent(page)).toEqual([]);
  });
});

test.describe('FR-MTB-4/5: 롱프레스', () => {
  test('TC-MTB-6: 700ms 홀드는 툴팁을 띄우고 키를 전송하지 않는다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);
    await clearSent(page);

    const pt = await centerOf(page, '↑');
    const client = await page.context().newCDPSession(page);
    await touch(client, 'touchStart', [pt]);
    await page.waitForSelector('#mkb-tip', { timeout: 3000 });
    await expect(page.locator('#mkb-tip')).toHaveText('Arrow Up');
    await touch(client, 'touchEnd', []);

    await expect(page.locator('#mkb-tip')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await sent(page)).toEqual([]);

    const mod = await page.evaluate(() => (window as any).app._modKbd);
    expect(mod).toEqual({ ctrl: false, alt: false });
  });

  test('TC-MTB-7: 임계값 미만의 떨림은 롱프레스를 취소하지 않는다', async ({ page }) => {
    await gotoMobile(page);

    const pt = await centerOf(page, '↑');
    const client = await page.context().newCDPSession(page);
    await touch(client, 'touchStart', [pt]);
    // 손떨림 수준(3px)의 이동.
    await touch(client, 'touchMove', [{ x: pt.x + 2, y: pt.y + 1 }]);
    await touch(client, 'touchMove', [{ x: pt.x + 3, y: pt.y - 1 }]);

    await page.waitForSelector('#mkb-tip', { timeout: 3000 });
    await touch(client, 'touchEnd', []);
    await expect(page.locator('#mkb-tip')).toHaveCount(0);
  });
});

test.describe('FR-MTB-6: 포커스 가드', () => {
  test('TC-MTB-8: 터치로 키를 보낸 뒤에도 터미널이 포커스를 유지한다', async ({ page }) => {
    await gotoMobile(page);
    await installSendSpy(page);

    await keybarBtn(page, 'Esc').tap();
    await page.waitForTimeout(300);

    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { cls: el?.className || '', tag: el?.tagName || '' };
    });
    expect(active.cls, `활성 요소가 터미널이 아니다 (${active.tag}.${active.cls})`)
      .toContain('xterm-helper-textarea');
  });
});
