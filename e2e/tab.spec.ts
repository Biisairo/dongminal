import { test, expect } from '@playwright/test';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Tab management', () => {
  test('tab can be closed via x button', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg.focused .rt').count();
    // Ensure at least 2 tabs so we can close one.
    if (before < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
        page.locator('#area .rg.focused .rt-add').click(),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#area .rg.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    }

    const countBefore = await page.locator('#area .rg.focused .rt').count();
    // Click the x on the first tab.
    await page.locator('#area .rg.focused .rt').first().locator('.rt-x').click();
    await expect(page.locator('#area .rg.focused .rt')).toHaveCount(countBefore - 1, { timeout: 10000 });
  });

  test('tab can be renamed via double-click', async ({ page }) => {
    await waitForInit(page);
    const firstTab = page.locator('#area .rg.focused .rt').first();
    await expect(firstTab).toBeVisible();

    // Double-click tab name.
    await firstTab.locator('span').first().dblclick();
    await page.waitForSelector('.rename-input', { state: 'visible', timeout: 5000 });
    const input = page.locator('.rename-input');

    await input.fill('MyTab');
    await input.press('Enter');

    // Tab name updated.
    await expect(firstTab.locator('span').first()).toHaveText('MyTab');
  });

  test('tab switch by clicking another tab', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg.focused .rt').count();
    if (before < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
        page.locator('#area .rg.focused .rt-add').click(),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#area .rg.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    }

    const first = page.locator('#area .rg.focused .rt').first();
    const second = page.locator('#area .rg.focused .rt').nth(1);

    // Click second tab.
    await second.click();
    await expect(second).toHaveClass(/active/);

    // Click first tab.
    await first.click();
    await expect(first).toHaveClass(/active/);
  });

  test('keyboard shortcut switches tabs', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg.focused .rt').count();
    if (before < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
        page.locator('#area .rg.focused .rt-add').click(),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#area .rg.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    }

    const first = page.locator('#area .rg.focused .rt').first();
    const second = page.locator('#area .rg.focused .rt').nth(1);

    await first.click();
    await expect(first).toHaveClass(/active/);

    // Use evaluate to trigger tabNext/tabPrev directly (avoids browser tab-switch conflict).
    await page.evaluate(() => (window as any).app.executeAction('tabNext'));
    await expect(second).toHaveClass(/active/);

    await page.evaluate(() => (window as any).app.executeAction('tabPrev'));
    await expect(first).toHaveClass(/active/);
  });

  test('closing last tab in a region removes the region', async ({ page }) => {
    await waitForInit(page);
    const beforeRg = await page.locator('#area .rg').count();
    if (beforeRg < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
        page.click('#split-h'),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#area .rg')).toHaveCount(beforeRg + 1, { timeout: 10000 });
    }

    const rgCountBefore = await page.locator('#area .rg').count();
    // Close all tabs in the second region (not focused) one by one.
    const secondRegion = page.locator('#area .rg').nth(1);
    let tabs = await secondRegion.locator('.rt').count();
    while (tabs > 0) {
      await secondRegion.locator('.rt').first().locator('.rt-x').click();
      await page.waitForTimeout(300);
      tabs = await secondRegion.locator('.rt').count();
    }

    // Region count should have decreased by 1.
    await expect(page.locator('#area .rg')).toHaveCount(rgCountBefore - 1, { timeout: 10000 });
  });
});
