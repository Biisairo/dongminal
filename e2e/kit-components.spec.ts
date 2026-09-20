/**
 * KIT_COMPONENTS_SRS §5 — 킷에 없던 것을 세우고 옮긴 결과 (묶음 B3).
 *
 * 게이트·단위 검사와 나누어 맡는다: 앞쪽은 **소스**를 정적으로 보고, 여기는
 * **화면에 실제로 선 것**을 본다 — 킷은 `<link>` 순서상 먼저 오므로(FR-UIK-1)
 * 옛 규칙이 이기고 남아 있으면 클래스만 붙고 아무것도 수렴하지 않는다.
 */
import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/** 설정 모달의 한 탭을 연다. */
async function openSettings(page: Page, tab: string) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });
  await page.click(`.mtab[data-tab="${tab}"]`);
}

test.describe('킷 컴포넌트 (KIT_COMPONENTS_SRS)', () => {
  test('TC-CMP-1: 키캡이 킷의 것이고 버튼 등급을 달지 않는다 (FR-CMP-11 / D-KIT-1)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await openSettings(page, 'shortcuts');
    await expect(page.locator('.sc-key').first()).toBeVisible({ timeout: 10000 });

    const keys = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.sc-key'))
      .map((el) => {
        const cs = getComputedStyle(el);
        return {
          cls: Array.from(el.classList).join(' '),
          h: Math.round(el.getBoundingClientRect().height),
          bg: cs.backgroundColor,
        };
      }));
    expect(keys.length, '키캡을 찾지 못했다').toBeGreaterThan(10);

    const bad = keys.filter((k) => !/\bui-key\b/.test(k.cls) || /\bui-btn/.test(k.cls));
    expect(bad.map((k) => k.cls), '키캡이 킷의 것이 아니거나 버튼 등급을 달았다').toEqual([]);
    // 높이·배경이 한 벌이다 — 옛 `padding:3px 10px` 이 남아 있으면 높이가 갈린다.
    expect(new Set(keys.map((k) => k.h)).size, `높이가 갈린다: ${[...new Set(keys.map((k) => k.h))].join('/')}`).toBe(1);
    expect(new Set(keys.map((k) => k.bg)).size, '배경이 갈린다').toBe(1);
    await page.keyboard.press('Escape');
  });

  test('TC-CMP-2: 키캡은 표시이지만 포커스 링은 받는다 (FR-CMP-12 / WCAG 2.4.7)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await openSettings(page, 'shortcuts');
    await expect(page.locator('.sc-key').first()).toBeVisible({ timeout: 10000 });

    // 시트에서 링 규칙을 모아 `matches` 로 묻는다 — `:focus-visible` 은 의사클래스라
    // `getComputedStyle(el, ':focus-visible')` 이 빈 문자열을 돌려준다 (TC-KIT-9 의 교훈).
    const noRing = await page.evaluate(() => {
      const rules: { base: string; on: boolean }[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let list: CSSRuleList;
        try { list = sheet.cssRules } catch { continue }
        for (const r of Array.from(list)) {
          const st = r as CSSStyleRule;
          if (!st.selectorText || !/:focus-visible/.test(st.selectorText)) continue;
          const o = st.style.getPropertyValue('outline');
          if (!o) continue;
          for (const one of st.selectorText.split(',')) {
            rules.push({ base: one.trim().replace(/:focus-visible/g, ''), on: !/none|^0/.test(o) });
          }
        }
      }
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('.sc-key'))) {
        const has = rules.some((r) => { try { return el.matches(r.base) && r.on } catch { return false } });
        if (!has) out.push(Array.from(el.classList).join(' '));
      }
      return out;
    });
    expect(noRing, '포커스 링을 그리는 규칙이 없는 키캡').toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('TC-CMP-7: 머리글이 원문 그대로 뜬다 — 대문자로 변형되지 않는다 (FR-CMP-31)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    /**
     * CSS 를 읽는 단위 검사(TC-CMP-6)와 **다른 것을 묻는다**: 저쪽은 "선언이
     * 없는가", 여기는 "화면의 글자가 실제로 변형되지 않는가" 다. 캐스케이드가
     * 어딘가에서 다시 걸면 저쪽은 초록이고 여기가 빨개진다.
     */
    const bad = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        if (el.closest('.xterm') || el.closest('.monaco-editor')) continue;
        const tt = getComputedStyle(el).textTransform;
        if (tt === 'uppercase') {
          const cls = Array.from(el.classList).join('.');
          out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`);
        }
      }
      return [...new Set(out)];
    });
    expect(bad, `대문자로 변형되는 요소:\n  ${bad.join('\n  ')}`).toEqual([]);
  });
});
