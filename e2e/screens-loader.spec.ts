import { test, expect, waitForInit } from './fixtures';

// PERF 3.4.3 — 화면 등록부·로더·자리표시 (D-30, perf/M3_DESIGN.md §3.4).
//
// 아직 어떤 화면도 묶음으로 옮기지 않았다. 시험용 묶음 probe 를 런타임에 등록하고, 그 묶음의 JS·CSS 요청
// 만 가로채 내용을 준다 — 서버의 묶음 서빙은 Rust 단위 시험이 잰다.

test('TC-SCR-1: loadScreen 은 묶음을 한 번만 싣고 JS·CSS 가 둘 다 선 뒤에 푼다', async ({ page }) => {
  await page.route(/\/b\/probe\.js\?/, (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.__probe=(window.__probe||0)+1;' }));
  await page.route(/\/b\/probe\.css\?/, (r) => r.fulfill({ contentType: 'text/css', body: '.probe-mark{outline-width:3px}' }));
  await waitForInit(page);
  const got = await page.evaluate(async () => {
    Screens.register('probe', { css: true });
    const a = (window as any).app.testing.loadScreen('probe');
    const b = (window as any).app.testing.loadScreen('probe');
    await Promise.all([a, b]);
    const mark = document.createElement('div');
    mark.className = 'probe-mark';
    document.body.appendChild(mark);
    return {
      runs: (window as any).__probe,
      tags: document.querySelectorAll('script[src*="b/probe.js"]').length,
      src: document.querySelector('script[src*="b/probe.js"]')?.getAttribute('src'),
      css: getComputedStyle(mark).outlineWidth,
      ready: Screens.ready('probe'),
    };
  });
  expect(got.runs).toBe(1);
  expect(got.tags).toBe(1);
  expect(got.src).toMatch(/^b\/probe\.js\?v=[0-9a-f]+$/);
  expect(got.css).toBe('3px');
  expect(got.ready).toBe(true);
});

test('TC-SCR-2: 묶음이 아직인 탭은 자리표시 뒤 실리면 실제 본문으로 그려진다', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((res) => { release = res });
  await page.route(/\/b\/probe\.js\?/, async (r) => {
    await held;
    await r.fulfill({ contentType: 'text/javascript', body: 'window.__probe=1;' });
  });
  await waitForInit(page);
  const body = page.locator('#area .pn.focused .pn-body');
  await expect(body.locator('.xterm')).toBeVisible();
  await page.evaluate(() => {
    // 터미널 탭을 맡는 시험 화면이다. 실리기 전까지는 터미널 대신 자리표시가 선다.
    Screens.register('probe', { tab: (at: any) => !!at.toolId });
    (window as any).app.render();
  });
  await expect(body.locator('.ui-empty.ui-empty-center')).toBeVisible();
  await expect(body.locator('.xterm')).toHaveCount(0);
  release();
  await expect(body.locator('.xterm')).toBeVisible();
  await expect(body.locator('.ui-empty.ui-empty-center')).toHaveCount(0);
});
