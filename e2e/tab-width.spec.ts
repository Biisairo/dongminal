import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled } from './fixtures';

/**
 * TAB_WIDTH_SRS — 탭 너비 고정 (FR-TBW-1~11).
 *
 * 접수한 말은 "탭 이름표의 크기는 탭의 이름에 따라 너비가 달라지잖아. 이거 고정하는
 * 옵션" 이다. 그래서 이 파일이 재는 것은 **폭이 이름과 무관해지는가** 하나이며,
 * 나머지 요구는 그것을 쓸 만하게 만드는 조건이다 (하한·툴팁·저장).
 *
 * VSCode 의 `fixed` 와 **다르다** (D-2): 자리가 모자라도 줄어들지 않고 스크롤한다.
 * 인터뷰에서 확정한 바이며, 그래서 폭 단정에 "줄어들었을 수도" 라는 여지가 없다.
 */

const TABS = '#area .pn-tabs';
const TAB = TABS + ' .pn-tab';

/** 이름 길이가 크게 다른 탭 셋을 만든다 — 폭이 이름을 따르는지 보려면 그래야 한다. */
async function makeTabs(page: Page) {
  await page.evaluate(async () => {
    const a = (window as any).app;
    const pane = a.focused;
    for (let i = 0; i < 3; i++) await a.addTab(pane, 'terminal');
    // 이름은 **탭 목록에 직접** 박는다 — 파생 이름(FR-TAN-*)에 기대면 이 시험이
    // 그 규칙까지 딛게 된다. `findPane` 은 전역이다 (helpers.js:427).
    const s = a._aw();
    const pn = (window as any).findPane(s.layout, pane);
    const names = ['a', 'a very long tab name indeed', 'mid'];
    pn.tabs.slice(-3).forEach((t: any, i: number) => {
      t.name = names[i]; t.nameSource = 'manual';
    });
    a.render();
  });
  await expect(page.locator(TAB)).not.toHaveCount(0, { timeout: 10000 });
}

const widths = (page: Page) =>
  page.locator(TAB).evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().width)));

async function setFixed(page: Page, on: boolean, px?: number) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toHaveClass(/open/, { timeout: 10000 });
  await page.click('.mtab[data-tab="display"]');
  const cb = page.locator('#ds-tabfix');
  await expect(cb).toBeVisible({ timeout: 10000 });
  if ((await cb.isChecked()) !== on) await cb.click();
  if (px !== undefined) {
    const num = page.locator('#ds-tabw');
    await num.fill(String(px));
    await num.blur();
  }
  await page.click('#modal-close');
  await expect(page.locator('#modal-overlay')).not.toHaveClass(/open/, { timeout: 10000 });
}

