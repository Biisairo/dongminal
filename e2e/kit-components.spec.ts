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

  /**
   * 설정 모달의 불리언 컨트롤을 전부 훑는다. **대상을 손으로 적지 않는다**
   * (FR-CMP-2) — 탭을 하나씩 열고 그 안의 `input[type=checkbox]` 를 모은다.
   */
  const TABS = ['theme', 'statusbar', 'display', 'terminal', 'code', 'notify', 'access'];
  const boolControls = async (page: Page) => {
    const out: { tab: string; id: string; w: number; h: number; kit: boolean }[] = [];
    for (const tab of TABS) {
      await page.click(`.mtab[data-tab="${tab}"]`);
      const got = await page.evaluate((t) => {
        const r: { tab: string; id: string; w: number; h: number; kit: boolean }[] = [];
        const body = document.querySelector('.modal-body');
        for (const el of Array.from(body!.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))) {
          /**
           * **반복 행 안의 체크박스는 설정이 아니다** (SRS §6-5 · §6-예외표 E-2).
           * ACL 항목 줄(`.acl-row`)과 샌드박스 마운트 줄(`.sbx-mount`)은 한 줄이
           * 하나의 레코드이고, 그 안의 표식은 "이 줄을 쓸 것인가" 라는 **필드**다 —
           * 스위치로 바꾸면 "저장되는 설정" 으로 읽힌다.
           *
           * 이 경계를 안 그어서 검사가 flaky 했다: 앞 스펙이 ACL 줄을 남기면
           * 그 줄의 체크박스가 세어져 빨개졌고, 줄이 없으면 초록이었다.
           */
          if (el.closest('.acl-row, .sbx-mount')) continue;
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height) continue;
          r.push({ tab: t, id: el.id || el.className || '(이름없음)',
            w: Math.round(b.width), h: Math.round(b.height), kit: el.classList.contains('ui-switch') });
        }
        return r;
      }, tab);
      out.push(...got);
    }
    return out;
  };

  test('TC-CMP-3: 설정 모달의 불리언 컨트롤이 한 모양이다 (FR-CMP-20·22)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });

    const all = await boolControls(page);
    expect(all.length, '불리언 컨트롤을 찾지 못했다').toBeGreaterThan(8);

    // 착수 시 세 모양이었다: 맨 네모(14×14) · 알약(36×20, `.slider` 가 그린다) ·
    // 체크박스+글자. 한 벌이면 크기가 하나다.
    const bare = all.filter((c) => !c.kit);
    expect(bare.map((c) => `${c.tab}/${c.id}`),
      `킷 스위치가 아닌 불리언:\n  ${bare.map((c) => `${c.tab}/${c.id}`).join('\n  ')}`).toEqual([]);
    const sizes = [...new Set(all.map((c) => `${c.w}x${c.h}`))];
    expect(sizes.length, `크기가 갈린다: ${sizes.join(' · ')}`).toBe(1);
    await page.keyboard.press('Escape');
  });

  test('TC-CMP-5: 스위치를 켜고 끄면 설정 값이 바뀐다 — 동작은 그대로다 (회귀)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });
    await page.click('.mtab[data-tab="display"]');

    const box = page.locator('#ds-tabfix');
    await expect(box).toBeVisible({ timeout: 5000 });
    const before = await box.isChecked();
    // 껍데기를 바꿔도 **체크박스**라 클릭·상태 읽기가 그대로여야 한다 (FR-CMP-21).
    await box.click();
    expect(await box.isChecked(), '클릭해도 상태가 바뀌지 않는다').toBe(!before);
    await box.click();
    expect(await box.isChecked()).toBe(before);
    await page.keyboard.press('Escape');
  });

  test('TC-CMP-4: 모바일에서 스위치가 44px 하한을 넘는다 (FR-CMP-23 / FR-A11Y-27)', async ({ page }) => {
    // **뷰포트만 좁히면 `body.mobile` 이 서지 않는다** — 하네스의 `mode` 가
    // 그 전환을 갖는다 (fixtures.ts:543). 첫 판이 폭만 바꿔 놓고 모바일 규칙이
    // 안 걸리는 것을 결함으로 읽었다.
    await waitForInit(page, { clearLocalStorage: true, mode: 'mobile' });
    // 모바일에서 `#settings-btn` 은 드로어 안에 있다 — 열지 않으면 닿지 않는다.
    await page.click('#m-drawer-toggle');
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });
    await page.click('.mtab[data-tab="display"]');

    const got = await page.evaluate(() => {
      const seen: string[] = [], small: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('.ui-switch'))) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const id = `${el.id || el.className} = ${Math.round(r.width)}x${Math.round(r.height)}`;
        seen.push(id);
        if (r.width < 44 || r.height < 44) small.push(id);
      }
      return { seen, small };
    });
    // **먼저 잴 것이 있는지 본다.** 없으면 아래 단정은 빈 배열끼리 견주는 일이라
    // 변경 전에도 초록이 된다 — B2 에서 두 번 겪은 부류다 (TC-KIT-6a·7).
    expect(got.seen.length, '화면에 킷 스위치가 없다 — 검사가 공회전한다').toBeGreaterThan(2);
    expect(got.small, `44px 하한을 못 넘는 스위치:\n  ${got.small.join('\n  ')}`).toEqual([]);
    await page.keyboard.press('Escape');
  });
});
