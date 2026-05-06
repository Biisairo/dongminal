import { test, expect } from '@playwright/test';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Session management', () => {
  test('session can be renamed via double-click', async ({ page }) => {
    await waitForInit(page);
    const firstSession = page.locator('#sessions .si').first();
    await expect(firstSession.locator('.si-name')).toHaveText('Session');

    // Double-click session name to trigger rename.
    await firstSession.locator('.si-name').dblclick();
    await page.waitForSelector('.rename-input', { state: 'visible', timeout: 5000 });
    const input = page.locator('.rename-input');

    // Type new name and blur.
    await input.fill('RenamedSession');
    await input.press('Enter');

    // Name updated in DOM.
    await expect(firstSession.locator('.si-name')).toHaveText('RenamedSession');
  });

  test('session can be deleted via x button', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#sessions .si').count();
    if (before <= 1) {
      // Create an extra session so we can delete one.
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/panes') && r.request().method() === 'POST'),
        page.click('#add-session'),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#sessions .si')).toHaveCount(before + 1, { timeout: 10000 });
    }

    const countBeforeDelete = await page.locator('#sessions .si').count();
    const firstSession = page.locator('#sessions .si').first();
    await firstSession.locator('.si-x').click();

    // After deleting the first session, count decreases by 1.
    await expect(page.locator('#sessions .si')).toHaveCount(countBeforeDelete - 1, { timeout: 10000 });
    // At least one session remains.
    expect(await page.locator('#sessions .si').count()).toBeGreaterThanOrEqual(1);
  });

  test('session switch via sidebar click', async ({ page }) => {
    await waitForInit(page);
    // Ensure at least 2 sessions.
    const before = await page.locator('#sessions .si').count();
    if (before < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/panes') && r.request().method() === 'POST'),
        page.click('#add-session'),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#sessions .si')).toHaveCount(before + 1, { timeout: 10000 });
    }

    const first = page.locator('#sessions .si').first();
    const second = page.locator('#sessions .si').nth(1);

    // Click second session.
    await second.click();
    await expect(second).toHaveClass(/active/);

    // Click first session.
    await first.click();
    await expect(first).toHaveClass(/active/);
  });

  test('keyboard shortcut switches sessions', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#sessions .si').count();
    if (before < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/panes') && r.request().method() === 'POST'),
        page.click('#add-session'),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#sessions .si')).toHaveCount(before + 1, { timeout: 10000 });
    }

    const first = page.locator('#sessions .si').first();
    const second = page.locator('#sessions .si').nth(1);

    // Start on first.
    await first.click();
    await expect(first).toHaveClass(/active/);

    // Ctrl+Shift+BracketRight switches to next session.
    await page.keyboard.press('Control+Shift+BracketRight');
    await expect(second).toHaveClass(/active/);

    // Ctrl+Shift+BracketLeft switches back.
    await page.keyboard.press('Control+Shift+BracketLeft');
    await expect(first).toHaveClass(/active/);
  });

  test('last session deletion creates a new one automatically', async ({ page }) => {
    await waitForInit(page);
    // Ensure only one session exists by deleting extras.
    let count = await page.locator('#sessions .si').count();
    while (count > 1) {
      await page.locator('#sessions .si').first().locator('.si-x').click();
      await page.waitForTimeout(500);
      count = await page.locator('#sessions .si').count();
    }

    // Delete the last session.
    await page.locator('#sessions .si').first().locator('.si-x').click();
    // A new session should be created automatically.
    await expect(page.locator('#sessions .si')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });
});
