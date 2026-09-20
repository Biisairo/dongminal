/**
 * KIT_APPLICATION_SRS §5 — 스크롤바가 킷의 것인가 (묶음 A·B·C).
 *
 * 재는 것은 클래스가 아니라 **계산값**이다. 이름만 보면 `.ui-scroll` 을 붙이고
 * 옛 규칙이 그것을 덮은 채로 통과할 수 있다 — `a11y-dialog.spec.ts` 의
 * TC-TOK-21 이 모달 골격에서 같은 이유로 계산값을 본다.
 *
 * `::-webkit-scrollbar` 는 의사요소이므로 `getComputedStyle(el, pseudo)` 로
 * 읽는다. Chromium 에서만 뜻이 있고, 이 저장소의 e2e 는 Chromium 하나다.
 */
import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * 킷 모달을 열고 `.ui-modal-body` 를 남긴다. 골격 일곱 중 `.ui-modal-body` 를
 * 갖는 것은 `UIKit.modal` 하나다 (나머지 여섯은 자기 본문 이름을 쓴다).
 *
 * `UIKit` 은 클래식 스크립트의 최상위 `const` 라 `window` 에 없다 — 전역 렉시컬
 * 스코프에서 읽는다 (TC-TOK-21 이 같은 이유로 `new Function` 을 쓴다).
 */
const openKitModal = (page: Page) => page.evaluate(() => {
  const K = new Function('return UIKit')();
  // 본문이 넘치게 만든다 — 스크롤 표면이 실제로 구르는 상태에서 재야 한다.
  const body = document.createElement('div');
  body.style.cssText = 'height:2000px';
  const m = K.modal({ title: '스크롤 검사', cls: 'kit-scroll-probe', body, actions: [{ label: '닫기', kind: 'primary' }] });
  document.body.appendChild(m.el);
});

/** 의사요소의 계산값. 토큰은 같은 방법(임시 요소에 칠해 읽기)으로 견준다. */
const scrollbarOf = (page: Page, sel: string) => page.evaluate((s) => {
  const el = document.querySelector(s) as HTMLElement | null;
  if (!el) return null;
  const bar = getComputedStyle(el, '::-webkit-scrollbar');
  const thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb');
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--text-dim);background:var(--border)';
  document.body.appendChild(probe);
  const pcs = getComputedStyle(probe);
  const textDim = pcs.color, border = pcs.backgroundColor;
  probe.remove();
  return {
    width: bar.width,
    thumbBg: thumb.backgroundColor,
    textDim, border,
    scrolls: el.scrollHeight > el.clientHeight,
  };
}, sel);

test.describe('킷의 스크롤바 (KIT_APPLICATION_SRS)', () => {
  test('TC-KIT-1: .ui-modal-body 가 킷의 스크롤바를 그린다 (FR-KIT-1)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await openKitModal(page);
    await expect(page.locator('.ui-modal.kit-scroll-probe .ui-modal-body')).toBeVisible({ timeout: 10000 });

    const s = await scrollbarOf(page, '.ui-modal.kit-scroll-probe .ui-modal-body');
    expect(s, '.ui-modal-body 를 찾지 못했다').not.toBeNull();
    // 전제 — 실제로 구르는 표면이어야 잰 값에 뜻이 있다.
    expect(s!.scrolls, '본문이 넘치지 않아 스크롤 표면이 아니다').toBe(true);

    // 착수 시 이 셋이 전부 빨갛다: 킷의 `.ui-modal-body` 는 스크롤바를 안 그린다.
    // 그것이 대체하는 옛 `.modal-body` 는 그린다 — 이주가 회귀를 만든다 (§2.2).
    const bad: string[] = [];
    if (s!.width !== '8px') bad.push(`폭 ${s!.width} ≠ 8px`);
    if (s!.thumbBg !== s!.textDim) bad.push(`손잡이 ${s!.thumbBg} ≠ --text-dim ${s!.textDim}`);
    // 색이 `--border` 면 손으로 그린 열넷 쪽으로 붙은 것이다 (D-KIT-3).
    if (s!.thumbBg === s!.border) bad.push(`손잡이가 --border 다 — 킷은 --text-dim 을 쓴다`);
    expect(bad).toEqual([]);

    await page.keyboard.press('Escape');
  });
});
