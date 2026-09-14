import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// M9_SRS FR-M9-24·25·26·27 — **보던 자리 오가기**와 UI 글자 선택.
//
// 자리는 (창, 칸, 탭) 셋이다 (D-M9-17). 커서는 이 밖이며 편집기 안의 점프는
// `_lspBack`(FR-LSP-27)이 자기 스택으로 갖는다.

/** 지금 자리. 앱이 기록하는 것과 **같은 셋**을 읽는다. */
const place = (page: Page) => page.evaluate(() => {
  const a = (window as any).app;
  return a.testing.navPlace();
});

const tabsOf = (page: Page) => page.locator('#area .pn.focused .pn-tab');

/** 탭을 하나 더 만들고 그 id 를 준다 — 자리가 둘 이상이어야 오갈 것이 생긴다. */
async function addTab(page: Page): Promise<string> {
  const before = await tabsOf(page).count();
  await page.locator('#area .pn.focused .pn-tab-add').click();
  await expect(tabsOf(page)).toHaveCount(before + 1, { timeout: 15000 });
  const p = await place(page);
  expect(p, '새 탭 뒤에 자리가 없다').not.toBeNull();
  return p.tab as string;
}

test.describe('FR-M9-24 — 보던 자리를 오간다', () => {
  test('V-M9-24a: 뒤로가 순서대로 돌아가고 앞으로가 되돌린다', async ({ page }) => {
    await waitForInit(page);
    const t1 = (await place(page)).tab as string;
    const t2 = await addTab(page);
    const t3 = await addTab(page);
    expect(new Set([t1, t2, t3]).size, '탭 셋이 서로 달라야 한다').toBe(3);

    // 뒤로 둘 — 들른 역순이다.
    await page.evaluate(() => (window as any).app.executeAction('focusBack'));
    await expect.poll(async () => (await place(page)).tab, { timeout: 10000 }).toBe(t2);
    await page.evaluate(() => (window as any).app.executeAction('focusBack'));
    await expect.poll(async () => (await place(page)).tab, { timeout: 10000 }).toBe(t1);

    // 앞으로 둘 — 되돌린다. **이것이 서지 않으면 뒤로가 새 기록을 만든 것이다.**
    await page.evaluate(() => (window as any).app.executeAction('focusForward'));
    await expect.poll(async () => (await place(page)).tab, { timeout: 10000 }).toBe(t2);
    await page.evaluate(() => (window as any).app.executeAction('focusForward'));
    await expect.poll(async () => (await place(page)).tab, { timeout: 10000 }).toBe(t3);
  });

  test('V-M9-24b: 새 자리로 가면 앞길이 사라진다', async ({ page }) => {
    await waitForInit(page);
    await addTab(page);
    const t2 = await addTab(page);
    await page.evaluate(() => (window as any).app.executeAction('focusBack'));
    await expect.poll(async () => (await page.evaluate(() =>
      (window as any).app.testing.navCounts())).fwd, { timeout: 10000 }).toBeGreaterThan(0);

    // 여기서 새 자리로 가면 앞길은 버려진다 — 브라우저 히스토리와 같은 규약이다.
    const t3 = await addTab(page);
    expect(t3).not.toBe(t2);
    expect((await page.evaluate(() => (window as any).app.testing.navCounts())).fwd).toBe(0);
  });

  test('V-M9-24c: 사라진 자리는 건너뛴다', async ({ page }) => {
    await waitForInit(page);
    const t1 = (await place(page)).tab as string;
    const t2 = await addTab(page);
    await addTab(page);

    // 가운데 자리를 지운다. 기록에는 남아 있고, 그 자리로 가려 들면 아무 일도
    // 일어나지 않은 채 기록만 준다 — 사용자에게는 "키가 안 듣는다" 로 보인다.
    await page.evaluate((id) => {
      const a = (window as any).app;
      a.closeTab(a.focused, id);
    }, t2);
    await expect(tabsOf(page)).toHaveCount(2, { timeout: 15000 });

    await page.evaluate(() => (window as any).app.executeAction('focusBack'));
    await expect.poll(async () => (await place(page)).tab, { timeout: 10000 }).toBe(t1);
  });

  test('V-M9-24d: 기록은 100 을 넘지 않는다', async ({ page }) => {
    await waitForInit(page);
    // 두 탭 사이를 왕복해 기록만 늘린다 — 탭을 100개 만들 필요가 없다.
    const t1 = (await place(page)).tab as string;
    const t2 = await addTab(page);
    await page.evaluate(({ a, b }) => {
      const app = (window as any).app;
      for (let i = 0; i < 130; i++) app.switchTab(app.focused, i % 2 ? a : b);
    }, { a: t1, b: t2 });
    const n = (await page.evaluate(() => (window as any).app.testing.navCounts())).back;
    expect(n, '상한이 듣지 않는다').toBeLessThanOrEqual(100);
    expect(n, '왕복했는데 기록이 서지 않았다').toBeGreaterThan(1);
  });
});

test.describe('FR-M9-26 — 마우스 4·5번 버튼', () => {
  // **막았는지를 직접 재는 것이 이 검사의 절반이다.** 이동만 재면 브라우저가
  // 함께 움직여도 초록이 된다 (M9_PROGRESS §2-12).
  test('V-M9-26: 버튼이 자리를 옮기고 브라우저 기본 동작을 막는다', async ({ page }) => {
    await waitForInit(page);
    const t1 = (await place(page)).tab as string;
    const t2 = await addTab(page);

    const fire = (button: number) => page.evaluate((b) => {
      const ev = new MouseEvent('mousedown', { button: b, bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, button);

    expect(await fire(3), '뒤로 버튼이 막히지 않았다').toBe(true);
    await expect.poll(async () => (await place(page)).tab, { timeout: 10000 }).toBe(t1);

    expect(await fire(4), '앞으로 버튼이 막히지 않았다').toBe(true);
    await expect.poll(async () => (await place(page)).tab, { timeout: 10000 }).toBe(t2);

    // 왼쪽 버튼은 건드리지 않는다 — 막으면 클릭이 통째로 죽는다.
    expect(await fire(0), '왼쪽 버튼까지 막았다').toBe(false);
  });
});

test.describe('FR-M9-27 — 선택은 기본이 아니라 예외다', () => {
  const selectable = (page: Page, sel: string) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return getComputedStyle(el).userSelect || (getComputedStyle(el) as any).webkitUserSelect;
  }, sel);

  test('V-M9-27: UI 는 막히고 복사가 목적인 자리는 열린다', async ({ page }) => {
    await waitForInit(page);

    // 막히는 쪽 — 껍데기.
    for (const sel of ['#sidebar', '#area .pn-tab', '#area .pn-tabs']) {
      expect(await selectable(page, sel), sel + ' 가 선택된다').toBe('none');
    }

    // **열리는 쪽이 이 검사의 요점이다** — 막는 것만 재면 다 막아도 초록이다.
    expect(await selectable(page, '#area .pn.focused .xterm'), '터미널이 막혔다').toBe('text');
  });
});
