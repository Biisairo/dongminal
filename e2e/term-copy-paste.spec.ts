import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitShellReady } from './fixtures';
import { echoCmd } from './osenv';

/**
 * UX_BATCH11_SRS FR-TCP — 터미널의 복사·붙여넣기 키 (PC).
 *
 * 선택은 xterm 공개 API(`term.select`)로 세운다 — 재려는 것은 "선택이 있을 때 키가 무엇이
 * 되는가" 이고, 선택을 어떻게 만들었는지는 이 규칙과 무관하다. 드래그 자체는 TC-TCP-2 가 본다.
 */
const MARK = 'tcp_marker_4471';

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
const clearSent = (page: Page) => page.evaluate(() => { (window as any).__sent = [] });

async function printMarker(page: Page) {
  await waitShellReady(page);
  await page.click('#area .pn.focused .xterm-screen');
  await page.keyboard.type(echoCmd(MARK));
  await page.keyboard.press('Enter');
  await expect.poll(() => markerRow(page), { timeout: 15000 }).toBeGreaterThanOrEqual(0);
}

/** 출력된 표식 줄(명령 줄이 아닌 것)의 버퍼 행. */
const markerRow = (page: Page) => page.evaluate((mk) => {
  const b = (window as any).app.testing.focusedTerminal().term.buffer.active;
  let y = -1;
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === mk) y = i;
  return y;
}, MARK);

async function selectMarker(page: Page) {
  const y = await markerRow(page);
  await page.evaluate(([row, n]) => {
    const t = (window as any).app.testing.focusedTerminal().term;
    t.select(0, row as number, n as number);
  }, [y, MARK.length] as const);
  expect(await page.evaluate(() => (window as any).app.testing.focusedTerminal().term.getSelection())).toBe(MARK);
}

const hasSel = (page: Page) => page.evaluate(() => (window as any).app.testing.focusedTerminal().term.hasSelection());
const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.describe('복사', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('TC-TCP-1 선택이 있을 때 Ctrl+C 는 복사하고 보내지 않는다 · 없으면 ^C', async ({ page }) => {
    await waitForInit(page);
    await printMarker(page);
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await spySends(page);
    await selectMarker(page);
    await page.keyboard.press('Control+c');
    await expect.poll(() => clip(page), { timeout: 10000 }).toBe(MARK);
    expect(await hasSel(page), '복사 뒤 선택이 남았다').toBe(false);
    expect(await sent(page)).not.toContain('\x03');
    // 선택이 없으면 중단이다.
    await page.keyboard.press('Control+c');
    await expect.poll(() => sent(page), { timeout: 10000 }).toContain('\x03');
  });

  test('TC-TCP-1 Ctrl+Shift+C 는 이 규칙을 타지 않는다', async ({ page }) => {
    await waitForInit(page);
    await printMarker(page);
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await selectMarker(page);
    await page.keyboard.press('Control+Shift+c');
    // **예외 (`TEST-16`): 일어나지 않는 복사를 잰다.** 기다릴 신호가 없다 — 쓰기는 비동기다.
    await page.waitForTimeout(300);
    expect(await clip(page)).toBe('sentinel');
  });

  test('TC-TCP-2 드래그로 선택하고 놓기만 하면 복사하지 않는다', async ({ page }) => {
    await waitForInit(page);
    await printMarker(page);
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    const y = await markerRow(page);
    const box = await page.evaluate((row) => {
      const p = (window as any).app.testing.focusedTerminal();
      const r = p.el.querySelector('.xterm-screen').getBoundingClientRect();
      const ch = r.height / p.term.rows, cw = r.width / p.term.cols;
      const vy = row - p.term.buffer.active.viewportY;
      return { x: r.left, y: r.top + (vy + 0.5) * ch, cw };
    }, y);
    await page.mouse.move(box.x + box.cw * 0.2, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.cw * (MARK.length - 0.2), box.y, { steps: 8 });
    await page.mouse.up();
    expect(await hasSel(page)).toBe(true);
    // **예외 (`TEST-16`): 일어나지 않는 복사를 잰다.**
    await page.waitForTimeout(300);
    expect(await clip(page)).toBe('sentinel');
  });

  test('TC-TCP-3 복사하면 토스트 · 쓰기가 다 막히면 복사창이 서고 토스트는 없다', async ({ page }) => {
    await waitForInit(page);
    await printMarker(page);
    await selectMarker(page);
    await page.keyboard.press('Control+c');
    await expect(page.locator('#toast-host')).toContainText('복사', { timeout: 10000 });

    await page.evaluate(() => {
      document.querySelectorAll('#toast-host > *').forEach((n) => n.remove());
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      (document as any).execCommand = () => false;
    });
    await page.click('#area .pn.focused .xterm-screen');
    await selectMarker(page);
    await page.keyboard.press('Control+c');
    await expect(page.locator('#term-copy')).toBeVisible({ timeout: 10000 });
    expect(await page.locator('#toast-host').innerText()).not.toContain('복사');
  });
});

/**
 * TC-TCP-5 — 플랫폼은 `userAgentData` 로 정한다 (`IS_MAC`). 실행 기계와 무관하게 재려고
 * 싣기 전에 덮는다. 진짜 붙여넣기(OS 클립보드)는 헤드리스에서 키가 일으키지 않으므로,
 * "기본 동작을 막지 않는다" 와 "`0x16` 이 가지 않는다" 를 재고 `paste` 이벤트의 경로를 따로 잰다.
 */
for (const plat of ['Linux', 'macOS']) {
  test.describe(`Ctrl+V — ${plat}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((pl) => {
        Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: pl }), configurable: true });
        Object.defineProperty(navigator, 'platform', { get: () => (pl === 'macOS' ? 'MacIntel' : 'Linux x86_64'), configurable: true });
      }, plat);
    });

    test(`TC-TCP-5 ${plat}`, async ({ page }) => {
      await waitForInit(page);
      await waitShellReady(page);
      await page.click('#area .pn.focused .xterm-screen');
      await spySends(page);
      await page.evaluate(() => {
        (window as any).__vPrevented = null;
        document.addEventListener('keydown', (e) => {
          if (e.key === 'v' && e.ctrlKey) (window as any).__vPrevented = e.defaultPrevented;
        });
      });
      await clearSent(page);
      await page.keyboard.press('Control+v');
      if (plat === 'macOS') {
        await expect.poll(() => sent(page), { timeout: 10000 }).toContain('\x16');
        return;
      }
      expect(await page.evaluate(() => (window as any).__vPrevented)).toBe(false);
      // **예외 (`TEST-16`): 일어나지 않는 송신을 잰다.**
      await page.waitForTimeout(300);
      expect(await sent(page)).not.toContain('\x16');
      // 브라우저가 낼 `paste` 이벤트는 xterm 의 붙여넣기 경로로 간다.
      await page.evaluate(() => {
        const ta = (window as any).app.testing.focusedTerminal().el.querySelector('.xterm-helper-textarea');
        const dt = new DataTransfer();
        dt.setData('text/plain', 'pasted_ok_93');
        ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await expect.poll(() => sent(page), { timeout: 10000 }).toContain('pasted_ok_93');
    });
  });
}
