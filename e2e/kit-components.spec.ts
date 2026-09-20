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

  /** 모달 넷: 이름 · 여는 법 · 상자 · 머리 · 닫는 법. */
  const MODALS = [
    { name: '설정', box: '#modal', head: '.modal-header', open: async (p: Page) => { await p.click('#settings-btn') } },
    { name: 'Runs', box: '#runs-modal .runs-box', head: '#runs-modal .runs-head', open: async (p: Page) => { await p.click('#runs-btn') } },
    { name: '백그라운드', box: '#bg-modal .bg-box', head: '#bg-modal .bg-head', open: async (p: Page) => { await p.click('#bg-btn') } },
  ];

  test('TC-CMP-16: 모달마다 닫기 X 가 머리글 오른쪽에 있다 (FR-CMP-82)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const bad: string[] = [];
    for (const m of MODALS) {
      await m.open(page);
      await expect(page.locator(m.box), `${m.name} 이 열리지 않았다`).toBeVisible({ timeout: 10000 });
      const s = await page.evaluate(([box, head]) => {
        const h = document.querySelector(head) as HTMLElement | null;
        if (!h) return { found: false, right: false };
        // 닫기는 **머리글 안**에 있고 **오른쪽 끝**이다 — 모달마다 찾는 자리가
        // 다르면 사용자는 닫는 법을 모달마다 다시 배운다.
        const x = h.querySelector('.ui-btn-icon');
        if (!x) return { found: false, right: false };
        const hr = h.getBoundingClientRect(), xr = (x as HTMLElement).getBoundingClientRect();
        return { found: true, right: hr.right - xr.right < 24 };
      }, [m.box, m.head]);
      if (!s.found) bad.push(`${m.name}: 머리글에 닫기 X 가 없다`);
      else if (!s.right) bad.push(`${m.name}: 닫기 X 가 오른쪽 끝이 아니다`);
      await page.keyboard.press('Escape');
      await expect(page.locator(m.box)).toBeHidden({ timeout: 5000 });
    }
    expect(bad).toEqual([]);
  });

  test('TC-CMP-18: 제목에 수가 없고 배지가 그 옆에 선다 (FR-CMP-80·81)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    const bad: string[] = [];
    for (const m of MODALS.slice(1)) {   // 수를 세는 둘 — Runs · 백그라운드
      await m.open(page);
      await expect(page.locator(m.box)).toBeVisible({ timeout: 10000 });
      const s = await page.evaluate((head) => {
        const h = document.querySelector(head) as HTMLElement | null;
        if (!h) return null;
        const badge = h.querySelector('.ui-badge');
        const title = h.querySelector('.ui-modal-title, .runs-head-t, .bg-head-t');
        return { text: (title ? title.textContent : h.textContent) || '', badge: badge ? badge.textContent : null };
      }, m.head);
      expect(s, `${m.name}: 머리글을 찾지 못했다`).not.toBeNull();
      // 0 일 때 "Run 0개" 라는 제목이 되는 것이 이 요구가 고치는 것이다.
      if (/\d/.test(s!.text)) bad.push(`${m.name}: 제목에 수가 있다 — "${s!.text.trim()}"`);
      if (s!.badge === null) bad.push(`${m.name}: 개수 배지가 없다`);
      await page.keyboard.press('Escape');
      await expect(page.locator(m.box)).toBeHidden({ timeout: 5000 });
    }
    expect(bad).toEqual([]);
  });

  /**
   * **TC-CMP-17 을 걷었다** (2026-09-20). 그 검사는 *"설정 모달의 높이가 탭에
   * 따라 달라진다"* 를 단정했고, `UI_KIT_SRS` FR-UIK-12 가 그 **반대**를 요구한다
   * — *"설정 모달의 크기는 탭에 따라 달라지지 않는다"*, 2026-09-08 **사용자 접수**.
   *
   * `AUDIT-uiux.md` §4.2 가 반대를 제안했으나 감사 제안으로 사용자 접수를 뒤집을
   * 수 없다. `poll-interval.spec.ts` 의 PIS19(V-11)가 그 요구를 지키고 있었고
   * **전량 e2e 가 잡았다** — 부분 실행 49건에서는 보이지 않던 자리다.
   *
   * §4.2 가 본 진짜 불편(긴 탭에서 마지막 행이 잘린다)은 높이가 아니라 **잘린
   * 것이 안 보이는 것**이므로 TC-CMP-19(넘침 페이드)가 그 절반을 고친다.
   */

  test('TC-CMP-19: 넘치면 잘린 것이 있음을 페이드가 알린다 (FR-CMP-84)', async ({ page }) => {
    await waitForInit(page, { clearLocalStorage: true });
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });

    const read = async (tab: string, want: string) => {
      await page.click(`.mtab[data-tab="${tab}"]`);
      // 표식은 `ResizeObserver`·`MutationObserver` 가 세우므로 **비동기**다.
      // 고정 대기가 아니라 조건 폴링이고, 끝내 안 서면 진다.
      await page.waitForFunction((w) => {
        const b = document.querySelector('.modal-body') as HTMLElement;
        return (b.dataset.overflow || '') === w || ((b.dataset.overflow || '').includes(w) && w !== '');
      }, want, { timeout: 3000 }).catch(() => {});
      return page.evaluate(() => {
        const b = document.querySelector('.modal-body') as HTMLElement;
        return {
          over: b.scrollHeight > b.clientHeight + 1,
          mark: b.dataset.overflow || '',
          mask: getComputedStyle(b).maskImage || (getComputedStyle(b) as any).webkitMaskImage || 'none',
        };
      });
    };
    // 짧은 탭 — 넘치지 않으므로 **페이드가 없어야** 한다. 늘 흐리면 그것은
    // 정보가 아니라 장식이다.
    const short = await read('theme', '');
    expect(short.over, 'Theme 이 넘친다 — 검사의 전제가 깨졌다').toBe(false);
    expect(short.mark, '넘치지 않는데 표식이 섰다').toBe('');

    // 긴 탭 — 넘치므로 아래쪽이 흐려진다.
    const long = await read('shortcuts', 'bottom');
    expect(long.over, 'Shortcuts 가 넘치지 않는다 — 검사의 전제가 깨졌다').toBe(true);
    expect(long.mark, '넘치는데 표식이 서지 않았다').toContain('bottom');
    expect(long.mask, '표식은 섰는데 페이드가 그려지지 않는다').not.toBe('none');
    await page.keyboard.press('Escape');
  });
});
