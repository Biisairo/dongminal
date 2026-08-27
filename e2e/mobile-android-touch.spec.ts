import { CDPSession, Page } from '@playwright/test';
import { test, expect } from './fixtures';

// MOBILE_TUI_INPUT_SCROLL_SRS §6 — Android Chrome 실기기 사슬의 교정.

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'mobile') });
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 15000 });
  await page.waitForSelector('#mobile-keybar .mkb-btn', { timeout: 15000 });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
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

// 하단으로부터의 거리 — rows 가 바뀌어도 이것이 보존되어야 한다.
async function distFromBottom(page: Page) {
  return await page.evaluate(() => {
    const p = (window as any).app._focusedTerminal();
    const b = p.term.buffer.active;
    return { dist: b.baseY - b.viewportY, rows: p.term.rows };
  });
}

async function screenCenter(page: Page) {
  const box = await page.locator('#area .pn.focused .xterm-screen').boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
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

test.describe('FR-MTI-20: window resize 의 fit 병합', () => {
  test('TC-MTI-15: window resize 다수가 프레임당 fit 1회로 병합된다', async ({ page }) => {
    await gotoMobile(page);
    const n = await page.evaluate(async () => {
      const app = (window as any).app;
      let fits = 0;
      for (const p of app.tools.values()) {
        if (!p.el.classList.contains('vis')) continue;
        const orig = p.doFit.bind(p);
        p.doFit = () => { fits++; return orig() };
      }
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('resize'));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return fits;
    });
    expect(n).toBe(1);
  });
});

test.describe('FR-MTI-21: 리사이즈가 스크롤 위치를 유지한다', () => {
  test('TC-MTI-16: 하단에서 40행 위를 보던 상태가 rows 변화 후에도 유지된다', async ({ page }) => {
    await gotoMobile(page);
    await fill(page);
    await page.evaluate(() => { (window as any).app._focusedTerminal().term.scrollLines(-40) });
    await page.waitForTimeout(200);
    const before = await distFromBottom(page);
    expect(before.dist).toBe(40);

    // 키보드 등장과 같은 경로: 뷰포트 축소 → window resize → fit
    await page.setViewportSize({ width: 412, height: 460 });
    await page.waitForTimeout(500);
    const after = await distFromBottom(page);
    expect(after.rows).not.toBe(before.rows);   // rows 가 실제로 바뀌었는지
    expect(after.dist).toBe(40);
  });

  test('TC-MTI-17: 하단에 있었으면 리사이즈 후에도 하단이다', async ({ page }) => {
    await gotoMobile(page);
    await fill(page);
    await page.evaluate(() => { (window as any).app._focusedTerminal().term.scrollToBottom() });
    await page.waitForTimeout(200);
    expect((await distFromBottom(page)).dist).toBe(0);
    await page.setViewportSize({ width: 412, height: 460 });
    await page.waitForTimeout(500);
    expect((await distFromBottom(page)).dist).toBe(0);
  });
});

test.describe('FR-MTI-22/24: 스크롤 제스처가 키보드를 부르지 않는다', () => {
  test('TC-MTI-18: 스크롤 제스처 후 helper textarea 가 focus 가 아니다', async ({ page }) => {
    await gotoMobile(page);
    await fill(page);
    await page.evaluate(() => {
      const p = (window as any).app._focusedTerminal();
      (p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement).focus();
    });
    expect(await page.evaluate(() => document.activeElement?.className || '')).toContain('xterm-helper-textarea');

    const client = await page.context().newCDPSession(page);
    await touchDrag(client, await screenCenter(page), 200);
    await page.waitForTimeout(300);
    const cls = await page.evaluate(() => document.activeElement?.className || '');
    expect(cls).not.toContain('xterm-helper-textarea');
  });

  test('TC-MTI-22: 모바일에서 터미널 영역의 touch-action 이 none 이다', async ({ page }) => {
    await gotoMobile(page);
    const ta = await page.locator('#area .pn.focused .tp').first()
      .evaluate((el) => getComputedStyle(el).touchAction);
    expect(ta).toBe('none');
  });
});

test.describe('FR-MTI-25: 터미널 탭이 키보드를 올리는 유일한 경로다', () => {
  test('TC-MTI-20: pane 을 탭하면 helper textarea 가 focus 된다', async ({ page }) => {
    await gotoMobile(page);
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    expect(await page.evaluate(() => document.activeElement?.className || '')).not.toContain('xterm-helper-textarea');
    await page.locator('#area .pn.focused').first().dispatchEvent('mousedown');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement?.className || '')).toContain('xterm-helper-textarea');
  });
});

test.describe('FR-MTI-25: 자동 focus 억제', () => {
  test('TC-MTI-23: 모바일 첫 로드에서 helper textarea 가 focus 되지 않는다', async ({ page }) => {
    await gotoMobile(page);
    await page.waitForTimeout(300);
    const cls = await page.evaluate(() => document.activeElement?.className || '');
    expect(cls).not.toContain('xterm-helper-textarea');
  });
});

test.describe('FR-MTI-26: 키보드 내리기 버튼', () => {
  test('TC-MTI-21: 버튼이 있고, 누르면 blur 되며 키를 보내지 않는다', async ({ page }) => {
    await gotoMobile(page);
    const btn = page.locator('#mobile-keybar .mkb-btn[data-act="hidekb"]');
    await expect(btn).toHaveCount(1);

    await page.evaluate(() => {
      const p = (window as any).app._focusedTerminal();
      (p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement).focus();
      (window as any).__sent = [];
      const orig = p._send.bind(p);
      p._send = (m: Uint8Array) => { if (m[0] === 0) (window as any).__sent.push(1); return orig(m) };
    });
    await btn.click();
    await page.waitForTimeout(200);
    const cls = await page.evaluate(() => document.activeElement?.className || '');
    expect(cls).not.toContain('xterm-helper-textarea');
    expect(await page.evaluate(() => (window as any).__sent.length)).toBe(0);
  });
});
