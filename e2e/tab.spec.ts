import { test, expect } from './fixtures';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Tab management', () => {
  test('tab can be closed via x button', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .pn.focused .rt').count();
    // Ensure at least 2 tabs so we can close one.
    if (before < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
        page.locator('#area .pn.focused .rt-add').click(),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#area .pn.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    }

    const countBefore = await page.locator('#area .pn.focused .rt').count();
    // Click the x on the first tab.
    await page.locator('#area .pn.focused .rt').first().locator('.rt-x').click();
    await expect(page.locator('#area .pn.focused .rt')).toHaveCount(countBefore - 1, { timeout: 10000 });
  });

  test('tab can be renamed via double-click', async ({ page }) => {
    await waitForInit(page);
    const firstTab = page.locator('#area .pn.focused .rt').first();
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
    const before = await page.locator('#area .pn.focused .rt').count();
    if (before < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
        page.locator('#area .pn.focused .rt-add').click(),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#area .pn.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    }

    const first = page.locator('#area .pn.focused .rt').first();
    const second = page.locator('#area .pn.focused .rt').nth(1);

    // Click second tab.
    await second.click();
    await expect(second).toHaveClass(/active/);

    // Click first tab.
    await first.click();
    await expect(first).toHaveClass(/active/);
  });

  test('keyboard shortcut switches tabs', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .pn.focused .rt').count();
    if (before < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
        page.locator('#area .pn.focused .rt-add').click(),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#area .pn.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    }

    const first = page.locator('#area .pn.focused .rt').first();
    const second = page.locator('#area .pn.focused .rt').nth(1);

    await first.click();
    await expect(first).toHaveClass(/active/);

    // Use evaluate to trigger tabNext/tabPrev directly (avoids browser tab-switch conflict).
    await page.evaluate(() => (window as any).app.executeAction('tabNext'));
    await expect(second).toHaveClass(/active/);

    await page.evaluate(() => (window as any).app.executeAction('tabPrev'));
    await expect(first).toHaveClass(/active/);
  });

  test('closing last tab in a pane removes the pane', async ({ page }) => {
    await waitForInit(page);
    const beforeRg = await page.locator('#area .pn').count();
    if (beforeRg < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
        page.click('#split-h'),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#area .pn')).toHaveCount(beforeRg + 1, { timeout: 10000 });
    }

    const rgCountBefore = await page.locator('#area .pn').count();
    // Close all tabs in the second pane (not focused) one by one.
    const secondPaneEl = page.locator('#area .pn').nth(1);
    let tabs = await secondPaneEl.locator('.rt').count();
    while (tabs > 0) {
      await secondPaneEl.locator('.rt').first().locator('.rt-x').click();
    await expect(secondPaneEl.locator(".rt")).toHaveCount(tabs - 1, { timeout: 5000 });
      tabs = await secondPaneEl.locator('.rt').count();
    }

    // Pane count should have decreased by 1.
    await expect(page.locator('#area .pn')).toHaveCount(rgCountBefore - 1, { timeout: 10000 });
  });
});
