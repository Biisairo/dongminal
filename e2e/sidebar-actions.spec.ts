import { test, expect, waitForInit } from './fixtures';

/**
 * UX_BATCH12_SRS TC-SBA-1 (FR-SBA-1) — Windows 패널의 액션 단추 셋은 같은 좌우 여백과 모양을 쓴다.
 * `#add-group` 만 그 규칙에서 빠져 패널 폭을 꽉 채우고 있었다.
 */
test('TC-SBA-1: 그룹 추가 단추의 여백·모양이 새 창 단추와 같다', async ({ page }) => {
  await waitForInit(page);
  const got = await page.evaluate(() => {
    const pick = (id: string) => {
      const el = document.getElementById(id)!, cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return { ml: cs.marginLeft, mr: cs.marginRight, h: cs.minHeight, left: Math.round(r.left), right: Math.round(r.right) };
    };
    return { win: pick('add-window'), group: pick('add-group') };
  });
  expect(got.group).toEqual(got.win);
});
