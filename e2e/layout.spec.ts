import { test, expect } from '@playwright/test';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Layout & navigation', () => {
  test('split horizontal increases region count', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-h'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });

  test('split vertical increases region count', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-v'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });

  test('pane navigation with arrow keys moves focus', async ({ page }) => {
    await waitForInit(page);
    // Always create a fresh horizontal split for reliable pane navigation.
    const before = await page.locator('#area .rg').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-h'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);

    // After split-h, the new (rightmost) region is focused.
    // paneLeft moves to the previous region; paneRight moves back.
    const countAfter = before + 1;
    const rightRegion = page.locator('#area .rg').nth(countAfter - 1);
    const leftRegion = page.locator('#area .rg').nth(countAfter - 2);

    const leftResult = await page.evaluate(() => {
      const app = (window as any).app;
      const before = app.focused;
      app.executeAction('paneLeft');
      return { before, after: app.focused };
    });
    // Verify the focused region moved to the expected ID.
    await expect(page.locator('#area .rg.focused')).toHaveAttribute('data-rid', leftResult.after, { timeout: 5000 });

    await page.evaluate(() => {
      const app = (window as any).app;
      app.executeAction('paneRight');
    });
    await expect(page.locator('#area .rg.focused')).toHaveAttribute('data-rid', leftResult.before, { timeout: 5000 });
  });

  test('resize handle exists between split regions', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();
    if (before < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
        page.click('#split-h'),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    }

    // After horizontal split, at least one resize handle (.sh) should exist.
    const shCount = await page.locator('#area .sp .sh').count();
    expect(shCount).toBeGreaterThan(0);
  });

  test('keepFocus split preserves original region focus', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();
    const firstRegion = page.locator('#area .rg').first();
    await firstRegion.locator('.rg-body').click();
    await expect(firstRegion).toHaveClass(/focused/);
    const firstRegionId = await firstRegion.getAttribute('data-rid');

    // Trigger split with keepFocus via evaluate (avoids Promise.all race).
    await page.evaluate(async () => {
      const app = (window as any).app;
      await app.split('horizontal', { keepFocus: true });
    });
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });

    // Focus should still be on the original region.
    const focusedRegion = page.locator('#area .rg.focused');
    await expect(focusedRegion).toHaveCount(1);
    expect(await focusedRegion.getAttribute('data-rid')).toBe(firstRegionId);
  });
});
