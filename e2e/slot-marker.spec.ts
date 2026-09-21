import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// 칸 마커 — SLOT_MARKER_SRS §5 TC-SMK-*
//
// 마커가 답하는 물음은 하나다 — **"지금 어느 칸이 포커스인가"**. 사이드바에서
// 창을 여는 모든 경로가 포커스 칸으로 가므로(WINDOW_SLOTS_SRS FR-WSL-54), 그
// 물음의 답이 곧 "누르면 어디가 열리는가" 다.
//
// 마커는 **칸**을 재지 창을 재지 않는다 (FR-SMK-8). 그래서 창의 유무·이름·타입은
// 이 스펙의 검증 대상이 아니다 — 그것은 칸 머리글이 말한다 (FR-STB-12).

const marker = (page: Page) => page.locator('#slot-marker');
const cells = (page: Page) => page.locator('#slot-marker .slot-marker-cell');
const cell = (page: Page, i: number) =>
  page.locator(`#slot-marker .slot-marker-cell[data-slot="${i}"]`);

const slotCount = (page: Page) => page.evaluate(() => (window as any).app.slotCount());
const slotFocused = (page: Page) => page.evaluate(() => (window as any).app.slotFocused());
const slotAdd = (page: Page) => page.evaluate(() => (window as any).app.slotAdd());
const slotRemove = (page: Page) => page.evaluate(() => (window as any).app.slotRemove());
const focusSlot = (page: Page, i: number) =>
  page.evaluate((n) => (window as any).app.slotFocusTo(n), i);
const setSlotDir = (page: Page, d: string) =>
  page.evaluate((v) => ((window as any).app.slotDir = v), d);

/** 칸을 n 개로 벌린다. 칸 0 에 포커스를 두고 끝낸다 — 시작점을 한 곳으로 모은다. */
async function slotsTo(page: Page, n: number) {
  while ((await slotCount(page)) < n) await slotAdd(page);
  await focusSlot(page, 0);
  await expect(cells(page)).toHaveCount(n, { timeout: 10000 });
}

/** 사각형의 계산된 배경색. 채움과 빔을 눈으로 가르는 값이다. */
const bgOf = (page: Page, i: number) =>
  cell(page, i).evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe('마커가 서는 조건 (FR-SMK-2·9)', () => {
  test('TC-SMK-1: 칸이 1개면 마커가 보이지 않는다', async ({ page }) => {
    await waitForInit(page);
    expect(await slotCount(page)).toBe(1);
    await expect(marker(page)).toBeHidden();
  });

  test('TC-SMK-2: 칸을 2개로 늘리면 마커가 서고 사각형이 2개다', async ({ page }) => {
    await waitForInit(page);
    await slotAdd(page);
    await expect(marker(page)).toBeVisible({ timeout: 10000 });
    await expect(cells(page)).toHaveCount(2);
  });

  test('TC-SMK-3: 칸 수를 따라간다 — 4개까지 늘렸다 1개로 줄이면 사라진다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 4);
    await expect(cells(page)).toHaveCount(4);

    while ((await slotCount(page)) > 1) await slotRemove(page);
    await expect(marker(page)).toBeHidden({ timeout: 10000 });
  });

  test('TC-SMK-4: data-slot 이 왼쪽부터 0,1,2,3 이다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 4);
    const order = await cells(page).evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.slot));
    expect(order).toEqual(['0', '1', '2', '3']);
  });

  test('TC-SMK-12: 모바일에는 칸이 없다 — 마커도 없다', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile' });
    await expect(marker(page)).toBeHidden();
  });
});

