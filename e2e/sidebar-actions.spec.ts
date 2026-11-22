import { test, expect, waitForInit } from './fixtures';

/**
 * UX_BATCH12_SRS TC-SBA-1 (FR-SBA-1) — Windows 패널의 액션 단추는 같은 여백과 모양을 쓴다.
 * `#add-group` 만 그 규칙에서 빠져 패널 폭을 꽉 채우고 있었다.
 *
 * QUALITY_FIX_SRS FR-QFX-1: 단추들이 한 줄에 선다(UX_AUDIT_FIX_SRS FR-UXF-96 · D-32 개정).
 *   이전 단정: `#add-group` 의 좌우 끝이 `#add-window` 와 같다 — 두 단추가 세로로 쌓이던 때의 모양
 *   새  단정: 여백·높이가 같고, 윗변이 같고(한 줄), 줄의 왼쪽 안쪽 여백(패널 → `#add-window`)과
 *             오른쪽 안쪽 여백(`#add-group` → 패널)이 같다 — 그룹 단추가 규칙에서 빠지면 오른쪽이 갈린다
 */
test('TC-SBA-1: 그룹 추가 단추의 여백·모양이 새 창 단추와 같다', async ({ page }) => {
  await waitForInit(page);
  const got = await page.evaluate(() => {
    const pick = (id: string) => {
      const el = document.getElementById(id)!, cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return { ml: cs.marginLeft, mr: cs.marginRight, h: cs.minHeight, top: Math.round(r.top), left: r.left, right: r.right };
    };
    const panel = document.getElementById('sb-panel-windows')!.getBoundingClientRect();
    return { win: pick('add-window'), group: pick('add-group'), panel: { left: panel.left, right: panel.right } };
  });
  const shape = (b: typeof got.win) => ({ ml: b.ml, mr: b.mr, h: b.h, top: b.top });
  expect(shape(got.group)).toEqual(shape(got.win));
  const insetL = Math.round(got.win.left - got.panel.left);
  const insetR = Math.round(got.panel.right - got.group.right);
  expect(insetL, '단추 줄의 왼쪽 안쪽 여백이 없다').toBeGreaterThan(0);
  expect(insetR, `오른쪽 안쪽 여백 ${insetR} ≠ 왼쪽 ${insetL}`).toBe(insetL);
});
