import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

const MOBILE_VIEWPORT = { width: 375, height: 667 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'mobile');
  });
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 10000 });
}

async function gotoDesktop(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto('/');
  await page.waitForSelector('#area', { timeout: 10000 });
}

test.describe('Mobile keybar visibility (SRS REQ-F-1..F-4)', () => {
  test('TC-1: keybar is visible immediately after mobile-mode entry without any input', async ({ page }) => {
    await gotoMobile(page);

    const keybar = page.locator('#mobile-keybar');
    await expect(keybar).toBeVisible();

    const box = await keybar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(0);

    const display = await keybar.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('flex');

    // keyboard-up class must NOT be a precondition for visibility.
    const hasKeyboardUp = await page.evaluate(() => document.body.classList.contains('keyboard-up'));
    expect(hasKeyboardUp).toBe(false);
  });

  test('TC-2: keybar is visible when displayMode=mobile is forced on a desktop-sized viewport', async ({ page }) => {
    await page.context().addInitScript(() => {
      sessionStorage.setItem('displayMode', 'mobile');
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/');
    await page.waitForSelector('body.mobile', { timeout: 10000 });

    await expect(page.locator('#mobile-keybar')).toBeVisible();
  });

  test('TC-3: keybar is hidden in desktop mode', async ({ page }) => {
    await gotoDesktop(page);

    const keybar = page.locator('#mobile-keybar');
    const display = await keybar.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('none');

    const offsetParent = await keybar.evaluate((el) => (el as HTMLElement).offsetParent);
    expect(offsetParent).toBeNull();
  });

  test('TC-5: keybar appears after dynamic resize from desktop to mobile viewport', async ({ page }) => {
    await page.context().addInitScript(() => {
      sessionStorage.setItem('displayMode', 'auto');
      sessionStorage.setItem('mobileBreakpoint', '768');
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/');
    await page.waitForSelector('#area', { timeout: 10000 });

    await expect(page.locator('#mobile-keybar')).toBeHidden();

    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.waitForSelector('body.mobile', { timeout: 5000 });

    await expect(page.locator('#mobile-keybar')).toBeVisible();
  });

  test('TC-6: terminal/status-bar area does not overlap the keybar', async ({ page }) => {
    await gotoMobile(page);
    await page.waitForSelector('#area', { timeout: 10000 });

    const keybarBox = await page.locator('#mobile-keybar').boundingBox();
    expect(keybarBox).not.toBeNull();

    const contentBox = await page.locator('#content').boundingBox();
    expect(contentBox).not.toBeNull();

    const contentBottom = contentBox!.y + contentBox!.height;
    expect(contentBottom).toBeLessThanOrEqual(keybarBox!.y + 1);
  });
});

// 묶음 F — 모바일 키보드 뷰포트 (SRS §3.6 FR-MKV-*, §4.6 TC-MKV-*)
//
// 시뮬레이션 규약: vv.height 와 vv.offsetTop 을 **함께** 스텁한다 (FR-MKV-10).
// 이전 하네스는 offsetTop 을 0 으로 고정했고, 그래서 §2.8c 의 결손 — iOS 가 visual
// viewport 를 스크롤하는데 아무도 상쇄하지 않는 것 — 을 원리적으로 관측할 수 없었다.
// hasTouch:false 에서 touchstart 를 못 보던 것과 같은 구조다.
//
// 기준 수치 (MOBILE_VIEWPORT 375×667, 키보드 300px, 스크롤 120px):
//   vv.height = 367 · offsetTop = 120 · 가시 영역 = [120, 487]
//   kbH = 667-367-120 = 180 · padBottom = 180+38 = 218 · padTop = 120
//   #app = [120, 449] · 키바 = [449, 487]  → 틈도 겹침도 없다
test.describe('묶음 F — 모바일 키보드 뷰포트 (FR-MKV-*)', () => {
  const KB = 300;
  const SCROLL = 120;
  const KEYBAR = 38;
  const kbH = MOBILE_VIEWPORT.height - (MOBILE_VIEWPORT.height - KB) - SCROLL; // 180

  // simulateKeyboard 는 vv.height 와 vv.offsetTop 을 함께 세운다. innerHeight 를
  // 건드리지 않는 것이 WebKit 재현의 핵심이다 — layout viewport 는 줄지 않는다.
  async function simulateKeyboard(page: Page, opts: { kb: number; offsetTop: number; event?: 'resize' | 'scroll' }) {
    await page.evaluate(({ kb, offsetTop, event }) => {
      const vv = window.visualViewport!;
      const base = (window as any).__vvBase ?? (((window as any).__vvBase = vv.height));
      Object.defineProperty(vv, 'height', { get: () => base - kb, configurable: true });
      Object.defineProperty(vv, 'offsetTop', { get: () => offsetTop, configurable: true });
      vv.dispatchEvent(new Event(event || 'resize'));
    }, { kb: opts.kb, offsetTop: opts.offsetTop, event: opts.event || 'resize' });
  }

  async function restoreViewport(page: Page) {
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      delete (vv as unknown as Record<string, unknown>).height;
      delete (vv as unknown as Record<string, unknown>).offsetTop;
      vv.dispatchEvent(new Event('resize'));
    });
  }

  const pads = (page: Page) => page.evaluate(() => ({
    top: getComputedStyle(document.body).paddingTop,
    bottom: getComputedStyle(document.body).paddingBottom,
    inlineTop: document.body.style.paddingTop,
    inlineBottom: document.body.style.paddingBottom,
    up: document.body.classList.contains('keyboard-up'),
  }));

  const box = (page: Page, sel: string) => page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
  }, sel);

  test('TC-MKV-1: 스크롤된 visual viewport 를 padding-top 으로 상쇄한다 (FR-MKV-4)', async ({ page }) => {
    await gotoMobile(page);
    await simulateKeyboard(page, { kb: KB, offsetTop: SCROLL });

    expect((await pads(page)).top).toBe(`${SCROLL}px`);
  });

  test('TC-MKV-2: offsetTop 이 0 으로 돌아오면 padding-top 도 0 이다 (FR-MKV-4)', async ({ page }) => {
    await gotoMobile(page);
    await simulateKeyboard(page, { kb: KB, offsetTop: SCROLL });
    await simulateKeyboard(page, { kb: KB, offsetTop: 0, event: 'scroll' });

    expect((await pads(page)).top).toBe('0px');
  });

  test('TC-MKV-3: 키보드 해제 시 padding 이 기본값으로 복원된다 (FR-MKV-4)', async ({ page }) => {
    await gotoMobile(page);
    await simulateKeyboard(page, { kb: KB, offsetTop: SCROLL });
    await restoreViewport(page);

    const p = await pads(page);
    expect(p.top).toBe('0px');
    expect(p.bottom).toBe(`${KEYBAR}px`);
    expect(p.up).toBe(false);
  });

  test('TC-MKV-4: offsetTop 은 padding-bottom 계산을 바꾸지 않는다 (FR-MKV-5)', async ({ page }) => {
    await gotoMobile(page);
    await simulateKeyboard(page, { kb: KB, offsetTop: SCROLL });

    // kbH 는 이미 offsetTop 을 뺀 값이다. padding-bottom 은 kbH + 키바 높이 그대로다.
    expect((await pads(page)).bottom).toBe(`${kbH + KEYBAR}px`);
  });

  test('TC-MKV-5: topbar 가 가시 영역 안에 남는다 (FR-MKV-4)', async ({ page }) => {
    await gotoMobile(page);
    await simulateKeyboard(page, { kb: KB, offsetTop: SCROLL });

    const topbar = await box(page, '#topbar');
    expect(topbar).not.toBeNull();
    // 보정 전에는 topbar 가 [0,32] 라 가시 영역([120,487]) 밖이었다.
    expect(topbar!.top).toBeGreaterThanOrEqual(SCROLL);
    expect(topbar!.bottom).toBeLessThanOrEqual(SCROLL + (MOBILE_VIEWPORT.height - KB));
  });

  test('TC-MKV-6: 키바가 #app 하단과 맞물리고 가시 영역 하단에 닿는다 (FR-MKV-5)', async ({ page }) => {
    await gotoMobile(page);
    await simulateKeyboard(page, { kb: KB, offsetTop: SCROLL });

    const app = await box(page, '#app');
    const keybar = await box(page, '#mobile-keybar');
    expect(app).not.toBeNull();
    expect(keybar).not.toBeNull();
    expect(keybar!.top).toBe(app!.bottom);                                    // 틈·겹침 0
    expect(keybar!.bottom).toBe(SCROLL + (MOBILE_VIEWPORT.height - KB));      // 가시 영역 하단
  });

  test('TC-MKV-7: 줄어드는 것은 #area 뿐이다 (FR-MKV-8)', async ({ page }) => {
    await gotoMobile(page);
    const before = { topbar: await box(page, '#topbar'), sb: await box(page, '.status-bar'), area: await box(page, '#area') };
    await simulateKeyboard(page, { kb: KB, offsetTop: SCROLL });
    const after = { topbar: await box(page, '#topbar'), sb: await box(page, '.status-bar'), area: await box(page, '#area') };

    expect(after.topbar!.h).toBe(before.topbar!.h);
    expect(after.sb!.h).toBe(before.sb!.h);
    expect(after.area!.h).toBeLessThan(before.area!.h);
  });

  test('TC-MKV-8: resize 없이 scroll 만 와도 offsetTop 을 따라간다 (FR-MKV-6)', async ({ page }) => {
    await gotoMobile(page);
    await simulateKeyboard(page, { kb: KB, offsetTop: 0 });
    await simulateKeyboard(page, { kb: KB, offsetTop: 60, event: 'scroll' });

    expect((await pads(page)).top).toBe('60px');
  });

  test('TC-MKV-9: viewport meta 가 interactive-widget=resizes-content 를 선언한다 (FR-MKV-2)', async ({ page }) => {
    await page.goto('/');
    const content = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(content).not.toBeNull();
    const flat = content!.replace(/\s/g, '');
    expect(flat).toContain('interactive-widget=resizes-content');
    expect(flat).toContain('viewport-fit=cover');   // 기존 선언 유지 (REQ-B-2)
  });

  test('TC-MKV-10: layout viewport 가 함께 줄면 JS 경로가 비활성이다 (FR-MKV-3)', async ({ page }) => {
    await gotoMobile(page);
    // resizes-content 환경 재현: Chromium 은 innerHeight 까지 줄인다 → kbH ≈ 0.
    await page.evaluate((kb) => {
      const vv = window.visualViewport!;
      const baseInner = window.innerHeight;
      const baseVV = vv.height;
      Object.defineProperty(window, 'innerHeight', { get: () => baseInner - kb, configurable: true });
      Object.defineProperty(vv, 'height', { get: () => baseVV - kb, configurable: true });
      Object.defineProperty(vv, 'offsetTop', { get: () => 0, configurable: true });
      vv.dispatchEvent(new Event('resize'));
    }, KB);

    const p = await pads(page);
    expect(p.up).toBe(false);
    expect(p.inlineTop).toBe('');
    expect(p.inlineBottom).toBe('');
  });

  test('TC-MKV-11: #area 축소 후 터미널 rows 가 재계산된다 (FR-MKV-9)', async ({ page }) => {
    await gotoMobile(page);
    await page.waitForSelector('#area .pn .xterm-helper-textarea', { timeout: 15000 });

    const rows = () => page.evaluate(() => {
      const app = (window as any).app;
      const vis = [...app.tools.values()].find((p: any) => p.el.classList.contains('vis'));
      return vis?.term?.rows ?? null;
    });
    const before = await rows();
    expect(before).not.toBeNull();

    await simulateKeyboard(page, { kb: KB, offsetTop: SCROLL });
    await expect.poll(rows, { timeout: 5000 }).toBeLessThan(before!);
  });

  test('TC-MKV-12: 데스크톱 경로는 영향받지 않는다 (회귀)', async ({ page }) => {
    await gotoDesktop(page);

    const p = await pads(page);
    expect(p.inlineTop).toBe('');
    expect(p.inlineBottom).toBe('');
    expect(p.up).toBe(false);

    const app = await box(page, '#app');
    const inner = await page.evaluate(() => window.innerHeight);
    expect(app!.h).toBe(inner);
  });

  test('TC-B2: CSS 변수 --m-kb-h 가 키바 높이와 일치한다', async ({ page }) => {
    await gotoMobile(page);
    const varValue = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--m-kb-h').trim(),
    );
    expect(varValue).toBe(`${KEYBAR}px`);

    const keybarH = await page.locator('#mobile-keybar').evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(Math.round(keybarH)).toBe(KEYBAR);
  });
});

