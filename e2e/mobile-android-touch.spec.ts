import { CDPSession, Page } from '@playwright/test';
import { test, expect, waitSettled } from './fixtures';

// MOBILE_TUI_INPUT_SCROLL_SRS §6 — Android Chrome 실기기 사슬의 교정.

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'mobile') });
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 15000 });
  await waitSettled(page);
  await page.waitForSelector('#mobile-keybar .mkb-btn', { timeout: 15000 });
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function fill(page: Page, lines = 300) {
  await page.evaluate((n) => {
    const p = (window as any).app.testing.focusedTerminal();
    let s = '';
    for (let i = 1; i <= n; i++) s += `line-${i}\r\n`;
    p.term.write(s);
  }, lines);
  // `write` 는 비동기다 — 버퍼가 자란 것을 본다.
  await expect
    .poll(() => page.evaluate(() =>
      (window as any).app.testing.focusedTerminal().term.buffer.active.length), { timeout: 10000 })
    .toBeGreaterThan(lines);
}

// 하단으로부터의 거리 — rows 가 바뀌어도 이것이 보존되어야 한다.
async function distFromBottom(page: Page) {
  return await page.evaluate(() => {
    const p = (window as any).app.testing.focusedTerminal();
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
    await page.evaluate(() => { (window as any).app.testing.focusedTerminal().term.scrollLines(-40) });
    await expect.poll(async () => (await distFromBottom(page)).dist, { timeout: 10000 }).toBe(40);
    const before = await distFromBottom(page);
    expect(before.dist).toBe(40);

    // 키보드 등장과 같은 경로: 뷰포트 축소 → window resize → fit.
    // **`rows` 가 실제로 바뀐 것**이 그 경로가 끝난 신호다 — 아래 단정이 딛는
    // 전제이기도 하다.
    await page.setViewportSize({ width: 412, height: 460 });
    await expect.poll(async () => (await distFromBottom(page)).rows, { timeout: 10000 })
      .not.toBe(before.rows);
    const after = await distFromBottom(page);
    expect(after.rows).not.toBe(before.rows);   // rows 가 실제로 바뀌었는지
    expect(after.dist).toBe(40);
  });

  test('TC-MTI-17: 하단에 있었으면 리사이즈 후에도 하단이다', async ({ page }) => {
    await gotoMobile(page);
    await fill(page);
    await page.evaluate(() => { (window as any).app.testing.focusedTerminal().term.scrollToBottom() });
    await expect.poll(async () => (await distFromBottom(page)).dist, { timeout: 10000 }).toBe(0);
    const rows0 = (await distFromBottom(page)).rows;
    expect((await distFromBottom(page)).dist).toBe(0);
    await page.setViewportSize({ width: 412, height: 460 });
    // 리사이즈가 끝난 신호는 `rows` 의 변화다 — 그 뒤에 자리를 본다.
    await expect.poll(async () => (await distFromBottom(page)).rows, { timeout: 10000 })
      .not.toBe(rows0);
    expect((await distFromBottom(page)).dist).toBe(0);
  });
});

test.describe('FR-MTI-22/24: 스크롤 제스처가 키보드를 부르지 않는다', () => {
  test('TC-MTI-18: 스크롤 제스처 후 helper textarea 가 focus 가 아니다', async ({ page }) => {
    await gotoMobile(page);
    await fill(page);
    await page.evaluate(() => {
      const p = (window as any).app.testing.focusedTerminal();
      (p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement).focus();
    });
    expect(await page.evaluate(() => document.activeElement?.className || '')).toContain('xterm-helper-textarea');

    const client = await page.context().newCDPSession(page);
    await touchDrag(client, await screenCenter(page), 200);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className || ''), { timeout: 10000 })
      .not.toContain('xterm-helper-textarea');
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
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className || ''), { timeout: 10000 })
      .toContain('xterm-helper-textarea');
    expect(await page.evaluate(() => document.activeElement?.className || '')).toContain('xterm-helper-textarea');
  });
});

test.describe('FR-MTI-25: 자동 focus 억제', () => {
  test('TC-MTI-23: 모바일 첫 로드에서 helper textarea 가 focus 되지 않는다', async ({ page }) => {
    await gotoMobile(page);
    // **예외 (`TEST-16`): 일어나지 않는 자동 focus 를 잰다.** 기다릴 신호가
    // 없다 — 시간을 주고 그래도 잡히지 않았는지 본다.
    await page.waitForTimeout(300);
    const cls = await page.evaluate(() => document.activeElement?.className || '');
    expect(cls).not.toContain('xterm-helper-textarea');
  });
});

/**
 * FR-MTI-26 → ALERT_MOBILE_CONTEXT_SRS FR-MKB-4·5 로 개정.
 *
 * 버튼의 `act` 가 `hidekb` 에서 `kb` 가 됐다 — 내리기만 하던 것이 **두 방향**을
 * 갖는다. 재는 계약은 그대로다: 누르면 blur 되고 **키를 보내지 않는다.**
 *
 * 다만 출발 상태를 세워야 한다. FR-MKB-1 이후 터미널의 `inputmode` 는 `none` 이고,
 * 그 상태에서 이 버튼은 **올리는** 쪽으로 동작한다. 내리는 쪽을 재려면 먼저
 * 풀어 둔다 — 그것이 사용자가 `⌨` 를 한 번 누른 뒤의 상태다.
 */
test.describe('FR-MKB-5: 키보드 내리기 (옛 FR-MTI-26)', () => {
  test('TC-MTI-21: 버튼이 있고, 누르면 blur 되며 키를 보내지 않는다', async ({ page }) => {
    await gotoMobile(page);
    const btn = page.locator('#mobile-keybar .mkb-btn[data-act="kb"]');
    await expect(btn).toHaveCount(1);
    await page.evaluate(() => {
      const p = (window as any).app.testing.focusedTerminal();
      p._kbAllow();
    });

    await page.evaluate(() => {
      const p = (window as any).app.testing.focusedTerminal();
      (p.el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement).focus();
      (window as any).__sent = [];
      const orig = p._send.bind(p);
      p._send = (m: Uint8Array) => {
        // 포커스 보고(CSI I·O)는 사용자가 보낸 키가 아니다 — 창이 포커스를 얻고
        // 잃을 때 터미널이 스스로 낸다 (Windows 러너에서 실측).
        const t = m[0] === 0 ? new TextDecoder().decode(m.subarray(1)) : '';
        if (m[0] === 0 && t !== '\x1b[I' && t !== '\x1b[O') (window as any).__sent.push(1);
        return orig(m);
      };
    });
    await btn.click();
    // **예외 (`TEST-16`)**: focus 도 전송도 **일어나지 않음**을 잰다.
    await page.waitForTimeout(200);
    const cls = await page.evaluate(() => document.activeElement?.className || '');
    expect(cls).not.toContain('xterm-helper-textarea');
    expect(await page.evaluate(() => (window as any).__sent.length)).toBe(0);
  });
});
