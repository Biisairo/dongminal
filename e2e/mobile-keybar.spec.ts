import { test, expect, Page } from '@playwright/test';

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

test.describe('Mobile keybar layout robustness (SRS REQ-A-1..B-2)', () => {
  async function stubVisualViewportHeight(page: Page, deltaPx: number) {
    await page.evaluate((delta) => {
      const vv = window.visualViewport!;
      const origHeight = vv.height;
      Object.defineProperty(vv, 'height', { get: () => origHeight - delta, configurable: true });
      Object.defineProperty(vv, 'offsetTop', { get: () => 0, configurable: true });
      vv.dispatchEvent(new Event('resize'));
    }, deltaPx);
  }

  async function restoreVisualViewport(page: Page) {
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      // re-assign default-like getters by deleting overrides
      delete (vv as unknown as Record<string, unknown>).height;
      delete (vv as unknown as Record<string, unknown>).offsetTop;
      vv.dispatchEvent(new Event('resize'));
    });
  }

  test('TC-A1+A3: keyboard up expands body padding and shifts keybar bottom', async ({ page }) => {
    await gotoMobile(page);
    await stubVisualViewportHeight(page, 300);

    const paddingBottomPx = await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom));
    expect(paddingBottomPx).toBeGreaterThanOrEqual(38 + 300);

    const keybarBottom = await page.locator('#mobile-keybar').evaluate((el) => (el as HTMLElement).style.bottom);
    expect(keybarBottom).toBe('300px');

    const keyboardUp = await page.evaluate(() => document.body.classList.contains('keyboard-up'));
    expect(keyboardUp).toBe(true);
  });

  test('TC-A2: keyboard down restores default padding', async ({ page }) => {
    await gotoMobile(page);
    const paddingBottomPx = await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom));
    expect(paddingBottomPx).toBe(38);
  });

  test('TC-A4: keyboard up then down restores layout', async ({ page }) => {
    await gotoMobile(page);
    await stubVisualViewportHeight(page, 300);
    await restoreVisualViewport(page);

    const paddingBottomPx = await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom));
    expect(paddingBottomPx).toBe(38);

    const keybarBottom = await page.locator('#mobile-keybar').evaluate((el) => (el as HTMLElement).style.bottom);
    expect(keybarBottom === '' || keybarBottom === '0px').toBe(true);

    const keyboardUp = await page.evaluate(() => document.body.classList.contains('keyboard-up'));
    expect(keyboardUp).toBe(false);
  });

  test('TC-B1: viewport meta declares viewport-fit=cover', async ({ page }) => {
    await page.goto('/');
    const content = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(content).not.toBeNull();
    expect(content!.replace(/\s/g, '')).toContain('viewport-fit=cover');
  });

  test('TC-B2: CSS variable --m-kb-h is exposed and equals keybar height', async ({ page }) => {
    await gotoMobile(page);
    const varValue = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--m-kb-h').trim(),
    );
    expect(varValue).toBe('38px');

    const keybarH = await page.locator('#mobile-keybar').evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(Math.round(keybarH)).toBe(38);
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

    // Use a probe input to isolate from workspace state pollution between spec files.
    // The behavior under test is mousedown preventDefault — independent of which element is focused.
    await page.evaluate(() => {
      const inp = document.createElement('input');
      inp.id = 'tc-d2-probe';
      inp.type = 'text';
      inp.style.position = 'fixed';
      inp.style.top = '0';
      inp.style.left = '0';
      document.body.appendChild(inp);
      inp.focus();
    });
    await expect(page.locator('#tc-d2-probe')).toBeFocused();

    // Click a non-modifier keybar button — should NOT steal focus.
    await page.locator('#mobile-keybar .mkb-btn', { hasText: /^Tab$/ }).click();
    await expect(page.locator('#tc-d2-probe')).toBeFocused();

    await page.evaluate(() => document.getElementById('tc-d2-probe')?.remove());
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
    await page.waitForTimeout(700);

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
