import { test, expect } from '@playwright/test';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Settings & configuration', () => {
  test('settings modal opens and closes', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();
    await page.click('#modal-close');
    await expect(page.locator('#modal-overlay')).not.toBeVisible();
  });

  test('shortcuts tab shows key bindings', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();

    await page.click('button.mtab[data-tab="shortcuts"]');
    await expect(page.locator('#panel-shortcuts')).toBeVisible();

    // At least one shortcut entry should exist.
    const entryCount = await page.locator('#panel-shortcuts .sc-row').count();
    expect(entryCount).toBeGreaterThan(0);

    await page.click('#modal-close');
  });

  test('statusbar tab shows options', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#modal-overlay')).toBeVisible();

    await page.click('button.mtab[data-tab="statusbar"]');
    await expect(page.locator('#panel-statusbar')).toBeVisible();

    // At least one status-bar settings row should exist.
    const sbsCount = await page.locator('#panel-statusbar .sbs-row').count();
    expect(sbsCount).toBeGreaterThan(0);

    await page.click('#modal-close');
  });

  test('theme persists after refresh', async ({ page }) => {
    await waitForInit(page);
    await page.click('#settings-btn');
    await expect(page.locator('#theme-list')).toBeVisible();

    // Click second theme.
    const themeItems = page.locator('#theme-list .tl-item');
    await themeItems.nth(1).click();

    const beforeRefresh = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );

    await page.click('#modal-close');
    await page.reload();
    await waitForInit(page);

    const afterRefresh = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );
    expect(afterRefresh).toBe(beforeRefresh);
  });
});
