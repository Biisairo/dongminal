import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * PERF 3.6.2 (D-40 A안) — 부팅 때 WebGL 은 뒤 프레임에 붙고, 그 전의 `doFit` 은 WebGL 로 설 크기(예측값)로 잰다.
 *
 * 재는 것은 둘이다. 예측이 실제 WebGL 렌더러의 `fit` 과 같은가, 그래서 부팅 동안 칸마다 크기가 한 번만
 * 바뀌는가(PTY 리사이즈 한 번). 헤드리스에 WebGL2 가 없으면 붙이기가 실패하므로 건너뛴다 — 그 복귀는
 * `term-gpu.spec.ts` V-TGR-1 이 잰다.
 */

const state = (page: Page) => page.evaluate(() => {
  const p = (window as any).app.testing.focusedTerminal();
  return { renderer: p.gpuRenderer() as string, unavailable: !!(0, eval)('TermGpu').unavailable };
});

test.beforeEach(async ({ page }) => {
  await page.context().addInitScript(() => {
    localStorage.setItem('termGpu', '1');
    // xterm 이 전역 `Terminal` 을 세우는 순간 `resize` 를 감싸 칸마다 크기가 바뀐 횟수를 남긴다.
    let T: any;
    Object.defineProperty(window, 'Terminal', {
      configurable: true,
      get: () => T,
      set: (v) => {
        T = v;
        const orig = v.prototype.resize;
        v.prototype.resize = function (c: number, r: number) {
          const was = this.cols + 'x' + this.rows;
          orig.call(this, c, r);
          const now = this.cols + 'x' + this.rows;
          if (now !== was) (this.__sizes ||= []).push(now);
        };
      },
    });
  });
  await waitForInit(page);
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
});

test('PERF 3.6.2: 부팅 동안 보이는 칸의 크기는 한 번만 바뀐다 — GPU 를 붙여도 다시 바뀌지 않는다', async ({ page }) => {
  const first = await state(page);
  test.skip(first.unavailable, '이 환경은 WebGL2 를 쓸 수 없다');
  await expect.poll(() => state(page).then((s) => s.renderer), { timeout: 10000 }).toBe('webgl');
  const sizes = await page.evaluate(() => (window as any).app.testing.focusedTerminal().term.__sizes || []);
  expect(sizes, JSON.stringify(sizes)).toHaveLength(1);
});

test('PERF 3.6.2: WebGL 칸 크기 예측이 붙은 뒤의 fit 과 같다', async ({ page }) => {
  const first = await state(page);
  test.skip(first.unavailable, '이 환경은 WebGL2 를 쓸 수 없다');
  await expect.poll(() => state(page).then((s) => s.renderer), { timeout: 10000 }).toBe('webgl');
  for (const [w, h] of [[1280, 720], [1111, 677], [1503, 911], [997, 803]]) {
    await page.setViewportSize({ width: w, height: h });
    await expect.poll(() => page.evaluate(() => {
      const p = (window as any).app.testing.focusedTerminal();
      const want = p._gpuDims(), got = p.fit.proposeDimensions();
      return want && got && want.cols === got.cols && want.rows === got.rows ? 'same' : JSON.stringify({ want, got });
    }), { timeout: 5000 }).toBe('same');
  }
});
