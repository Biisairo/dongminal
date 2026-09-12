import { test, expect, waitForInit } from './fixtures';

test.describe('Theme & settings', () => {
  test('theme change updates CSS variables', async ({ page }) => {
    await waitForInit(page);

    // Open settings modal.
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();

    // Theme tab should be active by default.
    await expect(page.locator('#theme-list')).toBeVisible();

    const themeItems = page.locator('#theme-list .tl-item');
    const totalCount = await themeItems.count();
    expect(totalCount).toBeGreaterThanOrEqual(40); // 21 original + ≥12 dark + ≥10 light

    // Dark/Light section headers must both be present.
    const sections = page.locator('#theme-list .tl-section');
    await expect(sections).toHaveCount(2);
    await expect(sections.nth(0)).toHaveText('Dark');
    await expect(sections.nth(1)).toHaveText('Light');

    // Click first theme to ensure baseline (Tokyo Night).
    await themeItems.nth(0).click();
    const initialBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );

    // Click a theme that is guaranteed to have a different bg.
    await themeItems.nth(5).click(); // Solarized Dark
    const newBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );
    expect(newBg).not.toBe(initialBg);

    // Close modal.
    await page.click('#modal-close');
    await expect(page.locator('#modal-overlay')).not.toBeVisible();
  });

  test('light theme switches to a bright background', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();

    // Pick GitHub Light by name (robust to ordering changes).
    await page.locator('#theme-list .tl-item', { hasText: 'GitHub Light' }).click();
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );
    // Light themes should have high luma; check first hex digit ≥ 'c' rather than parse.
    const m = bg.match(/^#?([0-9a-f]{6})$/i);
    expect(m).not.toBeNull();
    const r = parseInt(m![1].substring(0,2), 16);
    expect(r).toBeGreaterThanOrEqual(200);
    await page.click('#modal-close');
  });

  test('settings modal tabs switch', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();

    // Shortcuts tab.
    await page.click('button.mtab[data-tab="shortcuts"]');
    await expect(page.locator('#panel-shortcuts')).toBeVisible();
    await expect(page.locator('#panel-theme')).toBeHidden();

    // Status Bar tab.
    await page.click('button.mtab[data-tab="statusbar"]');
    await expect(page.locator('#panel-statusbar')).toBeVisible();

    // Close.
    await page.click('#modal-close');
    await expect(page.locator('#modal-overlay')).not.toBeVisible();
  });
});

/**
 * DESIGN_TOKENS_SRS §5.3 TC-TOK-16 — **파생 토큰이 테마를 따라 바뀐다.**
 *
 * `check-css-vars.mjs` 로는 이것을 잡을 수 없다: 그 게이트는 "이 이름이
 * 세워지기는 하는가" 를 묻고 세우는 자리 넷 중 **하나만** 있으면 통과한다.
 * 그래서 토큰을 `:root` 에만 두고 `applyThemeObj` 에 넣는 것을 잊으면 게이트는
 * 초록인데 **54종 전부에서 기본 테마의 값이 나온다** — `UX-14` 가 보고한 결함이
 * 정확히 그 모양이다(Tokyo Night 에서만 맞는 색).
 *
 * 그러므로 재는 것은 "정의됐는가" 가 아니라 **"테마를 바꾸면 값이 바뀌는가"** 다.
 */
