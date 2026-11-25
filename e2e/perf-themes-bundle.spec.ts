import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// PERF 3.4.12.6 — 기본 두 테마만 부팅에 있고 나머지는 `themes` 묶음이다 (M3_BOOT_SCOPE §3·§6).
// 테마는 서버 설정에 남는다 — 각 시험은 끝에 기본 테마·추종 꺼짐으로 되돌린다.

const THEMES_JS = /\/b\/themes\.js(\?|$)/;
const DRACULA_BG = '#282a36';
const SOLARIZED_LIGHT_BG = '#fdf6e3';
const TOKYO_BG = '#1a1b26';

const bgOf = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
const termBg = (page: Page) => page.evaluate(() => {
  for (const p of (window as any).app.tools.values()) if (p.term) return String(p.term.options.theme.background);
  return '';
});

async function openThemeTab(page: Page) {
  if (!(await page.locator('#modal-overlay.open').count())) await page.click('#settings-btn');
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.click('.mtab[data-tab="theme"]');
}

async function saved(page: Page, act: () => Promise<unknown>) {
  const put = page.waitForResponse((r) => r.url().includes('/api/settings') && r.request().method() === 'PUT');
  await act();
  await put;
}

async function pickTheme(page: Page, name: string) {
  await openThemeTab(page);
  const item = page.locator('#theme-list .tl-item').filter({ hasText: new RegExp('^' + name + '$') });
  await saved(page, () => item.click());
}

async function follow(page: Page, on: boolean) {
  await openThemeTab(page);
  const cb = page.locator('#ds-theme-follow');
  if ((await cb.isChecked()) !== on) await saved(page, () => cb.click());
}

function countThemes(page: Page) {
  const urls: string[] = [];
  page.on('request', (r) => { if (THEMES_JS.test(r.url())) urls.push(r.url()) });
  return urls;
}

test.afterEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await follow(page, false);
  await page.evaluate(() => (window as any).app.testing.setThemeSlots({ dark: 'Tokyo Night', light: 'GitHub Light' }));
  await pickTheme(page, 'Tokyo Night');
});

test('TC-THB-1: 기본 테마로 부팅하면 themes 묶음을 받지 않고, 설정 ▸ 테마를 열면 한 번 받아 54종을 보인다', async ({ page }) => {
  const urls = countThemes(page);
  await waitForInit(page);
  expect(urls).toEqual([]);
  expect(await page.evaluate(() => Screens.ready('themes'))).toBe(false);
  await openThemeTab(page);
  await expect(page.locator('#theme-list .tl-item')).toHaveCount(54);
  expect(urls).toHaveLength(1);
});

test('TC-THB-2: 다른 테마를 저장하고 새로고침하면 묶음이 실린 뒤 그 색이고, 그동안 기본 색이 번쩍이지 않는다', async ({ page }) => {
  await waitForInit(page);
  await pickTheme(page, 'Dracula');
  expect(await bgOf(page)).toBe(DRACULA_BG);

  let release: () => void = () => {};
  const held = new Promise<void>((res) => { release = res });
  await page.route(THEMES_JS, async (r) => { await held; await r.continue() });
  const urls = countThemes(page);
  await page.reload();
  await expect.poll(() => urls.length, { timeout: 15000 }).toBe(1);
  // 묶음이 붙잡힌 동안: 부팅 화면이 남아 있고, 첫 페인트의 색은 head 가 선적용한 저장 색이다.
  await expect(page.locator('#boot')).toBeAttached();
  expect(await bgOf(page)).toBe(DRACULA_BG);
  release();
  await page.waitForSelector('#boot', { state: 'detached', timeout: 15000 });
  expect(await bgOf(page)).toBe(DRACULA_BG);
  await expect.poll(() => termBg(page)).toBe(DRACULA_BG);
  expect(await page.evaluate('currentThemeName')).toBe('Dracula');
  expect(urls).toHaveLength(1);
});

test('TC-THB-3: 시스템 추종 슬롯이 묶음의 테마면 부팅 때 싣고, 시스템 모드가 바뀌면 다른 슬롯으로 바뀐다', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await waitForInit(page);
  await follow(page, true);
  await saved(page, () => page.evaluate(() => (window as any).app.testing.setThemeSlots({ dark: 'Dracula', light: 'Solarized Light' })));

  const urls = countThemes(page);
  await page.reload();
  await page.waitForSelector('#boot', { state: 'detached', timeout: 15000 });
  expect(urls).toHaveLength(1);
  await expect.poll(() => bgOf(page)).toBe(DRACULA_BG);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => bgOf(page), { timeout: 5000 }).toBe(SOLARIZED_LIGHT_BG);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => bgOf(page), { timeout: 5000 }).toBe(DRACULA_BG);
  expect(urls).toHaveLength(1);
  expect(await bgOf(page)).not.toBe(TOKYO_BG);
});
