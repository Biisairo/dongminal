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

  test('TC-KIT-3: hover 가 손잡이 색을 바꾼다 — 손으로 그린 열넷이 잃고 있던 것 (D-KIT-3)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    // CSS 규칙으로 잰다 — `:hover` 의 계산값은 실제로 커서를 올려야 나오고,
    // 스크롤바 위의 hover 는 Playwright 가 흉내 낼 수 없다.
    const rules = await page.evaluate(() => {
      const out: { sel: string; bg: string }[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let list: CSSRuleList;
        try { list = sheet.cssRules } catch { continue }  // 교차 출처 시트는 읽을 수 없다
        for (const r of Array.from(list)) {
          const st = r as CSSStyleRule;
          if (!st.selectorText || !/::-webkit-scrollbar-thumb/.test(st.selectorText)) continue;
          out.push({ sel: st.selectorText, bg: st.style.getPropertyValue('background') });
        }
      }
      return out;
    });
    expect(rules.length, '스크롤바 손잡이 규칙을 읽지 못했다').toBeGreaterThan(0);

    const hover = rules.filter((r) => /:hover/.test(r.sel));
    const plain = rules.filter((r) => !/:hover/.test(r.sel));
    expect(plain.length, '손잡이 기본 규칙이 없다').toBeGreaterThan(0);
    expect(hover.length, 'hover 규칙이 없다').toBeGreaterThan(0);
    // 기본과 hover 의 색이 **달라야** 한다. 착수 시 손으로 그린 열넷은 hover 가
    // 아예 없어서 "집을 수 있다" 를 말하지 못했다.
    for (const h of hover) expect(h.bg, `${h.sel} 의 hover 색이 없다`).not.toBe('');
    expect(new Set(plain.map((r) => r.bg)).size, '손잡이 기본색이 한 벌이 아니다').toBe(1);
    expect(plain[0].bg).not.toBe(hover[0].bg);
  });

  test('TC-KIT-5: 구르는 요소 전부가 킷의 스크롤바를 받는다 — DOM 에서 파생한다 (FR-KIT-10)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    // **목록을 손으로 적지 않는다** (FR-A11Y-28 과 같은 규약). 화면에 실제로 선
    // 요소에서 구르는 것을 골라, 그것이 스크롤바를 그리는지 계산값으로 본다.
    //
    // 게이트(`check-scrollbar.mjs`)와 나누어 맡는다: 게이트는 **선언된 표면 전부**를
    // 정적으로 보고, 이 검사는 **지금 실제로 구르는 것**을 본다. 앞쪽은 화면에
    // 안 뜬 표면까지 덮고, 뒤쪽은 캐스케이드가 킷을 덮어쓴 자리를 잡는다.
    const bare = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        const cs = getComputedStyle(el);
        // **실제로 넘치는 축만 잰다.** 선언만 보면 `.pn-tabs` 처럼 `overflow-x`
        // 하나만 적은 자리가 걸린다 — CSS 규정이 한 축을 `visible` 이 아니게
        // 만들면 **다른 축의 사용값도 `auto`** 가 되기 때문이다. 화면이 답하는
        // 물음("여기 스크롤바가 떴는데 우리 것이 아니다")을 그대로 잰다.
        const rollsY = /^(auto|scroll)$/.test(cs.overflowY) && el.scrollHeight > el.clientHeight;
        const rollsX = /^(auto|scroll)$/.test(cs.overflowX) && el.scrollWidth > el.clientWidth;
        if (!rollsY && !rollsX) continue;
        // 벤더 표면은 우리 것이 아니다 (SRS §6-예외표 E-2 가 킷 선택자로 덮는다).
        if (el.closest('.xterm') || el.closest('.monaco-editor')) continue;
        // **축을 가른다.** 세로로 구르는 표면의 스크롤바는 `width`, 가로로 구르는
        // 것은 `height` 다. 둘을 섞으면 가로 스크롤바를 `height:0` 으로 숨긴 자리
        // (`.pn-tabs`·`#mobile-keybar`, E-1)가 "스크롤바 없음" 으로 잡힌다.
        const bar = getComputedStyle(el, '::-webkit-scrollbar');
        const axis = rollsY ? bar.width : bar.height;
        // `0px` 도 스크롤바를 정한 것이다 — 숨김은 겉모습이 아니라 뜻이다 (FR-KIT-8).
        if (axis && axis !== 'auto') continue;
        const id = el.id ? '#' + el.id : '';
        out.push(`${el.tagName.toLowerCase()}${id}.${Array.from(el.classList).join('.')}`);
      }
      return out;
    });
    expect(bare, `구르는데 스크롤바가 없는 요소:\n  ${bare.join('\n  ')}`).toEqual([]);
  });
});