test.describe('디자인 토큰 — 파생이 테마를 따른다 (FR-TOK-13)', () => {
  /**
   * 원시값이 아니라 **파생**인 것만 담는다. `--bg`·`--border` 처럼 팔레트에서
   * 그대로 오는 것은 이 검사의 대상이 아니다 — 그것이 바뀌는지는 위 테스트가 본다.
   */
  /** 기준 테마. 다크이므로 아래에서 고르는 반대 모드는 라이트다. */
  const BASE = 'Tokyo Night';

  const DERIVED = [
    '--text', '--text-muted', '--text-bright', '--text-hint',
    '--accent-text', '--danger-text', '--attn-text', '--focus-ring',
    '--bg-alt', '--border-strong', '--slot-edge',
    '--accent-hover', '--accent-active', '--accent-subtle',
    '--danger-subtle', '--danger-strong',
    '--attn-subtle', '--attn-glow',
    '--term-red', '--term-green', '--term-yellow',
    '--term-blue', '--term-magenta', '--term-cyan',
  ];

  test('TC-TOK-16: 테마를 바꾸면 파생 토큰 전부가 함께 바뀐다', async ({ page }) => {
    await waitForInit(page);

    const read = (names: string[]) => page.evaluate((ns) => {
      const cs = getComputedStyle(document.documentElement);
      const out: Record<string, string> = {};
      for (const n of ns) out[n] = cs.getPropertyValue(n).trim();
      return out;
    }, names);

    /**
     * 테마 이름을 박아 두지 않는다 — 테마는 설정으로 영속하므로 앞선 스펙이 남긴
     * 것과 같은 것을 고르면 "바뀌었는지" 를 볼 수 없다 (`git-ui-metrics` 가 같은
     * 함정을 적어 뒀다). **지금과 다른 mode** 를 가진 것을 그 자리에서 고른다:
     * 다크 ↔ 라이트를 건너면 파생의 앵커가 반대쪽으로 가므로 모든 파생이 움직인다.
     *
     * `THEMES` 는 고전 스크립트의 `const` 라 window 프로퍼티가 아니다 — 문자열
     * 평가로 페이지의 전역 스코프에서 읽는다.
     */
    const apply = (expr: string) => page.evaluate<string>(expr);

    await apply("(function(){applyThemeObj(THEMES['" + BASE + "']);return ''})()");
    const before = await read(DERIVED);

    /**
     * 기준을 **명시로** 든다. 첫 판은 `getCurrentTheme()` 의 `mode` 와 비교했는데,
     * 그것이 `customTheme` 을 돌려주면 `mode` 가 `undefined` 이고 그러면 `find` 가
     * **첫 테마**(= 기준과 같은 것)를 골라 같은 테마를 다시 적용한다 — 검사는
     * "전부 그대로" 로 빨개졌고, 그것은 제품이 아니라 이 검사의 결함이었다.
     * 위에서 기준을 직접 적용했으므로 비교 대상도 그 기준에서 읽는다.
     */
    const switched = await apply(
      "(function(){" +
      "var base=THEMES['" + BASE + "'];" +
      "var n=Object.keys(THEMES).find(function(k){return THEMES[k].mode!==base.mode});" +
      "applyThemeObj(THEMES[n]);return n})()");
    expect(switched, '반대 모드의 테마를 찾지 못했다').toBeTruthy();
    const after = await read(DERIVED);

    // 먼저 **빈 값이 없어야 한다** — 빈 값은 "바뀌지 않았다" 보다 나쁘다.
    const empty = DERIVED.filter((n) => !before[n] || !after[n]);
    expect(empty, '값이 비어 있는 토큰: ' + JSON.stringify(empty)).toEqual([]);

    // 그리고 전부 달라져야 한다. 다크↔라이트를 건넜으므로 같은 값이 남았다면
    // 그 토큰은 `applyThemeObj` 를 지나지 않고 `:root` 기본값에 머문 것이다.
    const stuck = DERIVED.filter((n) => before[n] === after[n]);
    expect(stuck,
      `테마(${switched})를 건너도 값이 그대로인 토큰 — applyThemeObj 의 맵에 없다: `
      + JSON.stringify(stuck.map((n) => [n, before[n]]))).toEqual([]);

    // 테마는 설정으로 영속한다 — 뒤 스펙에 흘리지 않게 되돌린다.
    await apply("(function(){applyThemeObj(THEMES['" + BASE + "']);return ''})()");
  });
});