test.describe('Mobile RFC §7.2 verification automation (SRS REQ-D1..D4)', () => {
  test('TC-D1: Ctrl/Alt modifier sticky/lock toggle classes', async ({ page }) => {
    await gotoMobile(page);
    const ctrl = page.locator('#mobile-keybar .mkb-btn[data-mod="ctrl"]');
    await expect(ctrl).toHaveCount(1);

    // 1st tap → sticky
    await ctrl.click();
    await expect(ctrl).toHaveClass(/sticky/);
    await expect(ctrl).not.toHaveClass(/locked/);

    // 2nd tap within 350ms → lock (note: first click toggled sticky on; second click within window flips to lock)
    await ctrl.click({ delay: 0 });
    await expect(ctrl).toHaveClass(/locked/);

    // 3rd tap → back to off (lock → false per app.js:2244)
    await ctrl.click();
    await expect(ctrl).not.toHaveClass(/sticky/);
    await expect(ctrl).not.toHaveClass(/locked/);
  });

  test('TC-D2: keybar button mousedown is preventDefault (focus guard)', async ({ page }) => {
    await gotoMobile(page);

    // REQ-D2 의 구현은 app.js 의 `b.addEventListener('mousedown',e=>e.preventDefault())`
    // 다. 이 요구를 "문서 포커스가 유지되는가" 로 관측하면 앱의 비동기 포커스
    // 복원(터미널 helper textarea 로 되돌리는 경로)과 경합해 불안정하다.
    // 요구 그대로 — mousedown 의 defaultPrevented — 를 직접 관측한다.
    const prevented = await page.evaluate(async () => {
      const btn = [...document.querySelectorAll('#mobile-keybar .mkb-btn')]
        .find((b) => (b.textContent || '').trim() === 'Tab') as HTMLElement | undefined;
      if (!btn) return null;
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      btn.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented, 'Tab 키바 버튼을 찾지 못했다').not.toBeNull();
    expect(prevented, 'mousedown 이 preventDefault 되지 않아 포커스를 빼앗는다').toBe(true);
  });

  test('TC-D3: single-pane session shows 1/1 indicator', async ({ page }) => {
    await gotoMobile(page);
    const indicator = page.locator('#m-pane-indicator');
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveText('1/1');
  });

  test('TC-D4: split controls and split handles are hidden in mobile mode', async ({ page }) => {
    await gotoMobile(page);

    const splitH = page.locator('#split-h');
    const splitV = page.locator('#split-v');
    await expect(splitH).toBeHidden();
    await expect(splitV).toBeHidden();

    // Split handles (.sh) may not exist when there is no split, but if present must be hidden.
    const handles = page.locator('.sh');
    const handleCount = await handles.count();
    for (let i = 0; i < handleCount; i++) {
      await expect(handles.nth(i)).toBeHidden();
    }
  });
});

test.describe('Mobile keybar tooltips (SRS REQ-T-1..T-4)', () => {
  const FULL_NAMES: Record<string, string> = {
    Esc: 'Escape',
    Tab: 'Tab',
    Ctrl: 'Control (modifier)',
    Alt: 'Alt (modifier)',
    '↑': 'Arrow Up',
    '↓': 'Arrow Down',
    '←': 'Arrow Left',
    '→': 'Arrow Right',
    '|': 'Pipe',
    '~': 'Tilde',
    '/': 'Slash',
    '-': 'Hyphen',
    Home: 'Home',
    End: 'End',
    PgUp: 'Page Up',
    PgDn: 'Page Down',
  };

  test('TC-T1: every key button has matching title and aria-label', async ({ page }) => {
    await gotoMobile(page);
    const buttons = page.locator('#mobile-keybar .mkb-btn');
    const count = await buttons.count();
    expect(count).toBe(Object.keys(FULL_NAMES).length);

    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      const label = (await btn.textContent())?.trim() ?? '';
      const expected = FULL_NAMES[label];
      expect(expected, `unexpected label: ${label}`).toBeDefined();
      await expect(btn).toHaveAttribute('title', expected);
      await expect(btn).toHaveAttribute('aria-label', expected);
    }
  });

  test('TC-T2/T3: long-press shows popup and cancels key dispatch', async ({ page }) => {
    await gotoMobile(page);
    const upBtn = page.locator('#mobile-keybar .mkb-btn', { hasText: /^↑$/ });
    const box = await upBtn.boundingBox();
    expect(box).not.toBeNull();

    // Simulate touch hold 700ms via CDP touchscreen.
    const client = await page.context().newCDPSession(page);
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    await page.waitForSelector("#mkb-tip", { timeout: 2000 });

    const tip = page.locator('#mkb-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText('Arrow Up');

    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });

    await expect(tip).toHaveCount(0);

    // REQ-T-3: no modifier change after a cancelled long-press
    const modState = await page.evaluate(() => {
      const w = window as unknown as { App?: { _modKbd?: { ctrl: boolean; alt: boolean } } };
      return w.App?._modKbd ?? null;
    });
    if (modState) {
      expect(modState.ctrl).toBe(false);
      expect(modState.alt).toBe(false);
    }
  });

  test('TC-T4: short tap still dispatches the key (no regression)', async ({ page }) => {
    await gotoMobile(page);
    const ctrl = page.locator('#mobile-keybar .mkb-btn[data-mod="ctrl"]');

    // Plain click (short) — must toggle sticky state, proving dispatch path still active.
    await ctrl.click();
    await expect(ctrl).toHaveClass(/sticky/);

    // Ensure no leftover tip element.
    await expect(page.locator('#mkb-tip')).toHaveCount(0);
  });
});
