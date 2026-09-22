import { Page } from '@playwright/test';

import { test, expect, waitSettled } from './fixtures';

// 묶음 X (CONVENIENCE_SRS §3.2) — V-BGK-12 의 실기기 터치 경로.
//
// 이 파일은 hasTouch:true 프로젝트(mobile-touch)에서만 돈다. FR-BGK-2 가
// hover 게이팅을 금지한 이유가 "터치 기기에 hover 가 없다" 이므로, 그 주장은
// 마우스 프로젝트의 .click() 으로는 검증되지 않는다 — 탭만으로 확인 단계에
// 닿는지를 여기서 본다.

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'mobile');
  });
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 15000 });
  await waitSettled(page);
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// bg-kill.spec.ts 와 같은 수단(detachTab)이다. 스펙 파일 사이의 import 는
// 테스트를 두 번 등록시키므로 최소한만 옮겨 적는다.
async function makeBackgroundTool(page: Page, request: any): Promise<string> {
  const target = await page.evaluate(() => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    const walk = (nd: any): string | null => {
      if (!nd) return null;
      for (const t of nd.tabs || []) if (t.toolId) return t.toolId;
      for (const c of nd.children || []) { const r = walk(c); if (r) return r; }
      return null;
    };
    return walk(w?.layout);
  });
  expect(target, '참조된 도구가 없다').toBeTruthy();

  const add = await request.post('/api/commands', { data: { action: 'newTab', args: {} } });
  expect(add.status()).toBe(200);
  await expect.poll(async () => page.evaluate(() => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    let c = 0;
    const walk = (x: any) => {
      if (!x) return;
      c += (x.tabs || []).length;
      for (const ch of x.children || []) walk(ch);
    };
    walk(w?.layout);
    return c;
  }), { timeout: 10000 }).toBeGreaterThan(1);

  const r = await request.post('/api/commands', { data: { action: 'detachTab', args: { toolId: target } } });
  expect(r.status(), `detachTab 이 ${r.status()} 로 거부됐다`).toBe(200);
  await expect.poll(
    async () => page.evaluate((tid) =>
      ((window as any).app.testing.bg || []).some((b: any) => b.toolId === tid), target),
    { timeout: 10000 },
  ).toBe(true);
  return target as string;
}

test.describe('FR-BGK-2: 터치로 종료 목표에 닿는다', () => {
  test('TC-BGK-12t: hover 없이 탭만으로 인라인 확인에 도달한다', async ({ page, request }) => {
    await gotoMobile(page);
    const id = await makeBackgroundTool(page, request);

    // D-7 (FR-CHR-15·17): `#bg-btn` 이 없어졌고 `Activity` 가 그 자리를 진다.
    // 모바일에서는 단축키가 길이 아니므로 **버튼이 유일한 길**이다.
    await page.locator('#agents-toggle').tap();
    const row = page.locator(`#agents-panel .bg-row[data-toolid="${id}"]`);
    await expect(row).toBeVisible();

    const btn = row.locator('.bg-kill');
    await expect(btn).toBeVisible();
    /**
     * **재는 것과 단언을 한 묶음으로 본다** (DRIFT_RECLAIM_SRS FR-DRC-18).
     *
     * M9_SRS FR-M9-11 이 `bg-kill.spec.ts` TC-BGK-12 에서 고친 자리가 **여기에도
     * 있었다.** P2 전량이 이 줄로 흔들렸다 — `boundingBox()` 가 `null`(전량 회차
     * 실측), 즉 `toBeVisible()` 을 통과한 그 요소가 다음 관측에서는 문서에 없다.
     * 목록의 재렌더는 앱의 정상 동작이고 떨어진 요소가 빈손을 주는 것도 규약이다.
     */
    await expect
      .poll(async () => btn.evaluate((el) => getComputedStyle(el).opacity),
        { timeout: 10000, message: '종료 버튼이 투명하다' })
      .toBe('1');
    await expect
      .poll(async () => (await btn.boundingBox())?.height ?? 0,
        { timeout: 10000, message: '터치 타깃이 너무 낮다' })
      .toBeGreaterThanOrEqual(32);

    await btn.tap();
    await expect(row.locator('.bg-confirm')).toBeVisible();
    // 탭 하나가 종료까지 가면 안 된다 — 확인이 그 사이에 있다 (FR-BGK-3).
    const bg = await (await request.get('/api/tools/background')).json();
    expect((bg.background || []).some((b: any) => b.toolId === id)).toBe(true);

    await row.locator('.bg-no').tap();
    await expect(row.locator('.bg-kill')).toBeVisible();
  });
});
