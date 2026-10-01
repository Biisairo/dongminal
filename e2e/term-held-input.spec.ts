import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitShellReady } from './fixtures';
import { echoCmd } from './osenv';

/**
 * UX_BATCH11_SRS TC-HIN-4 — 끊긴 동안 친 입력은 붙잡혔다가 사용자가 고른 뒤에만 나간다.
 *
 * 끊김은 `term-resume.spec.ts` 와 같이 그 칸의 소켓을 닫아 만든다. 재접속은 즉시 시도되므로
 * 닫는 것과 치는 것을 **한 평가 안에서** 한다 — 사이에 연결이 돌아오면 보류가 아니다.
 */
async function dropAndType(page: Page, text: string) {
  await page.evaluate((s) => {
    const p = (window as any).app.testing.focusedTerminal();
    p.ws.close();
    p.term.input(s, true);
  }, text);
}

const banner = (page: Page) => page.locator('#area .pn.focused .tp-held');
const rows = (page: Page) => page.locator('#area .pn.focused .xterm-rows');

test('TC-HIN-4 재연결 뒤 배너가 서고 [보내기]를 눌러야 나간다', async ({ page }) => {
  await waitForInit(page);
  await waitShellReady(page);
  await page.click('#area .pn.focused .xterm-screen');
  await dropAndType(page, echoCmd('held_ok_' + '31') + '\r');
  await expect(banner(page)).toBeVisible({ timeout: 15000 });
  await expect(banner(page)).toHaveAttribute('role', 'status');
  await expect(banner(page)).toContainText('held_ok_31');
  // **예외 (`TEST-16`): 일어나지 않는 자동 전송을 잰다.** 배너가 선 뒤에도 출력이 없는지 본다.
  await page.waitForTimeout(500);
  await expect(rows(page)).not.toContainText('held_ok_31\n');
  expect(await page.evaluate(() => {
    const b = (window as any).app.testing.focusedTerminal().term.buffer.active;
    for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === 'held_ok_31') return true;
    return false;
  })).toBe(false);

  await banner(page).getByRole('button', { name: /보내기/ }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const b = (window as any).app.testing.focusedTerminal().term.buffer.active;
    for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === 'held_ok_31') return true;
    return false;
  }), { timeout: 15000 }).toBe(true);
});

test('TC-HIN-4 [버리기]는 아무것도 보내지 않는다 · 배너가 떠 있는 동안 친 것은 곧바로 간다', async ({ page }) => {
  await waitForInit(page);
  await waitShellReady(page);
  await page.click('#area .pn.focused .xterm-screen');
  await page.evaluate(() => {
    const p = (window as any).app.testing.focusedTerminal();
    (window as any).__sent = [];
    const orig = p._send.bind(p);
    p._send = (m: Uint8Array) => {
      if (m[0] === 0) (window as any).__sent.push(new TextDecoder().decode(m.subarray(1)));
      return orig(m);
    };
  });
  await dropAndType(page, 'discard_me_88');
  await expect(banner(page)).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => { (window as any).__sent = [] });
  await page.evaluate(() => (window as any).app.testing.focusedTerminal().term.input('z', true));
  await expect.poll(() => page.evaluate(() => (window as any).__sent.join('')), { timeout: 10000 }).toContain('z');
  await banner(page).getByRole('button', { name: /버리기/ }).click();
  await expect(banner(page)).toHaveCount(0);
  // **예외 (`TEST-16`): 일어나지 않는 송신을 잰다.**
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__sent.join(''))).not.toContain('discard_me_88');
});
