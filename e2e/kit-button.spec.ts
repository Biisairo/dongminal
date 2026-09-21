/**
 * KIT_APPLICATION_SRS §5 — 버튼이 킷 등급을 받았는가 (묶음 D·E).
 *
 * 게이트(`check-button-kit.mjs`)와 **나누어 맡는다**: 게이트는 소스의 *만드는
 * 자리*를 정적으로 세고, 이 스펙은 **화면에 실제로 선 버튼**을 본다. 앞쪽은
 * 화면에 안 뜬 자리까지 덮고, 뒤쪽은 캐스케이드가 킷을 덮어쓴 자리를 잡는다 —
 * 킷은 `<link>` 순서상 **먼저** 오므로(FR-UIK-1) 옛 규칙이 이기고 남아 있으면
 * 클래스만 붙고 아무것도 수렴하지 않는다.
 */
import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/** 화면의 모든 `<button>` 을 훑어 킷 등급·포커스 링·크기를 함께 돌려준다. */
const buttons = (page: Page) => page.evaluate(() => {
  const KIT = /\bui-(?:btn|tab)\b/;
  const out: { sel: string; kit: boolean; h: number; ring: string }[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button'))) {
    // 벤더 표면은 우리 것이 아니다.
    if (el.closest('.xterm') || el.closest('.monaco-editor')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;   // 안 보이는 것은 재지 않는다
    const cls = Array.from(el.classList);
    out.push({
      sel: el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : ''),
      kit: KIT.test(cls.join(' ')),
      h: Math.round(r.height),
      ring: ring(el),
    });
  }
  return out;

  /**
   * **`:focus-visible` 은 의사클래스다** — `getComputedStyle(el, ':focus-visible')`
   * 은 빈 문자열을 돌려주고, 그것을 값으로 읽으면 검사가 아무것도 재지 않는다
   * (첫 판이 그렇게 전부 빨갰다). 대신 시트에서 링을 그리는 규칙을 모아
   * **그 요소가 실제로 걸리는지** `matches` 로 본다 — `check-focus.mjs` 와 같은
   * 물음이되 캐스케이드가 살아 있는 자리에서 묻는다.
   */
  function ring(el: HTMLElement): string {
    for (const { base, style } of rules()) {
      try { if (!el.matches(base)) continue } catch { continue }
      if (style !== 'none') return style;
    }
    return 'none';
  }
  function rules() {
    const w = window as any;
    if (w.__ringRules) return w.__ringRules as { base: string; style: string }[];
    const out: { base: string; style: string }[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let list: CSSRuleList;
      try { list = sheet.cssRules } catch { continue }
      for (const r of Array.from(list)) {
        const st = r as CSSStyleRule;
        if (!st.selectorText || !/:focus-visible/.test(st.selectorText)) continue;
        const o = st.style.getPropertyValue('outline');
        if (!o) continue;
        for (const one of st.selectorText.split(',')) {
          out.push({ base: one.trim().replace(/:focus-visible/g, ''), style: /none|^0/.test(o) ? 'none' : 'solid' });
        }
      }
    }
    w.__ringRules = out;
    return out;
  }
});

/** 킷이 정한 높이 세 눈금. 배율 1 에서 22 · 26 · 30 이다. */
const GRADES = [22, 26, 30];

test.describe('킷 등급을 받은 버튼 (KIT_APPLICATION_SRS)', () => {
  test('TC-KIT-6: 화면의 버튼이 전부 킷 등급을 갖는다 — DOM 에서 파생한다 (FR-KIT-14·14a)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    // 설정 모달을 열어 탭 열둘(`.mtab`)까지 화면에 세운다.
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });

    const all = await buttons(page);
    expect(all.length, '버튼을 찾지 못했다').toBeGreaterThan(20);
    // §6-예외표: 키캡(B3) · 스위치(B3) · 글자 토글(§7.4 판정).
    const EXEMPT = /\b(?:sc-key|fe-find-opt)\b/;
    const bare = all.filter((b) => !b.kit && !EXEMPT.test(b.sel) && !/role/.test(b.sel));
    expect(bare.map((b) => b.sel), `킷 등급이 없는 버튼:\n  ${bare.map((b) => b.sel).join('\n  ')}`).toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('TC-KIT-6a: 킷 등급의 높이가 세 눈금으로 수렴한다 — 옛 규칙이 킷을 덮지 않는다 (FR-KIT-18b)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });

    // **킷 등급인 것만 거르지 않는다.** 그러면 등급을 못 받은 버튼이 검사에서
    // 빠져 나가고, 검사는 "이미 킷인 것이 킷이다" 만 확인한다 (첫 판이 그랬다).
    const EXEMPT = /\b(?:sc-key|fe-find-opt)\b/;
    const all = (await buttons(page)).filter((b) => !EXEMPT.test(b.sel) && !/ui-tab\b/.test(b.sel));
    /**
     * **표본이 있는가**만 묻는 줄이다 — 계약이 아니라 전제다. 수를 세는 것이
     * 아니므로 화면의 버튼이 늘거나 줄어도 이 검사의 뜻은 바뀌지 않는다.
     *
     * 하한을 10 에서 내린다: `UIUX_OVERHAUL_SRS` FR-CHR-1 이 `#topbar` 를
     * 해체하면서 기본 화면의 버튼이 줄어 실측 **9** 가 됐다. 준 것은 **대상**이지
     * 킷의 적용 범위가 아니다 — 남은 아홉은 여전히 전수 검사를 받는다.
     */
    expect(all.length, '버튼을 찾지 못했다').toBeGreaterThan(5);
    // 클래스만 붙고 옛 `padding`·`height` 가 남아 있으면 여기서 드러난다.
    const off = all.filter((b) => !GRADES.includes(b.h));
    expect(off.map((b) => `${b.sel} = ${b.h}px`),
      `킷 눈금(${GRADES.join('/')}px)을 벗어난 버튼:\n  ${off.map((b) => `${b.sel} = ${b.h}px`).join('\n  ')}`).toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('TC-KIT-9: 화면의 버튼이 전부 포커스 링을 그린다 (FR-KIT-19 / WCAG 2.4.7)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });

    const all = await buttons(page);
    // 착수 시 링을 그리는 규칙은 여섯뿐이었고(§2.4) 나머지는 UA 기본에 기대고
    // 있었다 — UA 기본은 테마를 따르지 않으므로 54종 중 어디선가 안 보인다.
    const noRing = all.filter((b) => b.ring === 'none');
    expect(noRing.map((b) => b.sel), `포커스 링을 그리는 규칙이 없는 버튼:\n  ${noRing.map((b) => b.sel).join('\n  ')}`).toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('TC-KIT-8: 모바일에서 킷 버튼이 44px 하한을 넘는다 (FR-KIT-15 / FR-A11Y-27 회귀)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForInit(page, { clearLocalStorage: true });
    const small = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('.mkb-btn'))) {
        const r = el.getBoundingClientRect();
        if (r.height && r.height < 44) out.push(`${el.textContent} = ${Math.round(r.height)}px`);
      }
      return out;
    });
    expect(small, `44px 하한을 못 넘는 키바 버튼:\n  ${small.join('\n  ')}`).toEqual([]);
  });
});