test.describe('탭 너비 고정 (FR-TBW-1~11)', () => {
  test('W1 (V-TBW-1 / FR-TBW-1·9): 기본은 꺼짐이고, 그때 폭은 이름을 따른다',
    async ({ page }) => {
      await waitForInit(page);
      await makeTabs(page);

      // 켜지 않은 상태의 동작은 지금과 같다 — 이름이 다르면 폭도 다르다.
      const w = await widths(page);
      expect(w.length, '탭이 부족해 비교할 수 없다').toBeGreaterThanOrEqual(2);
      expect(new Set(w).size, '기본 상태인데 폭이 전부 같다: ' + JSON.stringify(w))
        .toBeGreaterThan(1);
    });

  /** FR-TBW-5 의 본체 — 이 시험 하나가 접수한 말 그 자체다. */
  test('W2 (V-TBW-2 / FR-TBW-5): 켜면 이름이 달라도 폭이 같다', async ({ page }) => {
    await waitForInit(page);
    await makeTabs(page);
    await setFixed(page, true, 160);

    const w = await widths(page);
    expect(new Set(w), '폭이 탭마다 다르다: ' + JSON.stringify(w)).toHaveProperty('size', 1);
    expect(w[0]).toBe(160);
  });

  test('W3 (V-TBW-3 / FR-TBW-2·10): 폭을 바꾸면 새로고침 없이 반영된다',
    async ({ page }) => {
      await waitForInit(page);
      await makeTabs(page);
      await setFixed(page, true, 160);
      expect((await widths(page))[0]).toBe(160);

      await setFixed(page, true, 90);
      const w = await widths(page);
      expect(new Set(w).size).toBe(1);
      expect(w[0]).toBe(90);
    });

  test('W4 (V-TBW-4 / FR-TBW-3·4): 범위를 벗어난 값은 잘린다', async ({ page }) => {
    await waitForInit(page);
    await makeTabs(page);

    // 하한 미만 — 닫기(×)가 들어갈 자리가 없어지는 폭이다 (D-3).
    await setFixed(page, true, 5);
    expect((await widths(page))[0]).toBe(40);

    // 상한 초과.
    await setFixed(page, true, 9999);
    expect((await widths(page))[0]).toBe(480);
  });

  test('W5 (V-TBW-5 / FR-TBW-6): 잘린 이름은 툴팁이 밝힌다', async ({ page }) => {
    await waitForInit(page);
    await makeTabs(page);
    await setFixed(page, true, 60);

    // 긴 이름의 탭을 찾아 그 title 이 전체 이름인지 본다 — 말줄임만 있고 읽을
    // 길이 없으면 고정 폭이 이름을 지우는 기능이 된다.
    const long = page.locator(TAB).filter({ hasText: 'a very long' }).first();
    await expect(long).toHaveAttribute('title', /a very long tab name indeed/, { timeout: 10000 });
    // 실제로 잘렸는지도 확인한다 — 안 잘렸으면 이 시험이 뜻을 잃는다.
    const cut = await long.locator('.pn-tab-label')
      .evaluate((e) => e.scrollWidth > e.clientWidth);
    expect(cut, '60px 인데 이름이 잘리지 않았다').toBeTruthy();
  });

  test('W6 (V-TBW-6 / FR-TBW-7): 탭이 많아도 폭이 유지되고 줄이 스크롤한다',
    async ({ page }) => {
      await waitForInit(page);
      await makeTabs(page);
      await setFixed(page, true, 160);
      // 줄이 넘칠 만큼 늘린다.
      await page.evaluate(async () => {
        const a = (window as any).app;
        for (let i = 0; i < 12; i++) await a.addTab(a.focused, 'terminal');
        a.render();
      });
      await expect.poll(() => page.locator(TAB).count(), { timeout: 15000 })
        .toBeGreaterThan(10);

      // D-2: 줄어들지 않는다 — VSCode 의 `fixed` 와 갈리는 자리다.
      const w = await widths(page);
      expect(new Set(w), '자리가 모자라자 폭이 줄었다: ' + JSON.stringify(w))
        .toHaveProperty('size', 1);
      expect(w[0]).toBe(160);
      // 대신 줄이 스크롤한다.
      const over = await page.locator(TABS)
        .evaluate((e) => e.scrollWidth > e.clientWidth + 1);
      expect(over, '넘쳤는데 스크롤할 것이 없다').toBeTruthy();
    });

  test('W7 (V-TBW-7 / FR-TBW-8): 새로고침해도 남는다', async ({ page }) => {
    await waitForInit(page);
    await makeTabs(page);
    await setFixed(page, true, 120);
    expect((await widths(page))[0]).toBe(120);

    // 설정의 저장이 서버에 닿은 뒤에 새로고침한다 (FR-EQS-*). 저장은 디바운스를
    // 지나므로, 느린 기계에서는 그것이 날기 전에 문서가 다시 열려 값이 사라진다
    // (러너에서 실측: 폭 넷이 제각각으로 돌아왔다).
    await waitSettled(page);
    await page.reload();
    await waitForInit(page);
    await expect(page.locator(TAB).first()).toBeVisible({ timeout: 15000 });
    // R3: `_saveSettings` 목록에서 빠지면 여기서 드러난다.
    const w = await widths(page);
    expect(new Set(w).size).toBe(1);
    expect(w[0]).toBe(120);
  });

  test('W8 (V-TBW-8 / FR-TBW-11 · NFR-TBW-1): `+` 는 대상이 아니고, 인라인 폭을 쓰지 않는다',
    async ({ page }) => {
      await waitForInit(page);
      await makeTabs(page);
      await setFixed(page, true, 160);

      const add = page.locator(TABS + ' .pn-tab-add');
      if (await add.count()) {
        const aw = await add.first().evaluate((e) => Math.round(e.getBoundingClientRect().width));
        expect(aw, '`+` 가 탭 폭을 받았다').toBeLessThan(160);
      }
      // NFR-TBW-1: 폭은 CSS 변수 하나로 간다 — 탭마다 인라인 스타일을 쓰지 않는다.
      const inline = await page.locator(TAB).evaluateAll(
        (els) => els.filter((e) => (e as HTMLElement).style.width !== '').length);
      expect(inline, '탭에 인라인 width 가 붙었다').toBe(0);
    });
});
