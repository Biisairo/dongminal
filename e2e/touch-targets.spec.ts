/**
 * 터치 타겟 하한 (`ACCESSIBILITY_BASELINE_SRS` FR-A11Y-27~29 / TC-A11Y-13, `UX-7`).
 *
 * **하한 44px 은 AA 요건이 아니다.** WCAG 2.1 에는 타겟 크기 SC 가 없고 44 는
 * AAA 의 2.5.5 값이다. 그럼에도 재는 것은 이 앱이 휴대폰에서 실제로 쓰이고,
 * 저장소가 이미 세 자리에서 44 를 쓰고 있었기 때문이다 (SRS §3.4a).
 *
 * ## 목록을 손으로 적지 않는다 (FR-A11Y-28 / D-A11Y-3)
 *
 * 착수 시 인계서가 적은 여섯(`.pn-tab-x`·`.sbl-x`·`.mkb-btn`·`.mtbtn`·`.ed-row`·
 * `.git-repo-xslot`)은 **표본**이었다 — 같은 화면을 파생으로 훑자 17종이 나왔다.
 * 손으로 적은 목록을 보는 검사는 손으로 적은 만큼만 본다.
 *
 * 그래서 표준 대화 요소를 DOM 에서 파생한다. `div` 로 만든 컨트롤 몇은 아직
 * `role`·`tabindex` 가 없어 파생에 잡히지 않으므로 이름으로 더한다 — `UX-4` 가
 * 그 셋에 역할을 주면 **이 목록은 지워진다**.
 */
import { Page } from '@playwright/test';

import { test, expect, waitSettled } from './fixtures';

/** iPhone 14 급. 폭이 좁을수록 하한이 아프다. */
const MOBILE = { width: 390, height: 844 };

/** FR-A11Y-27. */
const FLOOR = 44;

/**
 * 아직 역할이 없는 `div` 컨트롤. `UX-4`(목록·탭·트리 팩토리에 `role`/`tabindex`)
 * 가 끝나면 아래 표준 선택자에 저절로 잡히고 이 배열은 사라진다.
 */
const ROLELESS = ['.sbl-item', '.sbl-x', '.pn-tab', '.pn-tab-x', '.ed-row', '.git-repo-xslot'];

/** §6 E-3·E-4 — 가로가 면제되는 자리. 예외는 **표에서만** 온다 (FR-A11Y-29). */
const WIDTH_EXEMPT = ['.mkb-btn', '.pn-tab-x'];

/** §6 E-1·E-2 — 벤더 표면. 그 안의 DOM 은 벤더가 소유한다. */
const VENDOR = ['.xterm', '.monaco-editor'];

type Small = { at: string; w: number; h: number };

async function gotoMobile(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'mobile'); });
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await page.waitForSelector('body.mobile', { timeout: 10000 });
  await waitSettled(page);
}

/** 지금 보이는 대화 요소 중 하한에 못 미치는 것. */
async function tooSmall(page: Page): Promise<Small[]> {
  return page.evaluate(
    ({ FLOOR, ROLELESS, WIDTH_EXEMPT, VENDOR }) => {
      const STANDARD = [
        'button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea',
        '[role=button]', '[role=tab]', '[role=option]', '[role=menuitem]', '[role=checkbox]',
        '[tabindex]:not([tabindex="-1"])',
      ];
      const out: { at: string; w: number; h: number }[] = [];
      const seen = new Set<Element>();
      for (const el of Array.from(document.querySelectorAll([...STANDARD, ...ROLELESS].join(',')))) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (VENDOR.some((v) => el.closest(v))) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const widthExempt = WIDTH_EXEMPT.some((w) => el.matches(w));
        if (r.height >= FLOOR && (widthExempt || r.width >= FLOOR)) continue;
        const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        out.push({
          at: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`,
          w: Math.round(r.width), h: Math.round(r.height),
        });
      }
      // 같은 종류가 열아홉 번 나오는 것을 열아홉 줄로 읽지 않는다.
      const by = new Map<string, { at: string; w: number; h: number }>();
      for (const o of out) if (!by.has(o.at)) by.set(o.at, o);
      return [...by.values()].sort((a, b) => a.at.localeCompare(b.at));
    },
    { FLOOR, ROLELESS, WIDTH_EXEMPT, VENDOR },
  );
}

const report = (rows: Small[]) => rows.map((r) => `${r.at} ${r.w}×${r.h}`);

test.describe('터치 타겟 44px (FR-A11Y-27~29)', () => {
  test('TC-A11Y-13a: 첫 화면의 대화 요소가 전부 하한을 넘는다', async ({ page }) => {
    await gotoMobile(page);
    // M6 §4-A-1: 아무것도 재지 않는 검사를 만들지 않는다. 셀렉터가 헛돌면
    // 아래 단정이 빈 배열끼리 비교하면서 조용히 초록이 된다.
    const total = await page.evaluate(() => document.querySelectorAll('button,[tabindex]').length);
    expect(total).toBeGreaterThan(10);

    expect(report(await tooSmall(page))).toEqual([]);
  });

  test('TC-A11Y-13b: 설정 모달의 대화 요소가 전부 하한을 넘는다', async ({ page }) => {
    await gotoMobile(page);
    // 모바일에서 사이드바는 드로어다 (FR-SBC-20) — `#settings-btn` 은 그 안에
    // 있고 닫혀 있으면 화면 밖이다.
    await page.click('#m-drawer-toggle');
    await page.waitForSelector('#sidebar', { state: 'visible', timeout: 10000 });
    await page.click('#settings-btn');
    await page.waitForSelector('#modal-overlay:not([hidden])', { timeout: 10000 });
    await waitSettled(page);

    expect(report(await tooSmall(page))).toEqual([]);
  });
});
