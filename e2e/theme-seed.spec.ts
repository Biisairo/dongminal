import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

/**
 * THEME_SEED_COLOR_SRS: 메인색 (TC-SEED-8·9·10).
 */

const cssVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const hueOf = (page: Page, hex: string) => page.evaluate((h) => (window as any).oklchOf(h).h as number, hex);
const hueGap = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);

async function openTheme(page: Page) {
  await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay.open')).toBeVisible({ timeout: 10000 });
  await page.click('.mtab[data-tab="theme"]');
  await expect(page.locator('#panel-theme')).toBeVisible();
}

test.describe('메인색', () => {
  test.afterEach(async ({ request }) => {
    const cur = await (await request.get('/api/settings')).json();
    await request.put('/api/settings', { data: { ...cur, seedColor: '', customTheme: null } });
  });

  test('TC-SEED-8: 켜고 견본을 누르면 accent·터미널 배경이 그 색상으로 돌고 저장되며, 끄면 원본이다', async ({ page, request }) => {
    await waitForInit(page);
    await page.evaluate("customTheme=null;currentThemeName='Tokyo Night';applyThemeObj(THEMES['Tokyo Night'])");
    const accent0 = await cssVar(page, '--accent');
    const vars0: Record<string, string> = await page.evaluate("themeVarsOf(THEMES['Tokyo Night'])");
    const termBg0: string = await page.evaluate('TOPTS.theme.background');
    await openTheme(page);
    const row = page.locator('#theme-seed-row');
    await expect(row).toBeVisible();
    // 메인색 행은 테마 목록보다 위다
    const rowY = (await row.boundingBox())!.y;
    expect(rowY).toBeLessThan((await page.locator('#theme-list').boundingBox())!.y);
    const sw = row.locator('.seed-swatch');
    await expect(sw).toHaveCount(8);
    await expect(sw.first()).toBeDisabled();
    await row.locator('input.ui-switch').check();
    await expect(sw.first()).toBeEnabled();
    const target = sw.nth(3); // 135°
    const want: number = Number(await target.getAttribute('data-hue'));
    await target.click();
    await expect.poll(async () => hueGap(await hueOf(page, await cssVar(page, '--accent')), want)).toBeLessThan(2);
    expect(await cssVar(page, '--accent')).not.toBe(accent0);
    expect(await page.evaluate('TOPTS.theme.background')).not.toBe(termBg0);
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).seedColor).toMatch(/^#[0-9a-f]{6}$/);
    await row.locator('input.ui-switch').uncheck();
    await expect.poll(() => cssVar(page, '--accent')).toBe(accent0);
    for (const k of ['--bg', '--text', '--accent2', '--danger']) expect(await cssVar(page, k), k).toBe(vars0[k]);
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).seedColor).toBe('');
  });

  test('TC-SEED-9: 사용자 정의 테마는 같이 돌고, 편집기는 원본 값을 보이며 안내가 선다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate("customTheme=null;currentThemeName='Tokyo Night';applyThemeObj(THEMES['Tokyo Night'])");
    await openTheme(page);
    await page.click('#custom-toggle');
    const hint = page.locator('#custom-editor .seed-hint');
    await expect(hint).toBeHidden();
    await page.locator('#theme-seed-row input.ui-switch').check();
    await page.locator('#theme-seed-row .seed-swatch').nth(0).click();
    await expect(hint).toBeVisible();
    const bgInput = page.locator('#ce-ui .ce-item').first().locator('input[type="color"]');
    const orig: string = await page.evaluate('customTheme.ui.bg');
    await expect(bgInput).toHaveValue(orig);
    await bgInput.evaluate((e: HTMLInputElement) => { e.value = '#203040'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(await page.evaluate('customTheme.ui.bg')).toBe('#203040');
    // 화면은 변환된 값이다 — 원본과 다르다
    await expect.poll(() => cssVar(page, '--bg')).not.toBe('#203040');
  });

  test('TC-SEED-10: 테마 목록의 accent 점과 미리보기가 변환 결과다', async ({ page }) => {
    await waitForInit(page);
    await openTheme(page);
    await page.locator('#theme-seed-row input.ui-switch').check();
    await page.locator('#theme-seed-row .seed-swatch').nth(0).click();
    const seed: string = await page.evaluate('seedColor');
    const want: string = await page.evaluate(`seedTheme(THEMES['Dracula'],${JSON.stringify(seed)}).ui.accent`);
    const dot = page.locator('#theme-list .tl-item').filter({ hasText: /^Dracula$/ }).locator('.tl-dots span').nth(1);
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    await expect.poll(() => dot.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(rgb(want));
    const applied: string = await page.evaluate('getAppliedTheme().ui.accent');
    expect(applied).toBe(await cssVar(page, '--accent'));
    await expect(page.locator('#theme-preview .pv-dot').first()).toHaveCSS('background-color', rgb(applied));
  });
});
