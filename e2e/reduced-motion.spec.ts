/**
 * 움직임 줄이기 (`UX-12` / WCAG 2.3.3 · 2.2.2).
 *
 * 착수 시 `prefers-reduced-motion` 선언은 **세 자리**뿐이었고 `animation:` 19 ·
 * `transition:` 29 중 나머지는 요청을 받지 않았다. 자리마다 손으로 적는 한 새
 * 애니메이션은 항상 덮이지 않은 채로 들어온다 — 그래서 전역으로 받는다.
 *
 * **이 검사가 재는 것은 "규칙이 있다" 가 아니라 "실제로 멎었다" 다.** 선언을
 * 세면 `@media` 블록 안에 오타가 있어도 초록이 된다.
 */
import { Page } from '@playwright/test';

import { test, expect, waitSettled } from './fixtures';

/**
 * 지금 이 페이지에서 애니메이션과 전환이 실제로 얼마나 도는지.
 *
 * 실재하는 요소를 고르지 않는 것은 **부팅 화면이 걷히면 사라지기** 때문이다 —
 * 표본이 없어지면 단정이 빈 채로 초록이 된다 (M6 §4-A-1). 대신 탐침을 하나
 * 세워 잰다: 전역 규칙이라면 방금 만든 요소에도 걸려야 한다.
 */
async function motion(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, { anim: string; iter: string; trans: string }> = {};
    // 부팅 화면은 걷히고 나면 DOM 에서 사라질 수 있다 — 대역을 하나 세워
    // **무엇이든 하나는 반드시 재도록** 한다 (M6 §4-A-1).
    const probe = document.createElement('div');
    probe.id = 'zz-motion-probe';
    probe.style.cssText = 'position:fixed;left:-9999px;animation:spin 2s linear infinite;transition:opacity 3s';
    document.body.appendChild(probe);
    for (const el of Array.from(document.querySelectorAll('#zz-motion-probe'))) {
      const cs = getComputedStyle(el);
      out[el.id || el.tagName] = {
        anim: cs.animationDuration, iter: cs.animationIterationCount, trans: cs.transitionDuration,
      };
    }
    probe.remove();
    return out;
  });
}

test.describe('움직임 줄이기 (UX-12)', () => {
  test('UX-12a: reduce 요청이 오면 애니메이션과 전환이 멎는다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await waitSettled(page);

    const m = await motion(page);
    const probe = m['zz-motion-probe'];
    expect(probe, '탐침이 재어지지 않았다 — 검사가 공회전한다').toBeTruthy();
    // `.01ms` 를 브라우저는 `0.00001s` 로 돌려준다. 초 단위로 재면 실수가 없다.
    expect(parseFloat(probe.anim)).toBeLessThan(0.01);
    expect(parseFloat(probe.trans)).toBeLessThan(0.01);
    expect(probe.iter).toBe('1');
  });

  test('UX-12b: 요청이 없으면 그대로 움직인다 (규칙이 항상 켜져 있지 않다)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await waitSettled(page);

    const m = await motion(page);
    const probe = m['zz-motion-probe'];
    expect(probe).toBeTruthy();
    expect(parseFloat(probe.anim)).toBe(2);
    expect(parseFloat(probe.trans)).toBe(3);
    expect(probe.iter).toBe('infinite');
  });

  // `UX-10` — placeholder 는 이름이 아니다.
  test('UX-10: 터미널 검색 입력이 이름을 갖는다', async ({ page }) => {
    await page.goto('/');
    await waitSettled(page);
    const name = await page.locator('#search-input').getAttribute('aria-label');
    expect(name && name.trim().length).toBeTruthy();
  });
});
