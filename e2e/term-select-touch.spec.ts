import { CDPSession, Page } from '@playwright/test';

import { test, expect, waitSettled } from './fixtures';

/**
 * UX_BATCH11_SRS FR-TCP-7~9 (개정 2) — 모바일 터미널의 글자는 OS 가 선택한다.
 *
 * 터치는 CDP 로 낸다 (`mobile-tui-input-touch.spec.ts` 와 같은 길). 단어 선택·핸들·도구 막대는
 * 브라우저의 것이라 에뮬레이션에서 보이지 않는다 — 여기서 재는 것은 **우리가 그것을 막지 않는가**
 * (선택할 수 있는 글자인가, `contextmenu` 의 기본 동작을 두는가)와 복사되는 글자다.
 */
async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'mobile') });
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 15000 });
  await waitSettled(page);
  await page.waitForSelector('#mobile-keybar .mkb-btn', { timeout: 15000 });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function spySends(page: Page) {
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
  });
}
const sent = (page: Page) => page.evaluate(() => ((window as any).__sent as string[]).join(''));

async function fill(page: Page) {
  await page.evaluate(() => {
    const p = (window as any).app.testing.focusedTerminal();
    let s = '';
    for (let i = 1; i <= 200; i++) s += `row-${i}-text\r\n`;
    p.term.write(s);
  });
  await expect.poll(() => page.evaluate(() =>
    (window as any).app.testing.focusedTerminal().term.buffer.active.length), { timeout: 10000 }).toBeGreaterThan(200);
}

/** 화면 r 행 c 칸의 중심 좌표. */
const cellAt = (page: Page, c: number, r: number) => page.evaluate(([col, row]) => {
  const p = (window as any).app.testing.focusedTerminal();
  const rect = p.el.querySelector('.xterm-screen').getBoundingClientRect();
  const cw = rect.width / p.term.cols, ch = rect.height / p.term.rows;
  return { x: rect.left + (col + 0.5) * cw, y: rect.top + (row + 0.5) * ch };
}, [c, r] as const);

const state = (page: Page) => page.evaluate(() => {
  const t = (window as any).app.testing.focusedTerminal().term;
  return { sel: t.hasSelection(), text: t.getSelection(), vy: t.buffer.active.viewportY };
});

const touch = (cdp: CDPSession, type: string, pt?: { x: number; y: number }) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pt ? [pt] : [] } as any);

test.describe('모바일 기본 선택', () => {
  test('TC-TCP-6 터미널 줄이 OS 가 선택할 수 있는 글자다', async ({ page }) => {
    await gotoMobile(page);
    const sel = await page.evaluate(() => {
      const rows = (window as any).app.testing.focusedTerminal().el.querySelector('.xterm-rows');
      const cs = getComputedStyle(rows);
      return cs.userSelect || (cs as any).webkitUserSelect;
    });
    expect(sel).toBe('text');
  });

  test('TC-TCP-6 contextmenu 의 기본 동작을 막지 않고 터미널 메뉴를 세우지 않는다', async ({ page }) => {
    await gotoMobile(page);
    await fill(page);
    const prevented = await page.evaluate(() => {
      const rows = (window as any).app.testing.focusedTerminal().el.querySelector('.xterm-rows');
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 40 });
      rows.firstElementChild.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented, '선택 도구 막대가 막힌다').toBe(false);
    await expect(page.locator('.term-menu')).toHaveCount(0);
  });

  test('TC-TCP-6 길게 누르기는 스크롤하지 않고 터미널 메뉴를 세우지 않는다', async ({ page }) => {
    await gotoMobile(page);
    await fill(page);
    const cdp = await page.context().newCDPSession(page);
    const before = (await state(page)).vy;
    await touch(cdp, 'touchStart', await cellAt(page, 3, 3));
    // **예외 (`TEST-16`): 일어나지 않는 것을 잰다.** 길게 누르기 시한(600ms)을 넘겨 눌러 둔다.
    await page.waitForTimeout(900);
    await touch(cdp, 'touchEnd');
    expect((await state(page)).vy).toBe(before);
    await expect(page.locator('.term-menu')).toHaveCount(0);
  });

  test('TC-TCP-6·8 줄을 OS 선택으로 잡아 복사하면 그 글자가 nbsp 없이 실린다', async ({ page }) => {
    await gotoMobile(page);
    await page.evaluate(() => {
      // 밑줄 친 공백은 DOM 렌더러가 \xa0 으로 그린다.
      (window as any).app.testing.focusedTerminal().term.write('\r\nfpl_a\x1b[4m \x1b[0mfpl_b\r\n');
    });
    await expect.poll(() => page.evaluate(() =>
      (window as any).app.testing.focusedTerminal().el.querySelector('.xterm-rows').textContent.includes('fpl_a')), { timeout: 10000 }).toBe(true);
    const got = await page.evaluate(() => {
      const rows = (window as any).app.testing.focusedTerminal().el.querySelector('.xterm-rows');
      const row = [...rows.children].find((r: any) => r.textContent.includes('fpl_a')) as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(row);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const dt = new DataTransfer();
      const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      row.dispatchEvent(ev);
      return { text: dt.getData('text/plain'), raw: row.textContent };
    });
    expect(got.raw, '시험이 nbsp 를 만들지 못했다').toContain('\xa0');
    expect(got.text).toContain('fpl_a fpl_b');
    expect(got.text).not.toContain('\xa0');
  });

  test('TC-TCP-7 선택이 있을 때 키바 ^C 는 복사이고 0x03 을 보내지 않는다', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await gotoMobile(page);
    await fill(page);
    await spySends(page);
    await page.evaluate(() => {
      const t = (window as any).app.testing.focusedTerminal().term;
      t.select(0, t.buffer.active.viewportY + 2, 6);
    });
    const want = (await state(page)).text;
    expect(want.length).toBe(6);
    await page.locator('#mobile-keybar .mkb-btn', { hasText: '^C' }).tap();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10000 }).toBe(want);
    expect((await state(page)).sel).toBe(false);
    expect(await sent(page)).not.toContain('\x03');
    await page.locator('#mobile-keybar .mkb-btn', { hasText: '^C' }).tap();
    await expect.poll(() => sent(page), { timeout: 10000 }).toContain('\x03');
  });
});
