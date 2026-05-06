import { test, expect } from '@playwright/test';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  // Wait for init() → render() → xterm readiness inside the focused region.
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Theme & settings', () => {
  test('theme change updates CSS variables', async ({ page }) => {
    await waitForInit(page);

    // Open settings modal.
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();

    // Theme tab should be active by default.
    await expect(page.locator('#theme-list')).toBeVisible();

    const themeItems = page.locator('#theme-list .tl-item');
    await expect(themeItems).toHaveCount(21, { timeout: 5000 });

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