test.describe('무엇을 그리는가 (FR-SMK-4·5·6·8)', () => {
  test('TC-SMK-5: 포커스 칸만 aria-current 이고, 옮기면 따라간다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 3);
    await expect(cell(page, 0)).toHaveAttribute('aria-current', 'true');
    await expect(cell(page, 1)).not.toHaveAttribute('aria-current', 'true');

    await focusSlot(page, 2);
    await expect(cell(page, 2)).toHaveAttribute('aria-current', 'true', { timeout: 10000 });
    await expect(cell(page, 0)).not.toHaveAttribute('aria-current', 'true');
  });

  test('TC-SMK-16: 채움과 빔이 눈으로 갈린다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 2);
    expect(await bgOf(page, 0)).not.toBe(await bgOf(page, 1));
  });

  test('TC-SMK-6: 세로 분할이어도 사각형은 가로로 늘어선다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 3);
    await setSlotDir(page, 'vertical');
    await expect(page.locator('#area[data-slotdir="vertical"]')).toHaveCount(1, { timeout: 10000 });

    const boxes = await cells(page).evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y })));
    expect(boxes).toHaveLength(3);
    // 같은 줄에 선다 — y 가 모두 같다.
    expect(boxes[1].y).toBeCloseTo(boxes[0].y, 1);
    expect(boxes[2].y).toBeCloseTo(boxes[0].y, 1);
    // 인덱스 순으로 오른쪽으로 간다.
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
    expect(boxes[2].x).toBeGreaterThan(boxes[1].x);
  });

  test('TC-SMK-7: 칸 폭을 벌려도 사각형 폭은 균등하다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 2);
    await page.evaluate(() => {
      const app = (window as any).app;
      app.slots.sizes[0] = 3;
      app.slots.sizes[1] = 1;
      app.slotApplySizes();
    });
    const widths = await cells(page).evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect().width));
    expect(widths[1]).toBeCloseTo(widths[0], 1);
  });

  test('TC-SMK-10: 빈 칸도 같은 모양이다 — 마커는 칸을 재지 창을 재지 않는다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 3);
    const win = await page.evaluate(() => (window as any).app.slots.windows[1]);
    await page.evaluate((id) => (window as any).app.delWindow(id), win);
    await expect(page.locator('#area .slot[data-slot="1"].slot-empty')).toHaveCount(1, {
      timeout: 10000,
    });
    await focusSlot(page, 0);

    // 칸은 남았으므로 사각형도 남는다 (FR-WSL-6).
    await expect(cells(page)).toHaveCount(3);
    // 빈 칸(1)과 창이 있는 비포커스 칸(2)이 **같은 모양**이다.
    expect(await bgOf(page, 1)).toBe(await bgOf(page, 2));
    await expect(cell(page, 1)).not.toHaveAttribute('aria-current', 'true');
  });
});

test.describe('누르면 칸이 옮겨간다 (FR-SMK-10·11)', () => {
  test('TC-SMK-8: 사각형을 누르면 그 칸이 포커스가 된다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 3);

    await cell(page, 1).click();
    await expect(page.locator('#area .slot[data-slot="1"].slot-focused')).toHaveCount(1, {
      timeout: 10000,
    });
    expect(await slotFocused(page)).toBe(1);
    await expect(cell(page, 1)).toHaveAttribute('aria-current', 'true');
  });

  // `deferRender` 경로는 `render()` 를 미루고 `_slotPaintFocus()` 만 돈다
  // (pane 을 눌러 칸을 옮길 때가 그렇다 — `renderer-pane.js:590`). 그 자리에서
  // 마커를 칠하지 않으면 포커스를 말하는 두 자리가 서로 다른 말을 한다.
  test('TC-SMK-17: 화면 쪽에서 칸을 옮겨도 마커가 따라간다 (deferRender)', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 3);
    await page.evaluate(() => (window as any).app.slotFocusTo(2, { deferRender: true }));

    await expect(cell(page, 2)).toHaveAttribute('aria-current', 'true', { timeout: 10000 });
    await expect(cell(page, 0)).not.toHaveAttribute('aria-current', 'true');
  });

  test('TC-SMK-9: 포커스 칸을 눌러도 아무 일이 없다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 2);

    await cell(page, 0).click();
    expect(await slotFocused(page)).toBe(0);
    await expect(cell(page, 0)).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('이웃을 건드리지 않는다 (FR-SMK-22·32)', () => {
  test('TC-SMK-13: 칸이 여럿이어도 창 이름 자리는 종전대로 빈다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 2);
    await expect(page.locator('#window-name')).toHaveText('', { timeout: 10000 });
  });

  test('TC-SMK-14: 마커가 서도 상단바 높이가 그대로다', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#topbar').evaluate((el) => el.getBoundingClientRect().height);

    await slotsTo(page, 4);
    await expect(marker(page)).toBeVisible();
    const after = await page.locator('#topbar').evaluate((el) => el.getBoundingClientRect().height);
    expect(after).toBeCloseTo(before, 1);
  });

  test('TC-SMK-11: 사각형에 이름이 있다', async ({ page }) => {
    await waitForInit(page);
    await slotsTo(page, 2);
    const labels = await cells(page).evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label') || ''));
    expect(labels).toHaveLength(2);
    for (const l of labels) expect(l.trim()).not.toBe('');
  });
});
