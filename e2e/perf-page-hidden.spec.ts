import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitShellReady, addEditorRoot, switchToEditorRoot, rmTree, JSON_HDR } from './fixtures';
import { TMP, realPath } from './osenv';

/**
 * PERF M3 3.5.4 (FR-SPA-3, D-36) — 브라우저 탭이 숨으면 터미널 밖 화면은 2초 뒤, 터미널은 30초 뒤 잔다.
 *
 *   이전: 브라우저 탭이 숨어도 칸·탭에서 보이는 화면은 잠들지 않았다(TimerHub 의 주기 작업만 멈췄다)
 *   새:   숨은 뒤 터미널 밖 화면은 2초, 터미널은 30초 뒤 잔다. 그 안에 돌아오면 그대로이고, 잠든 뒤 돌아오면 깬다
 *   이유: 창·탭이 많을 때 숨은 브라우저 탭의 보이는 터미널 출력을 계속 해석하지 않는다(D-M3-8 C)
 *
 * 숨김은 흉내 낸다 — 아래 `setHidden` 의 주석.
 *
 * **고정 대기의 예외 (`TEST-16`).** "터미널 밖 화면이 잘 시간(2초)이 지나도 터미널은 깨어 있다" 를 재는 자리의
 * `waitForTimeout` 하나 — 기다릴 신호가 없다.
 */

const TERM_PAGE_SLEEP_MS = 30000;

let BASE = '';
test.beforeAll(() => { BASE = realPath(mkdtempSync(join(TMP, 'otter-ph-'))) });
test.afterAll(() => { rmTree(BASE) });

/**
 * `page` 의 브라우저 탭 숨김을 흉내 낸다. 이 러너에서는 실제로 숨길 수 없다 — 새 탭을 앞으로 가져와도, 창을 CDP 로
 * 최소화해도(헤드리스 셸·새 헤드리스·헤드풀 모두) `visibilityState` 가 `visible` 이다(2026-11-25 실측,
 * `git-refresh-lifecycle.spec.ts` V-GRF-14 와 같은 결론). 그래서 `document.hidden` 을 덮고 `visibilitychange` 를 낸다.
 * 그 뒤의 길(TimerHub 의 하나뿐인 리스너 → ScreenLife → term.close → 깨움 스냅숏)은 실제다.
 */
const setHidden = (page: Page, hidden: boolean) => page.evaluate((h: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

const hide = (page: Page) => setHidden(page, true);
const reveal = (page: Page) => setHidden(page, false);

const term = (page: Page, fn: string) => page.evaluate(`(() => {
  const p = window.app.testing.focusedTerminal();
  return (${fn})(p);
})()`);

const awake = `p => !!p._sock.want`;

const hasText = (s: string) => `p => {
  const b = p.term.buffer.active;
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) || '').includes(${JSON.stringify(s)})) return true;
  return false;
}`;

const blank = `p => {
  const b = p.term.buffer.active;
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) || '').trim()) return false;
  return true;
}`;

test('터미널은 숨은 뒤 2초를 넘겨도 깨어 있고 30초 뒤 잔다. 돌아오면 잠든 동안의 출력까지 서버와 같다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await waitForInit(page, { clearLocalStorage: true });
  await waitShellReady(page);
  const id = await term(page, 'p => p.id') as string;
  const input = (text: string) => request.post('/api/tools/input', { headers: JSON_HDR, data: { id, text, execute: true } });
  expect((await input('echo PH_BEFORE_$((40+2))')).ok()).toBe(true);
  await expect.poll(() => term(page, hasText('PH_BEFORE_42'))).toBe(true);

  await hide(page);
  const t0 = Date.now();
  await page.waitForTimeout(3000);
  expect(await term(page, awake)).toBe(true);

  await expect.poll(() => term(page, awake), { timeout: TERM_PAGE_SLEEP_MS + 15_000, intervals: [500] }).toBe(false);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(TERM_PAGE_SLEEP_MS - 1000);
  expect(await term(page, blank)).toBe(true);
  const kinds = await page.evaluate(() => (window as any).app.testing.sleepers().map((s: any) => s.kind));
  expect(kinds).toContain('TerminalTool');

  expect((await input('echo PH_ASLEEP_$((50+5))')).ok()).toBe(true);
  await reveal(page);
  await expect.poll(() => term(page, awake)).toBe(true);
  await expect.poll(() => term(page, hasText('PH_ASLEEP_55'))).toBe(true);
  expect(await term(page, hasText('PH_BEFORE_42'))).toBe(true);
});

test('터미널은 30초 안에 돌아오면 잠들지 않는다', async ({ page }) => {
  await waitForInit(page, { clearLocalStorage: true });
  await waitShellReady(page);
  await hide(page);
  await page.waitForTimeout(3000);
  await reveal(page);
  expect(await term(page, awake)).toBe(true);
  expect(await page.evaluate(() => (window as any).app.testing.sleepers().length)).toBe(0);
});

test('터미널 밖 화면(편집기)은 숨은 뒤 2초에 잠들고 돌아오면 깬다', async ({ page, request }) => {
  const root = join(BASE, 'ed');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'one\n');
  const saved = await addEditorRoot(request, root);
  await waitForInit(page);
  await switchToEditorRoot(page, saved);
  await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }), saved + '/a.txt');
  const asleep = () => page.evaluate(() => {
    const e = [...(window as any).app.fileEditors.values()].find((x: any) => x.name === 'a.txt');
    return e ? !!e.asleep : null;
  });
  await expect.poll(asleep, { timeout: 30000 }).toBe(false);

  await hide(page);
  const t0 = Date.now();
  await expect.poll(asleep, { timeout: 10000 }).toBe(true);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
  await reveal(page);
  await expect.poll(asleep).toBe(false);
});
