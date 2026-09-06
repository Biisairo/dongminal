import { test, expect, waitForInit } from './fixtures';

/**
 * BOOT_SCREEN_SRS 검증 (V-1 ~ V-6).
 *
 * 부팅 화면은 정상 부팅에서 수백 ms 만 살아 있다 — 그 동안을 재려면 무언가를
 * 늦춰야 한다. 늦추는 대상은 `/api/settings` 다: 걷힘 조건의 한쪽(테마 결정)이
 * 그것이고, 다른 쪽(`app.init`)은 `/api/state` 로 정상 진행한다.
 */

const DEFAULT_BG = '#1a1b26'; // style.css :root 의 기본값 (FR-BTS-4, D-2)
const THEME_CACHE_KEY = 'dm.themeVars';

// `/api/settings` 를 지정한 시간만큼 늦춘다. 0 이면 응답하지 않는다(상한 검증용).
async function delaySettings(page: any, ms: number) {
  await page.route('**/api/settings', async (route: any) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    else await new Promise(() => {});
    return route.fallback();
  });
}

const bgOf = (page: any) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  );

test.describe('Boot screen', () => {
  test('V-4·V-5: 부팅 화면이 첫 화면을 덮고 준비되면 사라진다', async ({ page }) => {
    await delaySettings(page, 1500);
    await page.goto('/');

    const boot = page.locator('#boot');
    await expect(boot).toBeVisible();
    // 로고·스피너·단계 문구가 함께 있다 (FR-BTS-6·9).
    await expect(page.locator('#boot svg')).toBeVisible();
    await expect(page.locator('#boot .boot-bar i')).toBeVisible();
    await expect(page.locator('#boot .boot-name')).toHaveText('Dongminal');
    await expect(page.locator('#boot-step')).not.toBeEmpty();
    // 배경은 테마의 `--bg` 다 (FR-BTS-7).
    const painted = await page.evaluate(
      () => getComputedStyle(document.getElementById('boot')!).backgroundColor,
    );
    expect(painted).not.toBe('rgba(0, 0, 0, 0)');

    // 준비가 끝나면 DOM 에서 없어진다 (FR-BTS-12·13).
    await expect(boot).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('#area .pn.focused .xterm-helper-textarea')).toBeAttached();
  });

  test('V-1: 마지막에 쓴 테마가 첫 페인트의 색이다', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await page.locator('#theme-list .tl-item', { hasText: 'GitHub Light' }).click();
    await page.click('#modal-close');

    // 캐시에 최종 CSS 변수 맵이 남는다 (FR-BTS-1).
    const cached = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k) || 'null'),
      THEME_CACHE_KEY,
    );
    expect(cached).toBeTruthy();
    expect(cached['--bg']).toMatch(/^#[0-9a-f]{6}$/i);
    // 파생값도 함께 있다 — head 스크립트가 다시 계산하지 않는다 (D-4).
    expect(cached['--border-strong']).toBeTruthy();
    expect(cached['--attn']).toBeTruthy();
    const lightBg = cached['--bg'];

    // 설정 응답을 늦춘 채 다시 열면, 부팅 화면이 살아 있는 동안 이미 그 색이다.
    await delaySettings(page, 1500);
    await page.reload();
    await expect(page.locator('#boot')).toBeVisible();
    expect(await bgOf(page)).toBe(lightBg);

    // 원래 테마로 되돌린다 — 다음 스펙이 기본값을 전제한다.
    await expect(page.locator('#boot')).toHaveCount(0, { timeout: 20_000 });
    await page.unroute('**/api/settings');
    await page.click('#settings-btn');
    await page.locator('#theme-list .tl-item', { hasText: 'Tokyo Night' }).first().click();
    await page.click('#modal-close');
  });

  test('V-2: 캐시가 없거나 깨졌으면 기본값으로 그린다', async ({ page }) => {
    await page.context().addInitScript((k) => {
      try { localStorage.setItem(k, '{not json') } catch { /* 사생활 모드 */ }
    }, THEME_CACHE_KEY);
    await delaySettings(page, 1500);
    await page.goto('/');

    await expect(page.locator('#boot')).toBeVisible();
    expect(await bgOf(page)).toBe(DEFAULT_BG);
    await expect(page.locator('#boot')).toHaveCount(0, { timeout: 20_000 });
  });

  test('V-3: 커스텀 프로퍼티가 아닌 키는 무시한다', async ({ page }) => {
    await page.context().addInitScript((k) => {
      try {
        localStorage.setItem(k, JSON.stringify({ '--bg': '#ff0000', color: 'red' }));
      } catch { /* 사생활 모드 */ }
    }, THEME_CACHE_KEY);
    await delaySettings(page, 1500);
    await page.goto('/');

    await expect(page.locator('#boot')).toBeVisible();
    expect(await bgOf(page)).toBe('#ff0000');
    expect(await page.evaluate(() => document.documentElement.style.color)).toBe('');
    await expect(page.locator('#boot')).toHaveCount(0, { timeout: 20_000 });
  });

  test('V-6: 설정이 오지 않아도 상한에서 걷힌다', async ({ page }) => {
    await delaySettings(page, 0);
    await page.goto('/');
    await expect(page.locator('#boot')).toBeVisible();
    await expect(page.locator('#boot')).toHaveCount(0, { timeout: 20_000 });
  });
});
